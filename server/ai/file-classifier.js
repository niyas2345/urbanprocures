/**
 * Step 3A — deterministic file classification.
 * Magic bytes win over claimed MIME/extension. Fail closed on spoof/corrupt.
 */

export const CLASSIFICATION = Object.freeze({
  EXTRACT_TEXT: 'extract_text',
  EXTRACT_OFFICE: 'extract_office',
  EXTRACT_SPREADSHEET: 'extract_spreadsheet',
  EXTRACT_PRESENTATION: 'extract_presentation',
  VISION_PENDING: 'vision_pending',
  OCR_PENDING: 'ocr_pending',
  CAD_PENDING: 'cad_pending',
  ARCHIVE_HOLD: 'archive_hold',
  BLOCKED: 'blocked',
});

const ALLOWED_EXT = new Set([
  'pdf', 'doc', 'docx', 'dwg', 'dxf', 'xls', 'xlsx', 'csv',
  'png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'heic', 'heif',
  'ppt', 'pptx', 'odt', 'ods', 'txt', 'rtf', 'zip', 'rar',
]);

export function extensionOf(name = '') {
  const base = String(name).split(/[\\/]/).pop() || '';
  const parts = base.split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

export function sniffMagic(bytes) {
  const buf = toBuffer(bytes);
  if (!buf.length) return { kind: 'empty', mime: 'application/octet-stream' };
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return { kind: 'pdf', mime: 'application/pdf' };
  }
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { kind: 'png', mime: 'image/png' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { kind: 'jpeg', mime: 'image/jpeg' };
  }
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf.length > 11 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return { kind: 'webp', mime: 'image/webp' };
  }
  if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) || (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)) {
    return { kind: 'tiff', mime: 'image/tiff' };
  }
  if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) {
    return { kind: 'zip_office', mime: 'application/zip' };
  }
  if (buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21) {
    return { kind: 'rar', mime: 'application/vnd.rar' };
  }
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
    return { kind: 'ole', mime: 'application/vnd.ms-office' };
  }
  const ascii = safeAscii(buf.subarray(0, 16));
  if (ascii.startsWith('AC10') || ascii.startsWith('AC') && buf[0] === 0x41) {
    return { kind: 'dxf', mime: 'image/vnd.dxf' };
  }
  if (looksLikeUtf8Text(buf)) return { kind: 'text', mime: 'text/plain' };
  return { kind: 'unknown', mime: 'application/octet-stream' };
}

