// Urban Procures - Invoice Generation Logic

/**
 * Calculate platform fee for a general project award
 * @param {number} awardedValue - The awarded value in AED
 * @returns {number} Platform fee (2.5% or min 500 AED, whichever is higher)
 */
export function calculateGeneralFee(awardedValue) {
  const percentage = 0.025; // 2.5%
  const minimumFee = 500;
  const calculatedFee = awardedValue * percentage;
  return Math.max(calculatedFee, minimumFee);
}

/**
 * Calculate platform fee for manpower supply
 * @param {number} numberOfLabourers - Number of labourers
 * @param {number} contractDurationHours - Contract duration in hours
 * @param {number} hourlyRate - Rate per hour per labourer (default: 1 AED)
 * @returns {number} Total platform fee
 */
export function calculateManpowerFee(numberOfLabourers, contractDurationHours, hourlyRate = 1) {
  return numberOfLabourers * contractDurationHours * hourlyRate;
}

/**
 * Generate invoice number
 * @param {string} type - 'general' or 'manpower'
 * @returns {string} Invoice number
 */
export function generateInvoiceNumber(type = 'general') {
  const prefix = type === 'general' ? 'UP-G' : 'UP-M';
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${prefix}-${timestamp}-${random}`;
}

/**
 * Generate invoice HTML
 * @param {Object} invoiceData - Invoice details
 * @returns {string} HTML string for invoice
 */
export function generateInvoiceHTML(invoiceData) {
  const {
    invoiceNumber,
    invoiceDate,
    dueDate,
    vendorName,
    vendorAddress,
    vendorTradeLicense,
    vendorVat,
    projectName,
    projectCategory,
    awardedValue,
    platformFee,
    type = 'general',
    labourDetails = null
  } = invoiceData;

  const vatAmount = platformFee * 0.05; // 5% VAT
  const totalAmount = platformFee + vatAmount;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invoice ${invoiceNumber} | Urban Procures</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Manrope', -apple-system, sans-serif; background: #f5f5f5; padding: 2rem; }
    .invoice { max-width: 800px; margin: 0 auto; background: white; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); overflow: hidden; }
    .header { background: linear-gradient(135deg, #174f5d, #104652); color: white; padding: 2rem; display: flex; justify-content: space-between; align-items: flex-start; }
    .logo { font-size: 1.5rem; font-weight: 800; }
    .invoice-title { font-size: 2rem; font-weight: 800; margin-top: 0.5rem; }
    .invoice-meta { text-align: right; font-size: 0.9rem; }
    .invoice-meta strong { display: block; font-size: 1.1rem; }
    .content { padding: 2rem; }
    .section { margin-bottom: 2rem; }
    .section-title { font-size: 0.8rem; font-weight: 700; color: #666; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; }
    .details-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
    .detail-item { font-size: 0.9rem; }
    .detail-item strong { display: block; color: #333; }
    .detail-item span { color: #666; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    th { background: #f8f8f8; padding: 0.75rem 1rem; text-align: left; font-size: 0.8rem; font-weight: 700; color: #666; border-bottom: 2px solid #eee; }
    td { padding: 0.75rem 1rem; border-bottom: 1px solid #eee; font-size: 0.9rem; }
    .totals { display: flex; justify-content: flex-end; margin-top: 1.5rem; }
    .totals-table { width: 300px; }
    .totals-row { display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid #eee; }
    .totals-row.total { border-bottom: none; font-weight: 800; font-size: 1.1rem; color: #174f5d; }
    .payment-terms { background: #fff8f0; border: 1px solid #ffe0c7; border-radius: 8px; padding: 1rem; margin-top: 2rem; }
    .payment-terms h4 { font-size: 0.9rem; color: #e9581e; margin-bottom: 0.5rem; }
    .payment-terms p { font-size: 0.85rem; color: #666; margin-bottom: 0.3rem; }
    .footer { background: #f8f8f8; padding: 1.5rem 2rem; text-align: center; font-size: 0.8rem; color: #999; }
    @media print {
      body { background: white; padding: 0; }
      .invoice { box-shadow: none; }
    }
  </style>
</head>
<body>
  <div class="invoice">
    <div class="header">
      <div>
        <div class="logo">Urban Procures</div>
        <div class="invoice-title">INVOICE</div>
      </div>
      <div class="invoice-meta">
        <strong>${invoiceNumber}</strong>
        <div>Date: ${invoiceDate}</div>
        <div>Due: ${dueDate}</div>
      </div>
    </div>

    <div class="content">
      <div class="section">
        <div class="section-title">From</div>
        <div class="details-grid">
          <div class="detail-item">
            <strong>Urban Procures</strong>
            <span>Dubai, UAE</span><br>
            <span>Platform Fee Invoice</span>
          </div>
          <div class="detail-item">
            <strong>To</strong>
            <span>${vendorName}</span><br>
            <span>${vendorAddress || ''}</span><br>
            <span>Trade License: ${vendorTradeLicense || 'N/A'}</span><br>
            <span>VAT: ${vendorVat || 'N/A'}</span>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Project Details</div>
        <div class="details-grid">
          <div class="detail-item">
            <strong>${projectName}</strong>
            <span>Category: ${projectCategory}</span>
          </div>
          <div class="detail-item">
            <strong>Awarded Value</strong>
            <span>AED ${awardedValue.toLocaleString()}</span>
          </div>
        </div>
      </div>

      <div class="section">
        <table>
          <thead>
            <tr>
              <th>Description</th>
              <th>Calculation</th>
              <th style="text-align:right">Amount (AED)</th>
            </tr>
          </thead>
          <tbody>
            ${type === 'general' ? `
            <tr>
              <td>Platform Fee (2.5% of awarded value or min AED 500)</td>
              <td>${awardedValue} × 2.5% = AED ${(awardedValue * 0.025).toLocaleString()}${awardedValue * 0.025 < 500 ? ' (min AED 500 applied)' : ''}</td>
              <td style="text-align:right">${platformFee.toLocaleString()}</td>
            </tr>
            ` : `
            <tr>
              <td>Manpower Platform Fee</td>
              <td>${labourDetails?.labourers || 0} labourers × ${labourDetails?.hours || 0} hrs × AED 1/hr</td>
              <td style="text-align:right">${platformFee.toLocaleString()}</td>
            </tr>
            `}
            <tr>
              <td>VAT (5%)</td>
              <td>${platformFee.toLocaleString()} × 5%</td>
              <td style="text-align:right">${vatAmount.toLocaleString()}</td>
            </tr>
          </tbody>
        </table>

        <div class="totals">
          <div class="totals-table">
            <div class="totals-row">
              <span>Subtotal</span>
              <span>AED ${platformFee.toLocaleString()}</span>
            </div>
            <div class="totals-row">
              <span>VAT (5%)</span>
              <span>AED ${vatAmount.toLocaleString()}</span>
            </div>
            <div class="totals-row total">
              <span>Total Due</span>
              <span>AED ${totalAmount.toLocaleString()}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="payment-terms">
        <h4>Payment Terms</h4>
        ${type === 'general' ? `
        <p><strong>Due Date:</strong> Payment must be received within 7 working days of the award date.</p>
        <p><strong>Payment Method:</strong> Bank transfer to Urban Procures account (details will be provided).</p>
        <p><strong>Late Payment:</strong> Account will be suspended until payment is received.</p>
        ` : `
        <p><strong>Payment Method:</strong> PDC cheque dated same as client payment date.</p>
        <p><strong>Cheque Delivery:</strong> Must be delivered to Urban Procures office before award execution.</p>
        <p><strong>Late Payment:</strong> Account will be suspended until PDC is provided.</p>
        `}
      </div>
    </div>

    <div class="footer">
      <p>Urban Procures | Construction RFQ & Vendor Sourcing Platform UAE</p>
      <p>This is a computer-generated invoice. For queries, contact admin@urbanprocures.com or WhatsApp +971 50 733 5567</p>
    </div>
  </div>
</body>
</html>
  `;
}

