// app/careers/format.js — how the public site says a number out loud.
//
// Not a route: only page.jsx, route.js, layout.jsx and Next's other reserved
// names are. Shared by server pages and by the two client forms, so it holds
// pure functions and imports nothing.
//
// One rule runs through all of it: never round a figure that a candidate could
// hold the desk to. An opening paying ₹18,500 is published as ₹18,500, not as
// "about ₹19,000" — a number no client agreed to.

/** Integer rupees → "₹18,500", Indian grouping. */
export function rupees(n) {
  if (n == null || n === "") return null;
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return null;
  return "₹" + v.toLocaleString("en-IN");
}

/**
 * The pay line. takeHomeMin/Max are MONTHLY take-home, which is the number a
 * recruiter says on the phone, so it is the number shown — with "a month"
 * spelled out, because a bare ₹18,500 next to a job title reads as annual to
 * anyone who has looked at a foreign job board.
 */
export function payLine(job) {
  const lo = rupees(job.takeHomeMin);
  const hi = rupees(job.takeHomeMax);
  if (lo && hi) return lo === hi ? `${lo} a month` : `${lo} – ${hi} a month`;
  if (hi) return `Up to ${hi} a month`;
  if (lo) return `From ${lo} a month`;
  return "Salary discussed on the call";
}

function months(m) {
  if (m == null) return null;
  if (m === 0) return "fresher";
  if (m < 12) return `${m} month${m === 1 ? "" : "s"}`;
  const y = Math.round((m / 12) * 10) / 10;
  const n = Number.isInteger(y) ? y : y.toFixed(1);
  return `${n} year${y === 1 ? "" : "s"}`;
}

/** The experience line, in the words the desk uses. */
export function expLine(job) {
  if (job.expMinMonths === 0 && job.expMaxMonths === 0) return "Freshers welcome";
  const lo = months(job.expMinMonths);
  const hi = months(job.expMaxMonths);
  if (lo && hi) return lo === hi ? lo : `${lo} – ${hi}`;
  if (lo) return `${lo}+`;
  if (hi) return `Up to ${hi}`;
  return "Any experience";
}

export function shiftLabel(shift) {
  if (!shift) return null;
  const s = String(shift).trim();
  if (!s) return null;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function cabLabel(cab) {
  if (cab === "twoway") return "Cab both ways";
  if (cab === "oneway") return "Cab one way";
  return null;
}

/** "12 September 2026" — written out, because a public page read on a phone in
 *  two countries should not depend on whether 09/12 means September. */
export function longDate(d) {
  if (!d) return null;
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return null;
  return x.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
}

/** ISO calendar date (YYYY-MM-DD), which is what JobPosting wants. */
export function isoDate(d) {
  if (!d) return null;
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return null;
  return x.toISOString().slice(0, 10);
}

/**
 * How long a listing stays valid.
 *
 * Google needs validThrough or a posting lives in the index forever, including
 * after this app has stopped answering. Nothing in the database records when an
 * opening expires — a filled one is simply closed — so the date is derived:
 * ninety days from the day it opened. That figure is also PRINTED ON THE PAGE,
 * which is the only reason it is allowed to exist. Structured data that claims
 * something the page does not say is exactly what Google penalises, and a
 * silent expiry date would be that.
 */
export const LISTING_VALID_DAYS = 90;

export function validThrough(openedAt) {
  if (!openedAt) return null;
  const x = new Date(openedAt);
  if (Number.isNaN(x.getTime())) return null;
  return new Date(x.getTime() + LISTING_VALID_DAYS * 86400000);
}