export function classifyFile({ fileName = '', mimeType = '', bytes } = {}) {
  const ext = extensionOf(fileName);
  const magic = sniffMagic(bytes);
  const claimedMime = String(mimeType || '').toLowerCase();

  if (!ext || !ALLOWED_EXT.has(ext)) {
    return blocked('unsupported_extension', { ext, magic });
  }

  if (magic.kind === 'empty') return blocked('empty_file', { ext, magic });

  if (spoofed(ext, magic, claimedMime)) {
    return blocked('spoofed_or_corrupt', { ext, magic, claimedMime });
  }

  if (ext === 'pdf' && magic.kind === 'pdf') {
    const textNative = pdfLooksTextNative(bytes);
    return {
      ok: true,
      format: 'pdf',
      route: textNative ? CLASSIFICATION.EXTRACT_TEXT : CLASSIFICATION.OCR_PENDING,
      processing_state: textNative ? 'ready_to_extract' : 'ocr_pending',
      detected_mime: magic.mime,
      text_native: textNative,
      reason: textNative ? 'pdf_text_layer' : 'pdf_no_extractable_text',
    };
  }

  if (['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'heic', 'heif'].includes(ext)) {
    return {
      ok: true,
      format: ext === 'jpg' ? 'jpeg' : ext,
      route: CLASSIFICATION.VISION_PENDING,
      processing_state: 'vision_pending',
      detected_mime: magic.mime,
      reason: 'image_requires_vision',
    };
  }

  if (ext === 'txt' || (ext === 'csv' && magic.kind === 'text')) {
    return {
      ok: true,
      format: ext,
      route: ext === 'csv' ? CLASSIFICATION.EXTRACT_SPREADSHEET : CLASSIFICATION.EXTRACT_TEXT,
      processing_state: 'ready_to_extract',
      detected_mime: 'text/plain',
      reason: 'text_native',
    };
  }

  if (ext === 'rtf') {
    return office('rtf', CLASSIFICATION.EXTRACT_OFFICE, magic);
  }

  if (ext === 'docx' || ext === 'odt') {
    return office(ext, CLASSIFICATION.EXTRACT_OFFICE, magic);
  }
  if (ext === 'doc') {
    return office('doc', CLASSIFICATION.EXTRACT_OFFICE, magic);
  }
  if (ext === 'xlsx' || ext === 'xls' || ext === 'ods' || ext === 'csv') {
    return office(ext === 'csv' ? 'csv' : ext, CLASSIFICATION.EXTRACT_SPREADSHEET, magic);
  }
  if (ext === 'pptx' || ext === 'ppt') {
    return office(ext, CLASSIFICATION.EXTRACT_PRESENTATION, magic);
  }
  if (ext === 'dwg' || ext === 'dxf') {
    return {
      ok: true,
      format: ext,
      route: CLASSIFICATION.CAD_PENDING,
      processing_state: 'cad_pending',
      detected_mime: magic.mime,
      reason: 'cad_requires_external_processor',
    };
  }
  if (ext === 'zip' || ext === 'rar') {
    return {
      ok: true,
      format: ext,
      route: CLASSIFICATION.ARCHIVE_HOLD,
      processing_state: 'archive_hold',
      detected_mime: magic.mime,
      reason: 'archive_not_auto_extracted',
    };
  }

  return blocked('unclassified', { ext, magic });
}

function office(format, route, magic) {
  return {
    ok: true,
    format,
    route,
    processing_state: 'ready_to_extract',
    detected_mime: magic.mime,
    reason: `office_${format}`,
  };
}

function blocked(reason, extra = {}) {
  return {
    ok: false,
    format: extra.ext || 'unknown',
    route: CLASSIFICATION.BLOCKED,
    processing_state: 'blocked',
    detected_mime: extra.magic?.mime || 'application/octet-stream',
    reason,
    extra,
  };
}

function spoofed(ext, magic, claimedMime) {
  const imageExt = ['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff'];
  if (ext === 'pdf' && magic.kind !== 'pdf') return true;
  if (['png'].includes(ext) && magic.kind !== 'png') return true;
  if (['jpg', 'jpeg'].includes(ext) && magic.kind !== 'jpeg') return true;
  if (ext === 'webp' && magic.kind !== 'webp') return true;
  if (['tif', 'tiff'].includes(ext) && magic.kind !== 'tiff') return true;
  if (['docx', 'xlsx', 'pptx', 'odt', 'ods', 'zip'].includes(ext) && !['zip_office', 'zip'].includes(magic.kind) && magic.kind !== 'unknown') {
    if (magic.kind === 'zip_office') return false;
    if (['pdf', 'png', 'jpeg', 'rar', 'ole'].includes(magic.kind)) return true;
  }
  if (ext === 'rar' && magic.kind !== 'rar' && magic.kind !== 'unknown') return true;
  if (['doc', 'xls', 'ppt'].includes(ext) && magic.kind === 'pdf') return true;
  if (imageExt.includes(ext) && claimedMime.startsWith('application/pdf')) return true;
  return false;
}

export function pdfLooksTextNative(bytes) {
  const buf = toBuffer(bytes);
  const sample = buf.subarray(0, Math.min(buf.length, 512 * 1024)).toString('latin1');
  if (!sample.includes('%PDF')) return false;
  const hasTextOp = /BT[\s\S]{0,400}Tj|TJ[\s\S]{0,80}ET/.test(sample) || /\(([^)]{8,})\)\s*Tj/.test(sample);
  const hasFont = /\/Font|\/Type\s*\/Font/.test(sample);
  const pageCountHint = (sample.match(/\/Type\s*\/Page[^s]/g) || []).length;
  if (hasTextOp || (hasFont && sample.includes('/ToUnicode'))) return true;
  if (pageCountHint > 0 && !hasTextOp && /\/XObject|\/Image/.test(sample)) return false;
  const printable = (sample.match(/[A-Za-z]{5,}/g) || []).length;
  return printable > 20 && hasFont;
}

function looksLikeUtf8Text(buf) {
  const sample = buf.subarray(0, Math.min(buf.length, 2048));
  let odd = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) odd += 1;
  }
  return odd / sample.length < 0.05;
}

function safeAscii(buf) {
  return Buffer.from(buf).toString('ascii');
}

function toBuffer(bytes) {
  if (!bytes) return Buffer.alloc(0);
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  if (ArrayBuffer.isView(bytes)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (typeof bytes === 'string') return Buffer.from(bytes);
  return Buffer.alloc(0);
}
