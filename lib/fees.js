// lib/fees.js — how Blue Chip gets paid.
//
// The "COMMERCIALS" column of the job-description sheet holds one of two
// things, and Excel stored them so differently that they could not be compared:
// a flat fee typed as "8k", or a percentage of CTC that Excel silently turned
// into the fraction 0.0833. Here they are two explicit shapes.
//
// Resolution order for any given opening:
//   1. the requirement's own terms, if set  (a one-off rate for this role)
//   2. the client's house terms             (the usual deal with this client)
//   3. nothing — and the UI must say so rather than quietly bill zero

export const FEE_TYPES = ["percent", "flat"];

/**
 * Which terms apply to this requirement?
 * Returns { feeType, feeBps, feeFlat, source } — source is "requirement",
 * "client" or "none", so the screen can show where the number came from.
 */
export function resolveFee(requirement, client) {
  const r = requirement || {};
  const c = client || requirement?.client || {};

  if (r.feeType === "percent" && r.feeBps != null) {
    return { feeType: "percent", feeBps: r.feeBps, feeFlat: null, source: "requirement" };
  }
  if (r.feeType === "flat" && r.feeFlat != null) {
    return { feeType: "flat", feeBps: null, feeFlat: r.feeFlat, source: "requirement" };
  }
  if (c.feeType === "percent" && c.feeBps != null) {
    return { feeType: "percent", feeBps: c.feeBps, feeFlat: null, source: "client" };
  }
  if (c.feeType === "flat" && c.feeFlat != null) {
    return { feeType: "flat", feeBps: null, feeFlat: c.feeFlat, source: "client" };
  }
  return { feeType: null, feeBps: null, feeFlat: null, source: "none" };
}

/**
 * The fee in rupees for a placement at a given annual CTC.
 *
 * Integer arithmetic throughout: multiply first, divide once, round once. The
 * order matters — 105000 × 833 / 10000 lands on 8746.5, and rounding that one
 * half-rupee in exactly one place is what keeps a month of placements adding up
 * to the same total no matter how they are summed.
 *
 * Returns null when terms are missing. Null means "we do not know what to
 * bill", which is a different and much more useful answer than 0.
 */
export function computeRevenue({ feeType, feeBps, feeFlat, ctcOfferedAnnual }) {
  if (feeType === "flat") {
    return feeFlat == null ? null : Math.round(feeFlat);
  }
  if (feeType === "percent") {
    if (feeBps == null || ctcOfferedAnnual == null) return null;
    return Math.round((Math.round(ctcOfferedAnnual) * Math.round(feeBps)) / 10000);
  }
  return null;
}

/**
 * The terms to write onto a Placement row at the moment of selection.
 *
 * These are COPIED, never looked up later. When Blue Chip renegotiates its rate
 * with a client next year, every placement already made must keep the terms it
 * was made under — otherwise last year's closed months quietly change value and
 * no report can be trusted twice.
 */
export function freezeTerms({ requirement, client, ctcOfferedAnnual }) {
  const fee = resolveFee(requirement, client);
  return {
    feeType: fee.feeType,
    feeBps: fee.feeBps,
    feeFlat: fee.feeFlat,
    revenue: computeRevenue({ ...fee, ctcOfferedAnnual }),
  };
}

/** Human summary of terms, for a chip or a tooltip. */
export function describeFee(fee) {
  if (!fee || !fee.feeType) return "No commercials set";
  if (fee.feeType === "flat") return `₹${Number(fee.feeFlat).toLocaleString("en-IN")} flat`;
  return `${(fee.feeBps / 100).toFixed(2).replace(/\.00$/, "")}% of CTC`;
}

/**
 * The free-replacement window. If a candidate leaves inside it, Blue Chip owes
 * the client a replacement and the revenue is at risk — which is worth knowing
 * before the month closes, not after.
 */
export function replacementDeadline(joinedOn, days = 90) {
  if (!joinedOn) return null;
  const d = new Date(joinedOn);
  d.setDate(d.getDate() + days);
  return d;
}
