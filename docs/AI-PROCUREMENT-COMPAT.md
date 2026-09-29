# AI procurement compatibility

Legacy marketplace tables (`public.rfqs` text ids, `public.quotes`, `public.attachments`) remain the UI-facing records.

Canonical AI processing records are:

- `public.rfq_documents` — source vs sanitized roles
- `public.document_processing_jobs` — extract/sanitize/normalize/leak_check

Original bytes stay in private buckets `rfq-documents` and `quote-documents`.
The worker never returns storage paths or original files on vendor or pre-award client comparison routes.
