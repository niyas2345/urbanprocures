# Urban Procure AI Procurement Architecture

## Non-negotiable product rules

1. Preserve the existing Urban Procure visual design, colours, typography and interaction language.
2. Support exactly two client RFQ modes:
   - `I Know My Requirements` (`ready_to_quote`)
   - `Technical Assistance Required (Free)` (`technical_assistance`)
3. A site visit is an internal Urban Procure process, not a public RFQ mode.
4. Client and vendor direct identities remain protected through the pre-award workflow.
5. Original uploaded client documents must never be delivered to vendors.
6. Original vendor quotation documents must never be delivered to clients as the normalized comparison artifact.
7. AI extracts and structures information; it must not silently invent, remove or materially alter technical requirements.
8. Any uncertain identity/privacy transformation must be blocked for human review.
9. Server-side authorization, not frontend masking, is the security boundary.
10. The original document is retained internally and a separate audience-safe derivative is generated for external delivery.

## RFQ flow

Client submission -> intake -> document extraction -> identity detection -> validation -> normalized Urban Procure RFQ -> vendor distribution.

For technical assistance, Urban Procure handles the technical assessment/site visit internally and then creates the procurement-ready RFQ.

## Quotation flow

Vendor submission -> extraction -> normalization -> identity/leak scan -> normalized quotation -> client comparison.

## Document boundary

Every document has an audience (`internal`, `client`, `vendor`). The external audience must receive a derivative with `is_original=false`. Original files are never exposed by the marketplace API.

## Commercial trigger

For applicable construction-related work, the current commercial rule is the greater of AED 500 or 2.5% of the total LPO/Purchase Order/Work Order value. Where the order is paid in stages, the full service fee is due at the vendor's first payment stage unless otherwise expressly agreed in writing. VAT is added where legally applicable.

## Implementation sequence

1. Database and authorization model.
2. Secure document storage and metadata.
3. RFQ intake/normalization API.
4. Identity/leak detection and human review queue.
5. Vendor-safe RFQ rendering.
6. Vendor quotation normalization.
7. Client comparison.
8. LPO/work-order fee engine.
9. UI integration without changing the existing visual system.
10. Automated tests and production preview.
