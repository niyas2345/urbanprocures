import { classifyFile } from "../ai/file-classifier.js";

const BUCKET = "rfq-documents";
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_FILES = 10;
const ALLOWED_EXTENSIONS = new Set([
  "pdf", "doc", "docx", "dwg", "dxf", "xls", "xlsx", "csv",
  "png", "jpg", "jpeg", "webp", "tif", "tiff", "heic", "heif",
  "ppt", "pptx", "odt", "ods", "txt", "rtf", "zip", "rar"
]);
const ALLOWED_MIME_PREFIXES = ["image/"];
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "application/csv",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "text/plain",
  "application/rtf",
  "text/rtf",
  "application/zip",
  "application/x-zip-compressed",
  "application/x-rar-compressed",
  "application/octet-stream"
]);

export { ALLOWED_EXTENSIONS, MAX_FILE_SIZE, BUCKET };

export async function uploadRFQDocuments(request, env) {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  if (!env.SUPABASE_URL || !(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY)) {
    return json({ ok: false, error: "Supabase env vars missing" }, 503);
  }

  const form = await request.formData();
  const suppliedUserId = String(form.get("user_id") || "").trim();
  const rfqId = String(form.get("rfq_id") || "").trim();
  const files = form.getAll("files").filter((value) => value && typeof value.arrayBuffer === "function");
  const rfqPayload = readFormJson(form.get("rfq"));

  const identity = await resolveIdentity(request, env, suppliedUserId);
  if (!identity.ok) return json({ ok: false, error: identity.error }, identity.status);
  const userId = identity.userId;
  if (!rfqId) return json({ ok: false, error: "rfq_id is required" }, 400);
  if (files.length > MAX_FILES) return json({ ok: false, error: `Maximum ${MAX_FILES} files per RFQ` }, 400);

  const uploadedPaths = [];
  const insertedAttachments = [];
  const insertedDocuments = [];

  try {
    await assertRfqAccess(env, { rfqId, userId, rfqPayload });

    for (const file of files) {
      const validation = validateFile(file);
      const path = `${userId}/${rfqId}/${crypto.randomUUID()}-${validation.safeName}`;
      const bytes = await file.arrayBuffer();
      const rawClassification = classifyFile({ fileName: file.name, mimeType: file.type, bytes });
      const classification = normalizeClassification(rawClassification);

      await putPrivateObject(env, BUCKET, path, bytes, file.type || "application/octet-stream");
      uploadedPaths.push(path);

      const attachment = await insertAttachment(env, {
        rfqId,
        userId,
        file,
        path,
        safeName: validation.safeName,
        extension: validation.extension,
        classification
      });
      insertedAttachments.push(attachment);

      const document = await insertRfqDocument(env, {
        rfqId,
        file,
        path,
        classification
      });
      insertedDocuments.push(document);
      if (classification.is_supported) {
        await insertProcessingJob(env, { rfqId, documentId: document.id, classification });
      }
    }

    await supabaseFetch(env, `/rest/v1/rfqs?id=eq.${encodeURIComponent(rfqId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ file_count: insertedDocuments.length, review_state: "awaiting_processing", processing_status: "pending" })
    });

    return json({
      ok: true,
      bucket: BUCKET,
      attachments: insertedAttachments.map(toSafeAttachment),
      documents: insertedDocuments.map(toSafeDocument)
    });
  } catch (error) {
    await cleanupObjects(env, uploadedPaths);
    return json({ ok: false, error: error?.message || "Upload failed" }, 400);
  }
}

async function resolveIdentity(request, env, suppliedUserId) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (env.PROCUREMENT_TEST_AUTH === '1' && suppliedUserId && !token) return { ok: true, userId: suppliedUserId, test: true };
  if (!token) return { ok: false, status: 401, error: 'Authentication required' };
  const response = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: env.SUPABASE_ANON_KEY || env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` } });
  if (!response.ok) return { ok: false, status: 401, error: 'Invalid session' };
  const user = await response.json();
  if (!user?.id) return { ok: false, status: 401, error: 'Invalid session' };
  const role = user?.app_metadata?.role;
  if (!['client', 'admin'].includes(role)) return { ok: false, status: 403, error: 'Client access required' };
  if (suppliedUserId && String(user.id) !== suppliedUserId) return { ok: false, status: 403, error: 'Supplied user identity does not match session' };
  return { ok: true, userId: user.id };
}

