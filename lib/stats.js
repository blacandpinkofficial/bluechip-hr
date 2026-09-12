// lib/stats.js — the recruiting funnel, and how to read it honestly.
//
// The old workbook's "Daily productivity" tab asked someone to type six numbers
// every evening that were already knowable from the rows above it. These are
// those numbers, derived. Nobody tallies, so nobody rounds up.
//
// The harder half is the funnel. "Success rate" sounds like one number and is
// really five, and which one you quote decides what the desk optimises for:
//
//   connect rate   calls that reached a human       → is the data any good?
//   line-up rate   connects that became interviews  → is the screening working?
//   show rate      line-ups that were attended      → are we picking real ones?
//   select rate    attended that got selected       → are we sending the right people?
//   join rate      selected that actually joined    → is the offer realistic?
//
// Quote only the last and a recruiter learns to chase easy roles. Quote only the
// first and they learn to dial and hang up. So all five are shown, and the one
// that matters most — placements per hundred calls — is stated separately.

import { istDay } from "@/lib/day";

/** Percentage, guarding the empty case. 0 of 0 is "—", not 0% and not NaN. */
export function rate(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export function fmtRate(r) {
  return r == null ? "—" : `${r}%`;
}

/**
 * Build one recruiter's funnel from raw counts.
 * Every stage is a count of rows that exist, never a stored total.
 */
export function funnel({
  calls = 0,
  connects = 0,
  lineUps = 0,
  attended = 0,
  selected = 0,
  joined = 0,
} = {}) {
  return {
    counts: { calls, connects, lineUps, attended, selected, joined },
    rates: {
      connect: rate(connects, calls),
      lineUp: rate(lineUps, connects),
      show: rate(attended, lineUps),
      select: rate(selected, attended),
      join: rate(joined, selected),
    },
    // The number the business actually runs on. A recruiter making 400 calls a
    // week at a 2% end-to-end rate is worth more than one making 40 at 5%, and
    // no single stage rate shows that.
    placementsPerHundredCalls: calls ? Math.round((joined / calls) * 1000) / 10 : null,
  };
}

/**
 * Where is this recruiter losing people? Returns the weakest stage with enough
 * volume to mean anything, or null.
 *
 * The volume floor exists because "0 of 1 attended = 0% show rate" is not a
 * finding, it is one candidate with a flat tyre, and a dashboard that calls it
 * a problem trains people to ignore the dashboard.
 */
export function weakestStage(f, { minVolume = 5 } = {}) {
  const stages = [
    { key: "connect", label: "reaching people", denom: f.counts.calls, r: f.rates.connect },
    { key: "lineUp", label: "turning conversations into line-ups", denom: f.counts.connects, r: f.rates.lineUp },
    { key: "show", label: "candidates actually attending", denom: f.counts.lineUps, r: f.rates.show },
    { key: "select", label: "getting selected", denom: f.counts.attended, r: f.rates.select },
    { key: "join", label: "selections turning into joinings", denom: f.counts.selected, r: f.rates.join },
  ].filter((s) => s.denom >= minVolume && s.r != null);

  if (stages.length === 0) return null;
  return stages.reduce((worst, s) => (s.r < worst.r ? s : worst));
}

/**
 * A dense series for a bar chart: one entry per day across the range, with
 * zeroes filled in.
 *
 * Filling matters. A chart built only from days that had activity silently
 * closes the gaps, so a week where nobody called on Tuesday and Wednesday looks
 * identical to a week where they did — the two quiet days simply vanish and the
 * bars shuffle left.
 */
export function daily(rows, { days = 14, now = new Date(), key = "calledAt" } = {}) {
  const out = [];
  // Bucketed by IST day, not the server's local day. This runs on a UTC box,
  // where setHours(0,0,0,0) draws the boundary at 05:30 IST — so every call
  // logged before dawn fell into the previous bar. Night shifts are normal here.
  const end = istDay(now);

  const buckets = new Map();
  for (const r of rows || []) {
    const d = new Date(r[key]);
    if (Number.isNaN(d.getTime())) continue;
    const k = istDay(d).toISOString().slice(0, 10);
    buckets.set(k, (buckets.get(k) || 0) + 1);
  }

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 86400000);
    const k = d.toISOString().slice(0, 10);
    out.push({
      date: k,
      label: d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
      weekday: d.toLocaleDateString("en-IN", { weekday: "short" }),
      count: buckets.get(k) || 0,
    });
  }
  return out;
}

/** Highest value in a series, floored at 1 so an all-zero chart still renders. */
export function peak(series) {
  return Math.max(1, ...(series || []).map((s) => s.count || 0));
}
