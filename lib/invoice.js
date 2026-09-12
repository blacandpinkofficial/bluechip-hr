// lib/invoice.js — turning a placement into a document somebody pays.
//
// EVERYTHING HERE IS IN PAISE. Every variable and field name says so.
//
// The rest of this app keeps money in whole rupees, which is correct for fees
// and salaries — nobody pays a recruiter ₹26,000.47. It is not correct for a
// tax invoice. 18% of ₹2,34,912 is ₹42,284.16. Drop those sixteen paise and the
// GST on the invoice no longer reconciles with the GST in the return filed
// against it, and that discrepancy is found by someone whose job is finding it.
//
// So: paise throughout, one rounding at the very end, and that rounding written
// down as a round-off line — which is exactly what a printed Indian tax invoice
// does, and why every one you have ever seen has that line.

export const RUPEE = 100; // paise

export function rupeesToPaise(rupees) {
  return Math.round(Number(rupees || 0) * RUPEE);
}

/** Paise as a rupee string: 4228416 → "42,284.16". */
export function paiseToString(paise) {
  const n = Math.round(Number(paise || 0));
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.floor(abs / RUPEE);
  const frac = String(abs % RUPEE).padStart(2, "0");
  return `${neg ? "-" : ""}${whole.toLocaleString("en-IN")}.${frac}`;
}

/**
 * Which tax applies.
 *
 * Same state as the company → CGST + SGST. Anywhere else → IGST. This is place
 * of supply, and it is not a preference: charging IGST on an intra-state supply
 * (or the reverse) means the client cannot claim the credit and you have filed
 * the wrong return. Compared on the numeric state CODE, because "Tamil Nadu",
 * "TAMILNADU" and "TN" are all things people type.
 */
export function taxKind(companyStateCode, clientStateCode) {
  const a = String(companyStateCode || "").replace(/\D/g, "");
  const b = String(clientStateCode || "").replace(/\D/g, "");
  if (!a || !b) return "unknown";
  return a === b ? "intra" : "inter";
}

/** State code out of a GSTIN — the first two digits. "33AIXPR…" → "33". */
export function stateCodeFromGstin(gstin) {
  const m = String(gstin || "").trim().match(/^(\d{2})/);
  return m ? m[1] : null;
}

/**
 * A GSTIN's shape. Not a claim that it is registered — only the government can
 * say that — but it catches the transposed digit and the missing character,
 * which is most of what goes wrong when someone copies one off an email.
 */
export function looksLikeGstin(gstin) {
  const g = String(gstin || "").trim().toUpperCase();
  return /^\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z][0-9A-Z]$/.test(g);
}

/**
 * The totals.
 *
 * linesPaise — the line amounts, in paise.
 * gstBps     — 1800 for 18%.
 * kind       — "intra" | "inter" | "none" (unregistered / exempt)
 *
 * CGST and SGST are NOT each computed as half and rounded separately. Half of
 * an odd number of paise rounds twice and the two halves can add up to one
 * paisa more or less than the GST actually charged, which makes the invoice
 * fail its own arithmetic. So the total tax is computed once, CGST takes the
 * floor of half, and SGST takes the remainder. They then always sum exactly.
 */
export function computeInvoice({ linesPaise = [], gstBps = 1800, kind = "intra" } = {}) {
  const subtotalPaise = linesPaise.reduce((s, p) => s + Math.round(Number(p) || 0), 0);

  const bps = kind === "none" ? 0 : Math.max(0, Math.round(Number(gstBps) || 0));
  const taxPaise = Math.round((subtotalPaise * bps) / 10000);

  let cgstPaise = 0;
  let sgstPaise = 0;
  let igstPaise = 0;
  if (kind === "intra") {
    cgstPaise = Math.floor(taxPaise / 2);
    sgstPaise = taxPaise - cgstPaise; // takes the odd paisa, so the halves sum exactly
  } else if (kind === "inter") {
    igstPaise = taxPaise;
  }

  const grossPaise = subtotalPaise + cgstPaise + sgstPaise + igstPaise;
  // Indian invoices are settled in whole rupees. Round once, here, and record it.
  const totalPaise = Math.round(grossPaise / RUPEE) * RUPEE;
  const roundOffPaise = totalPaise - grossPaise;

  return {
    subtotalPaise,
    gstBps: bps,
    cgstPaise,
    sgstPaise,
    igstPaise,
    taxPaise,
    grossPaise,
    roundOffPaise,
    totalPaise,
    kind,
  };
}

