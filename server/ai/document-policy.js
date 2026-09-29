// Urban Procure document-boundary policy.
// This module is deliberately provider-agnostic: AI extraction is allowed only
// to produce structured data and a vendor/client-safe derivative. Original
// documents must never be returned across the marketplace boundary.

export const DOCUMENT_AUDIENCES = Object.freeze({
  INTERNAL: "internal",
  CLIENT: "client",
  VENDOR: "vendor"
});

export const RFQ_MODES = Object.freeze({
  READY_TO_QUOTE: "ready_to_quote",
  TECHNICAL_ASSISTANCE: "technical_assistance"
});

export const PROTECTED_FIELDS = Object.freeze([
  "company_name",
  "legal_name",
  "trade_license_number",
  "logo",
  "email",
  "phone",
  "mobile",
  "website",
  "address",
  "contact_person",
  "project_client_name",
  "document_metadata",
  "qr_code"
]);

export function assertOutboundDocument(document, audience) {
  if (!document || typeof document !== "object") {
    throw new Error("Document payload is required");
  }

  if (!Object.values(DOCUMENT_AUDIENCES).includes(audience)) {
    throw new Error("Invalid document audience");
  }

  if (audience !== DOCUMENT_AUDIENCES.INTERNAL && document.is_original === true) {
    throw new Error("Original documents cannot cross a marketplace boundary");
  }

  if (audience === DOCUMENT_AUDIENCES.VENDOR && document.source === "client_original") {
    throw new Error("Client original document cannot be exposed to vendors");
  }

  if (audience === DOCUMENT_AUDIENCES.CLIENT && document.source === "vendor_original") {
    throw new Error("Vendor original document cannot be exposed to clients");
  }

  return true;
}

export function buildSanitizedDocumentMetadata({ sourceId, audience, outputPath, checksum }) {
  if (!sourceId || !outputPath) throw new Error("sourceId and outputPath are required");
  return {
    source_id: sourceId,
    audience,
    is_original: false,
    generated_by: "urban-procure-document-firewall",
    output_path: outputPath,
    checksum: checksum || null,
    protected_fields_removed: [...PROTECTED_FIELDS]
  };
}