/**
 * Create invoice record in database
 * @param {Object} supabase - Supabase client
 * @param {Object} invoiceData - Invoice details
 * @returns {Object} Created invoice record
 */
export async function createInvoice(supabase, invoiceData) {
  const { awardId, vendorId, amount, type = 'general' } = invoiceData;
  
  const invoiceNumber = generateInvoiceNumber(type);
  const taxAmount = amount * 0.05;
  const totalAmount = amount + taxAmount;
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 7); // 7 working days

  const { data, error } = await supabase
    .from('invoices')
    .insert({
      award_id: awardId,
      vendor_id: vendorId,
      invoice_number: invoiceNumber,
      amount: amount,
      tax_amount: taxAmount,
      total_amount: totalAmount,
      status: 'pending',
      due_date: dueDate.toISOString().split('T')[0]
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Mark invoice as paid
 * @param {Object} supabase - Supabase client
 * @param {string} invoiceId - Invoice ID
 * @returns {Object} Updated invoice record
 */
export async function markInvoicePaid(supabase, invoiceId) {
  const { data, error } = await supabase
    .from('invoices')
    .update({
      status: 'paid',
      paid_at: new Date().toISOString()
    })
    .eq('id', invoiceId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Get overdue invoices
 * @param {Object} supabase - Supabase client
 * @returns {Array} List of overdue invoices
 */
export async function getOverdueInvoices(supabase) {
  const { data, error } = await supabase
    .from('invoices')
    .select(`
      *,
      profiles:vendor_id (company_name, email, phone)
    `)
    .eq('status', 'pending')
    .lt('due_date', new Date().toISOString().split('T')[0]);

  if (error) throw error;
  return data;
}
