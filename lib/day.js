// lib/day.js — what "today" means, decided in one place.
//
// This lives in lib/ and not beside the route that needed it for a blunt
// reason: a Next.js route.js file may export ONLY the HTTP handlers and the
// segment config. One extra export — a helper, a constant, anything — fails the
// build with an error that does not name the export, and the hunt costs an
// afternoon. Helpers go in lib/. Always.
//
// The substance: this desk works in India and nowhere else, so the working day
// is the IST day, computed from the SERVER clock. Never from the browser. A day
// boundary the user's device decides is a day boundary the user can move.

export const IST_OFFSET_MIN = 330;

/** The working day a given instant falls in, as a UTC-midnight Date. */
export function istDay(at = new Date()) {
  const ist = new Date(new Date(at).getTime() + IST_OFFSET_MIN * 60000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

/** "2026-09" for the day an instant falls in. */
export function istMonth(at = new Date()) {
  const d = istDay(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** "2026-09-12" for the day an instant falls in. */
export function istDateString(at = new Date()) {
  return istDay(at).toISOString().slice(0, 10);
}

/**
 * { from, to } for a month string, half-open so the last day is never dropped
 * and the first day of the next month is never included. Null if unparseable —
 * a bad month must not silently become "all time".
 */
export function monthRange(month) {
  const [y, m] = String(month || "").split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return null;
  return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) };
}

/** "September 2026". */
export function monthLabel(month) {
  const r = monthRange(month);
  if (!r) return String(month || "");
  return r.from.toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** A time of day as the desk says it: "9:30 am". */
export function timeLabel(d) {
  if (!d) return "—";
  return new Date(d).toLocaleTimeString("en-IN", {
    hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata",
  });
}

/** The months to offer in a picker: this month back through `count - 1`. */
export function recentMonths(count = 12, at = new Date()) {
  const d = istDay(at);
  const out = [];
  for (let i = 0; i < count; i++) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(`${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}