/**
 * The financial year a date falls in, Indian style: 1 April to 31 March.
 * 12 Sep 2026 → "2026-27". 12 Feb 2027 → also "2026-27".
 *
 * This matters because invoice numbers restart each financial year, and a
 * series that restarts on 1 January instead is a series that has to be
 * explained to an auditor.
 */
export function financialYear(date = new Date()) {
  const d = new Date(date);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0 = January
  const start = m >= 3 ? y : y - 1; // April is month 3
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** "BCH/2026-27/001" */
export function invoiceNumber(prefix, fy, seq) {
  const p = String(prefix || "INV").trim().toUpperCase().replace(/[^A-Z0-9]/g, "") || "INV";
  return `${p}/${fy}/${String(seq).padStart(3, "0")}`;
}

/**
 * The sequence number out of an invoice number, or 0.
 * Used to find the next number in a series; anything unparseable counts as 0
 * rather than throwing, so one hand-edited number cannot stop invoicing.
 */
export function sequenceOf(number) {
  const m = String(number || "").match(/\/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

/** issuedOn + credit period, as a date. */
export function dueDate(issuedOn, paymentDays = 30) {
  const d = new Date(issuedOn);
  d.setUTCDate(d.getUTCDate() + Math.max(0, Math.round(Number(paymentDays) || 0)));
  return d;
}

/**
 * How late, and how much.
 *
 * Buckets are the standard ones a collections conversation uses: not due yet,
 * 0–30 days late, 31–60, 61–90, over 90. Over 90 is where an agency stops
 * calling it a late payment and starts calling it a bad debt.
 *
 * `outstandingPaise` is total minus what has been paid, so a part payment
 * reduces the exposure instead of leaving the whole invoice looking unpaid.
 */
export function ageing(invoices = [], asOf = new Date()) {
  const today = startOfDay(asOf);
  const buckets = {
    notDue: { count: 0, paise: 0 },
    d0_30: { count: 0, paise: 0 },
    d31_60: { count: 0, paise: 0 },
    d61_90: { count: 0, paise: 0 },
    over90: { count: 0, paise: 0 },
  };

  const rows = [];
  for (const inv of invoices) {
    // Paid, cancelled and written-off invoices are not money anyone is waiting
    // for. Including them makes the ageing total meaningless.
    if (["paid", "cancelled", "written-off", "draft"].includes(inv.status)) continue;

    const outstandingPaise = Math.max(0, (inv.totalPaise || 0) - (inv.paidPaise || 0));
    if (outstandingPaise === 0) continue;

    const due = startOfDay(inv.dueOn);
    const daysLate = Math.floor((today - due) / 86400000);

    let bucket;
    if (daysLate <= 0) bucket = "notDue";
    else if (daysLate <= 30) bucket = "d0_30";
    else if (daysLate <= 60) bucket = "d31_60";
    else if (daysLate <= 90) bucket = "d61_90";
    else bucket = "over90";

    buckets[bucket].count += 1;
    buckets[bucket].paise += outstandingPaise;

    rows.push({
      id: inv.id,
      number: inv.number,
      client: inv.client?.name || inv.billToName,
      clientId: inv.clientId,
      issuedOn: inv.issuedOn,
      dueOn: inv.dueOn,
      totalPaise: inv.totalPaise,
      paidPaise: inv.paidPaise || 0,
      outstandingPaise,
      daysLate: Math.max(0, daysLate),
      bucket,
      status: inv.status,
    });
  }

  rows.sort((a, b) => b.daysLate - a.daysLate || b.outstandingPaise - a.outstandingPaise);

  return {
    buckets,
    rows,
    totalOutstandingPaise: rows.reduce((s, r) => s + r.outstandingPaise, 0),
    overdueCount: rows.filter((r) => r.daysLate > 0).length,
    overduePaise: rows.filter((r) => r.daysLate > 0).reduce((s, r) => s + r.outstandingPaise, 0),
  };
}

function startOfDay(d) {
  const x = new Date(d);
  return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());
}

/**
 * Everything that must be true before an invoice can be raised.
 *
 * Returned as a list rather than thrown one at a time, so someone setting the
 * company up fixes all four at once instead of discovering them one save at a
 * time. An invoice missing a GSTIN is not a draft — it is a document that
 * cannot legally be issued, and the app should say so before it is sent.
 */
export function invoiceBlockers({ settings, client, placements = [] }) {
  const out = [];

  if (!settings?.gstin) out.push("Your company GSTIN is not set — Settings.");
  else if (!looksLikeGstin(settings.gstin)) out.push(`Your company GSTIN "${settings.gstin}" is not a valid format.`);
  if (!settings?.stateCode) out.push("Your company's state code is not set — it decides CGST+SGST versus IGST.");
  if (!settings?.addressLine) out.push("Your company address is not set — it must appear on a tax invoice.");

  if (!client?.name) out.push("No client on this invoice.");
  if (client && !client.state && !client.gstin) {
    out.push(`No state or GSTIN for ${client.name} — without one the correct tax cannot be worked out.`);
  }
  if (client?.gstin && !looksLikeGstin(client.gstin)) {
    out.push(`${client.name}'s GSTIN "${client.gstin}" is not a valid format.`);
  }

  if (!placements.length) out.push("Nothing to bill — add at least one placement.");
  for (const p of placements) {
    if (!p.joinedOn) out.push(`${p.candidate?.name || "A candidate"} has not joined yet — there is nothing to invoice until they do.`);
    if (p.droppedOn) out.push(`${p.candidate?.name || "A candidate"} dropped out. Check the replacement terms before billing.`);
    if (!p.revenue) out.push(`${p.candidate?.name || "A placement"} has no fee calculated.`);
  }

  return out;
}

/**
 * The amount in words, Indian style, for the bottom of a tax invoice.
 *
 * "Rupees Two Lakh Thirty Four Thousand Nine Hundred Twelve and Sixteen Paise
 * Only". Every printed invoice in India carries this line, and it is the line
 * that legally settles a dispute when the figures have been tampered with.
 *
 * Indian grouping is NOT thousands all the way up: it is hundreds, thousands,
 * then LAKHS (100 thousand) and CRORES (100 lakh). Writing this with the
 * western thousand-million-billion grouping produces "Two Hundred Thirty Four
 * Thousand", which is not wrong so much as not what an Indian invoice says.
 */
const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen",
  "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function twoDigits(n) {
  if (n < 20) return ONES[n];
  const t = TENS[Math.floor(n / 10)];
  const o = ONES[n % 10];
  return o ? `${t} ${o}` : t;
}

function threeDigits(n) {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const parts = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (rest) parts.push(twoDigits(rest));
  return parts.join(" ");
}

/** A whole number in Indian words. 234912 → "Two Lakh Thirty Four Thousand Nine Hundred Twelve". */
export function indianWords(num) {
  let n = Math.floor(Math.abs(Number(num) || 0));
  if (n === 0) return "Zero";

  const parts = [];
  const crore = Math.floor(n / 10000000);
  if (crore) { parts.push(`${indianWords(crore)} Crore`); n %= 10000000; }
  const lakh = Math.floor(n / 100000);
  if (lakh) { parts.push(`${twoDigits(lakh)} Lakh`); n %= 100000; }
  const thousand = Math.floor(n / 1000);
  if (thousand) { parts.push(`${twoDigits(thousand)} Thousand`); n %= 1000; }
  if (n) parts.push(threeDigits(n));

  return parts.join(" ");
}

/** The full line: paise → "Rupees … Only". */
export function amountInWords(paise) {
  const p = Math.round(Math.abs(Number(paise) || 0));
  const rupees = Math.floor(p / RUPEE);
  const fraction = p % RUPEE;

  const head = `Rupees ${indianWords(rupees)}`;
  const tail = fraction ? ` and ${indianWords(fraction)} Paise` : "";
  return `${head}${tail} Only`;
}
