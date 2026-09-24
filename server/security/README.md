# Marketplace security boundary

All client/vendor visibility decisions must be enforced by the server/API and database policies. Frontend masking is presentation only.

## Required states

- `draft`: internal to RFQ owner/admin.
- `published`: vendor-safe RFQ may be exposed to invited/eligible vendors.
- `quotation`: client receives normalized quotations without premature vendor identity disclosure.
- `award`: selected parties may be disclosed according to the award workflow.
- `closed`: no further external disclosure.

## Document rule

`original` documents are private. Only a distinct `sanitized` document may be attached to an external RFQ/quotation. Any sanitization finding or uncertainty blocks publication and requires review.

## Identity rule

Client and vendor identities must be represented internally by stable IDs. Human-readable identity/contact data must not be included in vendor-safe or client-safe payloads before the permitted disclosure stage.
