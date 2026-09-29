# Urban Procure AI Procurement Requirements

## Locked product requirements

- Preserve the existing Urban Procure theme, colors, typography, layout and visual language.
- RFQ submission has exactly two modes: `ready_to_quote` (I Know My Requirements) and `technical_assistance` (Technical Assistance Required — Free).
- Technical assistance is an internal workflow; it is not a public site-visit RFQ mode.
- Original client documents are private. Vendor-facing documents must be regenerated/sanitized Urban Procure documents, never direct copies of originals.
- Vendor quotations are processed in the reverse direction: original vendor quotation remains private and a normalized client-facing quotation is generated.
- Identity protection is enforced server-side, not by frontend hiding.
- AI must extract and normalize construction information faithfully; it must not silently alter quantities, specifications or commercial values.
- Ambiguous or failed document sanitization must block publication and require human review.
- Service fee for applicable construction-related works: higher of AED 500 or 2.5% of total LPO / Purchase Order / Work Order value, plus VAT where legally applicable.
- Where the order is paid in instalments, the full service fee calculated on the total order value becomes payable at the first payment stage unless otherwise expressly agreed in writing.
- Service-fee invoicing entity: URBAN FIXPERTS TECHNICAL SERVICES L.L.C.

## Implementation sequence

1. Connect RFQ UI to canonical RFQ model.
2. Implement secure document ingestion and storage.
3. Implement identity detection and vendor-safe document generation.
4. Implement normalized vendor quotation processing.
5. Enforce server-side party access controls and audit events.
6. Implement LPO/Work Order fee calculation and invoicing state.
7. Add automated security and data-integrity tests.
8. Connect production AI provider and document/OCR processing.
9. Build WebMCP/ChatGPT access against the same RFQ API.
