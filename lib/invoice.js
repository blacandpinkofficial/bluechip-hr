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
  const rows = ageingRows(invoices, asOf);
  const buckets = emptyAgeingBuckets();
  for (const r of rows) {
    buckets[r.bucket].count += 1;
    buckets[r.bucket].paise += r.outstandingPaise;
  }
  return ageingFromBuckets(buckets, rows);
}

/** The five buckets, all zero. */
export function emptyAgeingBuckets() {
  return {
    notDue: { count: 0, paise: 0 },
    d0_30: { count: 0, paise: 0 },
    d31_60: { count: 0, paise: 0 },
    d61_90: { count: 0, paise: 0 },
    over90: { count: 0, paise: 0 },
  };
}

/** Which bucket a number of days late falls in. */
export function bucketForDaysLate(daysLate) {
  if (daysLate <= 0) return "notDue";
  if (daysLate <= 30) return "d0_30";
  if (daysLate <= 60) return "d31_60";
  if (daysLate <= 90) return "d61_90";
  return "over90";
}

/**
 * The per-invoice detail rows, for the invoices actually on screen.
 *
 * Deliberately separate from the buckets. The rows describe the page you are
 * looking at; the buckets must describe the whole book, and a page of rows
 * cannot produce them — see ageingBucketWindows.
 */
export function ageingRows(invoices = [], asOf = new Date()) {
  const today = startOfDay(asOf);
  const rows = [];

  for (const inv of Array.isArray(invoices) ? invoices : []) {
    // Paid, cancelled and written-off invoices are not money anyone is waiting
    // for. Including them makes the ageing total meaningless.
    if (!OUTSTANDING_STATUSES.includes(inv.status)) continue;

    const outstandingPaise = Math.max(0, (inv.totalPaise || 0) - (inv.paidPaise || 0));
    if (outstandingPaise === 0) continue;

    const due = startOfDay(inv.dueOn);
    const daysLate = Math.floor((today - due) / 86400000);

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
      bucket: bucketForDaysLate(daysLate),
      status: inv.status,
    });
  }

  rows.sort((a, b) => b.daysLate - a.daysLate || b.outstandingPaise - a.outstandingPaise);
  return rows;
}

/**
 * The same five buckets expressed as dueOn windows, so the database can count
 * and sum them over EVERY outstanding invoice instead of over whatever page
 * happened to be fetched.
 *
 * This is the whole of BC-05. The buckets used to be folded in JavaScript over
 * `take: 300` invoices ordered `issuedOn: desc`, which means that past invoice
 * 301 the report dropped the OLDEST debt first — the "over 90" bucket, the one
 * number the report exists to show, was the first casualty of the desk growing.
 *
 * Windows are half-open and expressed against UTC-midnight dates, which is what
 * Invoice.dueOn is (@db.Date), so they tile the line exactly with no invoice in
 * two buckets and none in none:
 *
 *   notDue  due >= today                     daysLate <= 0
 *   d0_30   today-30 <= due <  today         daysLate 1..30
 *   d31_60  today-60 <= due <  today-30      daysLate 31..60
 *   d61_90  today-90 <= due <  today-60      daysLate 61..90
 *   over90               due <  today-90     daysLate >= 91
 */
export function ageingBucketWindows(asOf = new Date()) {
  const today = new Date(startOfDay(asOf));
  const back = (days) => new Date(today.getTime() - days * 86400000);
  return [
    { key: "notDue", dueOn: { gte: today } },
    { key: "d0_30", dueOn: { gte: back(30), lt: today } },
    { key: "d31_60", dueOn: { gte: back(60), lt: back(30) } },
    { key: "d61_90", dueOn: { gte: back(90), lt: back(60) } },
    { key: "over90", dueOn: { lt: back(90) } },
  ];
}

