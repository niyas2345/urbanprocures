insert into public.terms_documents (doc_type, version, content, published_at) values
  (
    'vendor_tnc',
    '1.0',
    E'# URBAN PROCURE — VENDOR TERMS & CONDITIONS (SERVICE AGREEMENT)\n\n**Version:** 1.0 (Draft for legal review) | **Governing law:** UAE | **Jurisdiction:** Dubai\n\nThis Service Agreement ("Agreement") is made between:\n\n**First Party:** Urban Fixperts Technical Services LLC, Dubai [trade license no. ________], operating the "Urban Procure" platform ("Platform")\n**Second Party:** [Vendor legal name, trade license no., address] ("Vendor")\n\n*Note: "Urban Procure" refers to the platform brand operated by the First Party. All contractual rights and obligations rest with the First Party as named above.*\n\n---\n\n## 1. Definitions\n\n1.1 **"RFQ"** — Request for Quotation issued through the Platform.\n1.2 **"Client"** — the party issuing an RFQ through the Platform.\n1.3 **"Award"** — acceptance of a Vendor\'s quotation by a Client, whether communicated in writing on or off the Platform, including letters of award, work orders, purchase orders, or commencement of work.\n1.4 **"Service Charge"** — the fee payable by Vendor to Platform under Clause 4 and the signed Service Charge Schedule (Annex A).\n1.5 **"Actual Working Hours"** — normal daily working hours recorded in attendance/timesheet records approved by the Client. Overtime and public holiday hours are excluded.\n\n## 2. Role of the Platform\n\n2.1 The Platform is a facilitation venue connecting Clients with Vendors for RFQ processing, quotation management, and matching services.\n2.2 The Platform is **not a party** to any contract between Client and Vendor, does not guarantee payment by Clients, and is not liable for performance, quality, delay, or defects of any works or manpower supplied.\n2.3 Platform does not handle project funds. Vendor invoices the Client directly unless separately agreed in writing.\n\n## 3. Vendor Eligibility & Obligations\n\n3.1 Vendor warrants that it holds a valid UAE trade license and all classifications, approvals, and permits required for the categories it registers under (civil, MEP, HVAC, or Manpower Supply).\n3.2 Vendor shall maintain current licenses and permits for all active categories.\n3.3 Vendor shall not discriminate on the basis of race, religion, gender, or nationality.\n3.4 Vendor shall comply with all applicable UAE labor laws and safety regulations.\n\n## 4. Service Charge\n\n4.1 Vendor shall pay a service charge of AED 500 or 2.5% of total awarded contract value — whichever is higher — within 15 days of Award.\n4.2 Service charge is payable once per awarded contract.\n4.3 Vendor invoices the Client directly unless separately agreed in writing.\n\n## 5. Manpower Supply (if applicable)\n\n5.1 Hourly Service Charge, applied back-to-back on top of Vendor\'s hourly billing rate to the Client, calculated on Actual Working Hours only, for the full deployment duration.\n5.2 Vendor shall provide detailed billing records and client-approved attendance records.\n5.3 Payment: within 7 days of Vendor receiving corresponding client payment (per Agreement Clause 4.3).\n\n## 6. Negotiated Deviations\n\n> Any deviation from the standard rates in Section 1 must be recorded here and initialed by both parties.\n\n_______________________________________________\n\n---\n\n**First Party:** __________________ Date: ______\n**Second Party:** __________________ Date: ______',
    now()
  ),
  (
    'client_tnc',
    '1.0',
    E'# URBAN PROCURE — FOUNDING CLIENT PROGRAM\n### Offer Sheet (Clients never pay. Ever.)\n\n**A service operated by Urban Fixperts Technical Services LLC, Dubai**\n*Trade license no.: ________ | "Urban Procure" is the platform brand of the First Party.*\n\n---\n\n## What Urban Procure does\nPost your RFQ — civil, MEP, HVAC, or manpower supply. We invite matched, verified suppliers, collect quotations, and deliver a comparison to you within **48 hours**.\n\n## Founding Client Terms\n\n| Item | Detail |\n|---|---|\n| **Platform fee** | **AED 0 — free forever.** No posting fees, no success fees, no subscription. Ever. |\n| **White-glove service** | We draft, format, and post your RFQs for you; we chase suppliers for quotes |\n| **Quote turnaround** | Comparison sheet within 48 hours of RFQ posting (target) |\n| **Supplier quality** | Every supplier is trade-license verified before quoting |\n| **Founding status** | Permanent priority support + direct WhatsApp line to our team |\n\n## What we ask in return\n\n1. **RFQ flow:** minimum **2–4 RFQs per week** during the founding period (first 12 weeks)\n2. **Award confirmation:** a one-line confirmation from you when a work order is placed with any Platform-introduced supplier\n3. **Confidentiality:** supplier identities and quotation details received via the Platform are not shared outside your organization\n4. **Anonymized use:** RFQ requirements may be referenced anonymously (category, area, budget band) in Platform marketing\n\n## Important notices\n\n- Urban Procure is a procurement facilitation platform and is **not a party** to any contract between you and the supplier. Contracts, payments, performance, and warranties are directly between you and the supplier.\n- Supplier verification covers license validity and category at the time of onboarding; it is not a warranty of workmanship.\n\n---\n\n**Company:** ________________________________\n**Authorized by:** __________________ Date: ______\n**Contact for RFQ intake** ________________________________\n**Authorized by** __________________ Date: ______\n',
    now()
  ),
  (
    'annex_a',
    '1.0',
    E'# ANNEX A — SERVICE CHARGE SCHEDULE\n\nTo be completed and signed **per vendor** at onboarding. This Annex forms part of the Vendor Agreement.\n\n---\n\n**Vendor name:** ________________________________\n**Trade license no.:** ______________  **Expiry:** ______________\n**Registered categories:** ☐ Civil ☐ MEP ☐ HVAC ☐ Manpower Supply\n\n---\n\n## Section 1 — Works Contracts (Civil / MEP / HVAC)\n\n| Item | Terms |\n|---|---|\n| Service Charge | AED 500 or 2.5% of total awarded contract value — whichever is higher |\n| Payable | Within 15 days of Award |\n| Frequency | One-time per awarded contract |\n\n## Section 2 — Manpower Supply (if applicable)\n\nHourly Service Charge, applied back-to-back on top of Vendor\'s hourly billing rate to the Client, calculated on Actual Working Hours only, for the full deployment duration.\n\n| # | Role / Category | Vendor billing rate to Client (AED/hr) | Agreed hourly Service Charge (AED/hr) |\n|---|---|---|---|\n| 1 | e.g., Helper | | |\n| 2 | e.g., Mason / Carpenter | | |\n| 3 | e.g., Electrician / Plumber / Ductman | | |\n| 4 | e.g., Supervisor / Foreman | | |\n| 5 | | | |\n\n- New roles added during the term require a signed addendum to this Schedule.\n- Invoicing: monthly, based on Actual Working Hours per client-approved attendance records.\n- Payment: within 7 days of Vendor receiving corresponding client payment (per Agreement Clause 4.3).\n\n## Section 3 — Negotiated deviations (if any)\n\n> Any deviation from the standard rates in Section 1 must be recorded here and initialed by both parties.\n\n_______________________________________________\n\n---\n\n**First Party:** __________________ Date: ______\n**Second Party:** __________________ Date: ______',
    now()
  )
on conflict (doc_type, version) do nothing;

insert into public.terms_acceptances (id, user_id, doc_type, terms_version, accepted_at, ip_address, user_agent, method, contact_email) values
  (
    gen_random_uuid(),
    gen_random_uuid(),
    'vendor_tnc',
    '1.0',
    now(),
    NULL::inet,
    '',
    'clickwrap',
    'vendor-contact@urbanprocure.example'
  ),
  (
    gen_random_uuid(),
    gen_random_uuid(),
    'client_tnc',
    '1.0',
    now(),
    NULL::inet,
    '',
    'clickwrap',
    'client-contact@urbanprocure.example'
  ),
  (
    gen_random_uuid(),
    gen_random_uuid(),
    'annex_a',
    '1.0',
    now(),
    NULL::inet,
    '',
    'clickwrap',
    'admin@urbanprocure.example'
  );