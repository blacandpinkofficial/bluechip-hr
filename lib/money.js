// lib/money.js — every rupee in this app passes through here.
//
// RULE: money is an integer number of rupees. Percentages are basis points
// (8.33% = 833). Nothing is ever a float.
//
// This is not fussiness. The commercials in the client sheet are 8.33% of CTC,
// and 8.33% of ₹1,05,000 is ₹8,746.50 — a half-rupee that has to be resolved
// the same way every single time. Do it in floats and it isn't: twelve
// placements at ₹2,35,000 sum to ₹2,34,906 the float way and ₹2,34,912 the
// integer way. A six-rupee gap on a month's revenue report is small enough
// that nobody finds the cause and large enough that nobody trusts the report.

/** Basis points → a readable percent string. 833 → "8.33%" */
export function bpsToPercent(bps) {
  if (bps == null) return null;
  return (bps / 100).toFixed(2).replace(/\.00$/, "") + "%";
}

/** "8.33" or "8.33%" or 8.33 → 833 basis points. Returns null if unparseable. */
export function percentToBps(input) {
  if (input == null || input === "") return null;
  const n = Number(String(input).replace("%", "").trim());
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 100);
}

/**
 * Rupees for display: 8000 → "₹8,000"; 600000 → "₹6,00,000" (Indian grouping).
 * Pass { short: true } for "₹6L" in tight table cells.
 */
export function rupees(n, { short = false } = {}) {
  if (n == null || n === "") return "—";
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return "—";
  if (short) {
    if (Math.abs(v) >= 10000000) return "₹" + trimZero(v / 10000000) + "Cr";
    if (Math.abs(v) >= 100000) return "₹" + trimZero(v / 100000) + "L";
    if (Math.abs(v) >= 1000) return "₹" + trimZero(v / 1000) + "K";
    return "₹" + v;
  }
  return "₹" + v.toLocaleString("en-IN");
}

function trimZero(x) {
  return (Math.round(x * 10) / 10).toString().replace(/\.0$/, "");
}

/**
 * Parse a rupee figure a recruiter typed. Accepts "18000", "18,000", "18k",
 * "₹18,000", "1.8L", "6 lpa". Returns integer rupees, or null.
 *
 * Recruiters type "18k" because that is how the number is said out loud on the
 * call. Rejecting it and demanding "18000" would just mean the field gets left
 * empty, and an empty field is worth less than a parsed one.
 */
export function parseRupees(input) {
  if (input == null) return null;
  const s = String(input).toLowerCase().replace(/[₹,\s]/g, "").trim();
  if (!s) return null;

  const m = s.match(/^(\d+(?:\.\d+)?)(k|l|lakh|lac|lpa|cr)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;

  switch (m[2]) {
    case "k": return Math.round(n * 1000);
    case "l":
    case "lakh":
    case "lac":
    case "lpa": return Math.round(n * 100000);
    case "cr": return Math.round(n * 10000000);
    default: return Math.round(n);
  }
}

/** Monthly take-home → indicative annual CTC. Recruiters quote monthly. */
export function monthlyToAnnual(monthly) {
  if (monthly == null) return null;
  return Math.round(Number(monthly) * 12);
}

export function annualToMonthly(annual) {
  if (annual == null) return null;
  return Math.round(Number(annual) / 12);
}