/** Buckets (however they were counted) plus rows, as the screen wants them. */
export function ageingFromBuckets(buckets, rows = []) {
  const b = { ...emptyAgeingBuckets(), ...(buckets || {}) };
  const overdue = ["d0_30", "d31_60", "d61_90", "over90"];
  return {
    buckets: b,
    rows: Array.isArray(rows) ? rows : [],
    totalOutstandingPaise: Object.values(b).reduce((s, x) => s + (x.paise || 0), 0),
    overdueCount: overdue.reduce((s, k) => s + (b[k].count || 0), 0),
    overduePaise: overdue.reduce((s, k) => s + (b[k].paise || 0), 0),
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

// ═══════════════════════════════════════════════════════════════════════════
// The ledger: statuses, receipts, and the rules that connect them.
//
// Everything below is PURE. This module is imported by a client component
// (app/invoices/page.jsx), so it must never reach for prisma — a prisma import
// here would drag the query engine into the browser bundle and fail the build.
// Orchestration lives in the route; the rules live here, where they can be
// reasoned about and modelled without a database.
// ═══════════════════════════════════════════════════════════════════════════

/** Every status an invoice may hold. */
export const INVOICE_STATUSES = ["draft", "raised", "paid", "part-paid", "written-off", "cancelled"];

/**
 * The statuses that mean "money is still being waited for".
 *
 * draft has not been issued, paid has arrived, cancelled was never owed and
 * written-off has been given up on. Only these two are debt.
 */
export const OUTSTANDING_STATUSES = ["raised", "part-paid"];

/** Statuses an operator may set by hand. paid and part-paid are derived. */
export const SETTABLE_STATUSES = ["draft", "raised", "written-off", "cancelled"];

/**
 * Raised when a placement was billed by somebody else between the check and
 * the write. Thrown INSIDE the invoice transaction so the whole invoice — its
 * number, its lines, its totals — rolls back rather than half-existing.
 */
export class AlreadyBilledError extends Error {
  constructor(taken = []) {
    const labels = taken.map((t) => t.label).filter(Boolean);
    const many = taken.length !== 1;
    super(
      labels.length
        ? `${labels.join(", ")} ${many ? "were" : "was"} invoiced while this invoice was being raised. Nothing has been billed twice — reload and raise it again for whatever is left.`
        : `${taken.length || "Some"} of those placements were invoiced while this invoice was being raised. Nothing has been billed twice — reload and try again.`
    );
    this.name = "AlreadyBilledError";
    this.taken = taken;
    this.placementIds = taken.map((t) => t.id).filter(Boolean);
  }
}

/**
 * An idempotency key that has already been used for a DIFFERENT receipt.
 *
 * A reused key is how a retry is made safe; a reused key carrying different
 * money is a bug in the caller, and silently treating it as a replay would
 * swallow a real payment.
 */
export class PaymentKeyConflictError extends Error {
  constructor() {
    super("That idempotency key has already been used for a different receipt. Reload the page and enter the payment again — this one has not been recorded.");
    this.name = "PaymentKeyConflictError";
  }
}

/**
 * An invoice's status, derived from what has actually been received.
 *
 * The receipts are the record; this is a reading of them. Note what it does
 * NOT do: it never moves an invoice out of cancelled or written-off, because
 * those are decisions a person made and arithmetic does not get to overrule
 * them. Everything else follows the money — including backwards, so reversing
 * a mis-keyed receipt puts a "paid" invoice back to "part-paid" or "raised"
 * instead of leaving it looking settled.
 */
export function deriveInvoiceStatus({ currentStatus, totalPaise, paidPaise } = {}) {
  if (currentStatus === "cancelled" || currentStatus === "written-off") return currentStatus;
  const total = Math.round(Number(totalPaise) || 0);
  const paid = Math.round(Number(paidPaise) || 0);
  if (total > 0 && paid >= total) return "paid";
  if (paid > 0) return "part-paid";
  return currentStatus === "draft" ? "draft" : "raised";
}

/**
 * What a placement's invoiceStatus becomes when its invoice reaches a status.
 *
 * Only a FULLY paid invoice makes its placements paid. Treating "part-paid" as
 * paid used to tip the whole placement's revenue into the collected figure on
 * the placements screen, so receiving ₹10,000 against a ₹2,00,000 invoice
 * reported ₹2,00,000 as money in the bank.
 *
 * Cancelling releases the placements back to "pending" so they reappear in
 * "earned but not invoiced" — otherwise the fee is simply lost from view.
 */
export function placementStatusForInvoice(invoiceStatus) {
  if (invoiceStatus === "paid") return "paid";
  if (invoiceStatus === "written-off") return "written-off";
  if (invoiceStatus === "cancelled") return "pending";
  return "raised";
}

/**
 * Rupees to paise WITHOUT touching a float.
 *
 * rupeesToPaise above multiplies by 100 and rounds, which is exactly right for
 * the whole-rupee placement fees it was written for. It is not right for an
 * amount somebody types into a payment box: `0.1 + 0.2` arithmetic is how a
 * receipt becomes a paisa short, and a ledger a paisa short is a ledger that
 * fails its own reconciliation.
 *
 * So the digits are parsed as integers and combined as integers. "50,000" →
 * 5000000. "1234.5" → 123450. "1234.567" → null, because three decimal places
 * in a rupee amount is a typo, not a rounding problem to solve silently.
 * A leading "-" is allowed: that is how a reversal is entered.
 */
export function parseRupeesToPaise(input) {
  if (input === null || input === undefined) return null;
  const s = String(input).trim().replace(/[,  ]/g, "");
  if (!s) return null;
  const m = s.match(/^([+-])?(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const whole = parseInt(m[2], 10);
  const frac = m[3] ? parseInt(m[3].padEnd(2, "0"), 10) : 0;
  if (!Number.isSafeInteger(whole)) return null;
  const paise = sign * (whole * RUPEE + frac);
  return Number.isSafeInteger(paise) ? paise : null;
}

/**
 * The amount of a receipt, in paise, from whatever the caller sent.
 *
 * `amountPaise` is the precise form and wins. `paidRupees` is what the screen
 * sends and what a human types. Returns null if neither is usable — never 0,
 * so "unparseable" and "zero" stay distinguishable.
 */
export function receiptAmountPaise(body = {}) {
  if (body.amountPaise !== undefined && body.amountPaise !== null && body.amountPaise !== "") {
    const n = Number(body.amountPaise);
    if (!Number.isSafeInteger(n)) return null;
    return n;
  }
  if (body.paidRupees !== undefined && body.paidRupees !== null && body.paidRupees !== "") {
    return parseRupeesToPaise(body.paidRupees);
  }
  return null;
}

/** Recognised ways money arrives. Anything else is rejected rather than stored. */
export const PAYMENT_METHODS = ["neft", "rtgs", "imps", "upi", "cheque", "cash", "adjustment"];

/**
 * Placements that may be put on a new invoice.
 *
 * TWO conditions, and both are load-bearing:
 *
 *   billedByInvoiceId: null — the claim flag. This is what the transaction
 *   conditionally writes, and it is the only thing that actually prevents two
 *   operators billing the same joining at the same moment.
 *
 *   no line on an invoice that still stands — the older test, kept because
 *   invoices raised before the claim flag existed have placements whose flag is
 *   still null. Without it every historical invoice's placements would reappear
 *   as billable on the day this ships. It also carries the intent the audit
 *   praised: NOT `invoiceLines: none`, because cancelling an invoice leaves its
 *   lines in place and the plain version would hide those placements forever.
 */
export function billablePlacementWhere() {
  return {
    joinedOn: { not: null },
    droppedOn: null,
    billedByInvoiceId: null,
    invoiceLines: { none: { invoice: { is: { status: { not: "cancelled" } } } } },
  };
}

/**
 * The placements whose financial status a given invoice owns.
 *
 * "Has a line on this invoice" is not enough on its own: a placement that was
 * cancelled off invoice A and deliberately re-billed on invoice B still has its
 * historical line on A, and A must not be able to reach across and re-stamp it.
 * So: a line on this invoice, AND claimed by this invoice or claimed by nobody
 * (which is every placement billed before the claim flag existed).
 */
export function invoiceOwnedPlacementWhere(invoiceId) {
  return {
    invoiceLines: { some: { invoiceId } },
    OR: [{ billedByInvoiceId: invoiceId }, { billedByInvoiceId: null }],
  };
}

/**
 * skip / take from a query string, clamped.
 *
 * `take` bounds the ROWS ON SCREEN and nothing else. Every total on this screen
 * is counted by the database over the whole set; that separation is the point
 * of BC-05 and is why this helper is only ever used on findMany.
 */
export function pageParams(searchParams, { defaultTake = 50, maxTake = 200 } = {}) {
  const get = (k) => (searchParams && typeof searchParams.get === "function" ? searchParams.get(k) : null);
  const rawTake = parseInt(String(get("take") ?? ""), 10);
  const rawSkip = parseInt(String(get("skip") ?? ""), 10);
  const take = Number.isFinite(rawTake) && rawTake > 0 ? Math.min(rawTake, maxTake) : defaultTake;
  const skip = Number.isFinite(rawSkip) && rawSkip > 0 ? rawSkip : 0;
  return { skip, take };
}

/**
 * Is this a transaction the database asked us to retry?
 *
 * P2002 is the unique constraint — somebody took the invoice number first.
 * P2034 is a serialisation failure or deadlock, which is what Postgres returns
 * when two SERIALIZABLE transactions recompute the same invoice's paid total at
 * once. Both mean "your transaction did not happen, do it again", and both are
 * the concurrency control working rather than an error to report.
 */
export function isRetryableTxError(e) {
  if (!e) return false;
  if (e.code === "P2034") return true;
  const pg = String(e.meta?.code || e.meta?.database_error || "");
  return pg === "40001" || pg === "40P01";
}