export function validateFile(file) {
  const originalName = String(file?.name || "").trim();
  if (!originalName) throw new Error("Filename is required");
  if (originalName.length > 180) throw new Error(`${originalName.slice(0, 80)}: filename is too long`);
  if (/[\\/:*?"<>|\u0000-\u001F]/u.test(originalName)) throw new Error(`${originalName}: filename contains unsupported characters`);

  const extension = originalName.includes(".") ? originalName.split(".").pop().toLowerCase() : "";
  if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error(`${originalName}: unsupported file format`);
  if (!file.size || file.size < 1) throw new Error(`${originalName}: file is empty`);
  if (file.size > MAX_FILE_SIZE) throw new Error(`${originalName}: file exceeds 25 MB limit`);

  const mimeType = String(file.type || "application/octet-stream").toLowerCase();
  const allowedMime = ALLOWED_MIME_TYPES.has(mimeType) || ALLOWED_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix));
  if (!allowedMime) throw new Error(`${originalName}: MIME type ${mimeType} is not supported`);

  return { extension, safeName: sanitizeFilename(originalName) };
}

function normalizeClassification(result) {
  return {
    ...result,
    is_supported: Boolean(result?.ok),
    detected_format: result?.format || "unknown",
    processing_route: result?.route || "blocked",
    classification: result?.format || "unknown",
    rejection_reason: result?.ok ? null : (result?.reason || "blocked")
  };
}

async function assertRfqAccess(env, { rfqId, userId, rfqPayload }) {
  const rows = await supabaseFetch(env, `/rest/v1/rfqs?id=eq.${encodeURIComponent(rfqId)}&select=*`);
  const existing = rows[0];

  if (!existing) {
    if (!rfqPayload) throw new Error("RFQ does not exist");
    await createRfq(env, { rfqId, userId, rfqPayload });
    return true;
  }

  const owner = existing.client_id || existing.client_user_id || existing.created_by || existing.user_id;
  if (owner && String(owner) !== userId) throw new Error("RFQ upload is not permitted for this user");
  return true;
}

async function createRfq(env, { rfqId, userId, rfqPayload }) {
  const row = {
    id: rfqId,
    client_id: userId,
    title: String(rfqPayload.title || "Untitled RFQ"),
    category: String(rfqPayload.category || "General"),
    project: String(rfqPayload.project || ""),
    subcategory: String(rfqPayload.subcategory || rfqPayload.sub || ""),
    emirate: String(rfqPayload.emirate || "Dubai"),
    location: String(rfqPayload.location || ""),
    scope: String(rfqPayload.scope || ""),
    budget: Number(rfqPayload.budget || 0),
    start_date: rfqPayload.start_date || rfqPayload.start || null,
    duration: String(rfqPayload.duration || ""),
    deadline: rfqPayload.deadline || null,
    visit: String(rfqPayload.visit || "TBD"),
    special_requirements: String(rfqPayload.special_requirements || rfqPayload.special || ""),
    status: "Submitted",
    review_state: "awaiting_processing",
    file_count: 0,
    source: "web"
  };

  try {
    await supabaseFetch(env, "/rest/v1/rfqs", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(row)
    });
  } catch (error) {
    throw new Error(`Unable to create RFQ record: ${error.message}`);
  }
}

async function insertAttachment(env, { rfqId, userId, file, path, safeName, extension, classification }) {
  const row = {
    id: crypto.randomUUID(), owner_type: "rfq", owner_id: rfqId, rfq_id: rfqId, created_by: userId,
    name: file.name, file_name: file.name, filename: file.name, sanitized_filename: safeName,
    ext: extension, mime: file.type || "application/octet-stream", mime_type: file.type || "application/octet-stream",
    size_bytes: file.size, file_size: file.size, storage_bucket: BUCKET, storage_path: path,
    ai_status: classification.is_supported ? "queued" : "rejected",
    ai_detected_format: classification.detected_format,
    ai_rejection_reason: classification.rejection_reason,
    processing_status: classification.is_supported ? "pending" : "blocked",
    classification, detected_format: classification.detected_format,
    processing_route: classification.processing_route, rejection_reason: classification.rejection_reason
  };
  return insertFirstCompatible(env, "attachments", [
    row,
    pick(row, ["id", "owner_type", "owner_id", "name", "ext", "mime", "size_bytes", "storage_bucket", "storage_path", "created_by"]),
    pick(row, ["rfq_id", "created_by", "file_name", "filename", "mime_type", "file_size", "storage_bucket", "storage_path", "ai_status"])
  ]);
}

async function insertRfqDocument(env, { rfqId, file, path, classification }) {
  const row = {
    rfq_id: rfqId, storage_key: path, storage_bucket: BUCKET, storage_path: path,
    document_role: "source", original_filename: file.name,
    mime_type: file.type || "application/octet-stream", file_size: file.size,
    detected_format: classification.detected_format, classification: classification.classification,
    processing_route: classification.processing_route, classification_result: classification,
    rejection_reason: classification.rejection_reason,
    processing_status: classification.is_supported ? "pending" : "blocked",
    requires_human_review: !classification.is_supported
  };
  return insertFirstCompatible(env, "rfq_documents", [
    row,
    pick(row, ["rfq_id", "storage_key", "document_role", "original_filename", "mime_type", "processing_status", "requires_human_review"])
  ]);
}

async function insertProcessingJob(env, { rfqId, documentId, classification }) {
  return insertFirstCompatible(env, "document_processing_jobs", [{
    rfq_id: rfqId, document_id: documentId, job_type: "extract",
    status: "pending", result: { stage: "classification_complete", classification }, error_message: null
  }]);
}

async function insertFirstCompatible(env, table, rows) {
  let lastError;
  for (const row of rows) {
    try {
      const inserted = await supabaseFetch(env, `/rest/v1/${table}`, {
        method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row)
      });
      return inserted[0] || row;
    } catch (error) {
      lastError = error;
      if (!isSchemaCompatibilityError(error)) break;
    }
  }
  throw lastError;
}

async function cleanupObjects(env, paths) {
  await Promise.all([...new Set(paths)].map((path) => removeObject(env, path).catch(() => null)));
}

async function removeObject(env, path) {
  await deletePrivateObject(env, BUCKET, path);
}

async function putPrivateObject(env, bucket, path, bytes, contentType) {
  const r2 = bucket === BUCKET ? env.URBAN_PROCURE_RFQ_DOCUMENTS : null;
  if (r2) {
    await assertStorageCapacity(r2, bytes.byteLength);
    await r2.put(path, bytes, { httpMetadata: { contentType } });
    return;
  }
  await storageFetch(env, `/storage/v1/object/${bucket}/${encodePath(path)}`, {
    method: "POST",
    headers: { "Content-Type": contentType, "x-upsert": "false" },
    body: bytes
  });
}

async function deletePrivateObject(env, bucket, path) {
  const r2 = bucket === BUCKET ? env.URBAN_PROCURE_RFQ_DOCUMENTS : null;
  if (r2) {
    await r2.delete(path);
    return;
  }
  await storageFetch(env, `/storage/v1/object/${bucket}/${encodePath(path)}`, { method: "DELETE" });
}

async function assertStorageCapacity(bucket, incomingBytes) {
  const hardLimit = 6 * 1024 * 1024 * 1024;
  let total = incomingBytes;
  let cursor;
  do {
    const page = await bucket.list({ limit: 1000, cursor });
    total += page.objects.reduce((sum, object) => sum + (object.size || 0), 0);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (total > hardLimit) throw new Error("Document storage capacity reached; owner review required");
}

async function storageFetch(env, path, init = {}) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;
  const response = await fetch(`${env.SUPABASE_URL}${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, ...(init.headers || {}) }
  });
  const text = await response.text();
  if (!response.ok) {
    const data = safeJson(text);
    throw new Error(data?.message || data?.error || text || `Storage request failed (${response.status})`);
  }
  return text ? safeJson(text) : null;
}

async function supabaseFetch(env, path, init = {}) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;
  const response = await fetch(`${env.SUPABASE_URL}${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers || {}) }
  });
  const text = await response.text();
  const data = text ? safeJson(text) : null;
  if (!response.ok) throw new Error(data?.message || data?.error || text || `Supabase request failed (${response.status})`);
  return data || [];
}

function sanitizeFilename(name) {
  const clean = name.normalize("NFKD").replace(/[^\w.-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return clean.slice(0, 140) || "document";
}

function toSafeAttachment(row) {
  return {
    id: row.id || "", name: row.name || row.file_name || row.filename || "",
    type: row.mime || row.mime_type || "", size: row.size_bytes || row.file_size || 0,
    status: row.ai_status || row.processing_status || "pending"
  };
}

function toSafeDocument(row) {
  return {
    id: row.id || "", rfq_id: row.rfq_id || "", original_filename: row.original_filename || "",
    mime_type: row.mime_type || "", file_size: row.file_size || 0,
    detected_format: row.detected_format || "", classification: row.classification || "",
    processing_route: row.processing_route || "", processing_status: row.processing_status || "pending",
    rejection_reason: row.rejection_reason || ""
  };
}

function pick(source, keys) {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}
function readFormJson(value) {
  if (!value) return null;
  try { return JSON.parse(String(value)); } catch { throw new Error("RFQ metadata is invalid"); }
}
function isSchemaCompatibilityError(error) {
  return /column .* does not exist|Could not find the .* column|schema cache|violates foreign key constraint|invalid input syntax for type uuid/i.test(error?.message || "");
}
function encodePath(path) { return path.split("/").map(encodeURIComponent).join("/"); }
function safeJson(text) { try { return JSON.parse(text); } catch { return { message: text }; } }
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}
