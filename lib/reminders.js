// lib/reminders.js — the app already knows what is due. This makes it say so.
//
// Everything below is derived from rows the app has held all along: a
// nextFollowUpAt nobody opened, an interview tomorrow, a guarantee period
// quietly expiring, a CV sent eight days ago that nobody chased. None of it is
// new information. It was simply only visible to whoever thought to look.
//
// PURE. No database, no clock of its own — `today` is passed in. That is what
// makes the rules testable, and these rules decide what a person does with
// their morning, so they had better be testable.
//
// Two things shape every rule here:
//
//   IDEMPOTENCE. The nightly job must be safe to run twice, or by hand at
//   11am. So every reminder has a stable identity — (user, kind, refId, dueOn)
//   — and re-running regenerates the same one rather than a duplicate. A list
//   that doubles when someone re-runs a script is a list people stop reading.
//
//   SILENCE IS THE DEFAULT. A reminder that fires for something nobody can act
//   on trains people to dismiss the list unread. If there is nothing to do, this
//   returns nothing.

const DAY = 86400000;

/** A Date at UTC midnight — the day something belongs to. */
export function day(d) {
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
}

function daysBetween(a, b) {
  return Math.round((day(b) - day(a)) / DAY);
}

function name(x) {
  return x?.name || "Someone";
}

/**
 * How many days of silence before a submission needs chasing.
 *
 * Four, not seven. A client who has not replied in four working days has not
 * "not got round to it" — they have moved on, or the CV went to spam, and the
 * candidate is meanwhile being placed by somebody else. Seven days is a polite
 * number that costs placements.
 */
export const SILENCE_DAYS = 4;

/** How long before a replacement guarantee expires to start saying so. */
export const GUARANTEE_WARNING_DAYS = 10;

/**
 * Build every reminder that should exist today.
 *
 * Returns specs, not rows: { userId, kind, title, body, dueOn, urgency,
 * refType, refId }. The caller upserts them.
 */
export function buildReminders({
  today = new Date(),
  candidates = [],
  interviews = [],
  placements = [],
  invoices = [],
  attendance = [],
  submissions = [],
  owners = [], // user ids who should get money reminders (owner/manager)
} = {}) {
  const t = day(today);
  const out = [];
  const add = (r) => {
    // A reminder with no one to act on it is not a reminder. Dropping it here
    // rather than letting it become a row with a null user is deliberate: an
    // unassigned task is one nobody does and everybody sees.
    if (!r.userId || !r.refId) return;
    out.push({ urgency: "normal", ...r, dueOn: day(r.dueOn || t) });
  };

  // ── 1. follow-ups that are due ────────────────────────────────────────────
  for (const c of candidates) {
    if (!c.nextFollowUpAt || c.archived) continue;
    if (["joined", "dropped"].includes(c.stage)) continue;

    const late = daysBetween(c.nextFollowUpAt, t);
    if (late < 0) continue; // not yet

    add({
      userId: c.ownerId,
      kind: "follow-up",
      refType: "candidate",
      refId: c.id,
      dueOn: c.nextFollowUpAt,
      urgency: late >= 2 ? "now" : "normal",
      title: late === 0 ? `Call ${name(c)} today` : `${name(c)} — follow-up ${late} day${late === 1 ? "" : "s"} late`,
      body: [c.designation, c.location, c.stage].filter(Boolean).join(" · ") || null,
    });
  }

  // ── 2. interviews today and tomorrow ──────────────────────────────────────
  for (const iv of interviews) {
    if (iv.attended != null) continue; // already happened and was recorded
    if (iv.outcome && iv.outcome !== "pending") continue;

    const inDays = daysBetween(t, iv.scheduledAt);
    if (inDays < 0 || inDays > 1) continue;

    const who = iv.candidate?.ownerId || iv.createdById;
    add({
      userId: who,
      kind: "interview",
      refType: "interview",
      refId: iv.id,
      dueOn: iv.scheduledAt,
      urgency: inDays === 0 ? "now" : "normal",
      title:
        inDays === 0
          ? `${name(iv.candidate)} interviews today — ${iv.requirement?.designation || "interview"}`
          : `${name(iv.candidate)} interviews tomorrow — ${iv.requirement?.designation || "interview"}`,
      body: [
        iv.mode,
        iv.requirement?.client?.name,
        iv.location,
        // The thing that actually loses interviews: nobody confirmed the
        // candidate is still coming.
        inDays === 1 ? "Confirm they are still attending." : null,
      ].filter(Boolean).join(" · "),
    });
  }

  // ── 3. interviews that happened and were never written up ─────────────────
  for (const iv of interviews) {
    if (iv.attended != null) continue;
    const ago = daysBetween(iv.scheduledAt, t);
    if (ago < 1 || ago > 14) continue; // yesterday to a fortnight; older is history

    add({
      userId: iv.candidate?.ownerId || iv.createdById,
      kind: "interview",
      refType: "interview",
      refId: iv.id,
      dueOn: iv.scheduledAt,
      urgency: "now",
      title: `No outcome recorded for ${name(iv.candidate)}`,
      body: `Interviewed ${ago} day${ago === 1 ? "" : "s"} ago. Did they attend, and what did the client say?`,
    });
  }

  // ── 4. replacement guarantees ─────────────────────────────────────────────
  for (const p of placements) {
    if (!p.replacementUntil) continue;
    const daysLeft = daysBetween(t, p.replacementUntil);

    // A candidate who dropped INSIDE the guarantee means a free replacement is
    // owed. That is not a reminder to note down — it is work that starts today,
    // and the client will raise it before you do if you leave it.
    if (p.droppedOn && daysBetween(p.droppedOn, p.replacementUntil) >= 0) {
      add({
        userId: p.recruiterId,
        kind: "guarantee",
        refType: "placement",
        refId: p.id,
        dueOn: p.droppedOn,
        urgency: "now",
        title: `Replacement owed — ${name(p.candidate)} dropped at ${p.client?.name || "the client"}`,
        body: "They left inside the guarantee period, so the replacement is free. Start sourcing before the client asks.",
      });
      continue;
    }

    if (p.droppedOn) continue;
    if (daysLeft < 0 || daysLeft > GUARANTEE_WARNING_DAYS) continue;

    add({
      userId: p.recruiterId,
      kind: "guarantee",
      refType: "placement",
      refId: p.id,
      dueOn: p.replacementUntil,
      urgency: "later",
      title: `Guarantee on ${name(p.candidate)} ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
      body: `${p.client?.name || "Client"} · after this the placement is no longer replaceable free of charge.`,
    });
  }

  // ── 5. money ──────────────────────────────────────────────────────────────
  for (const inv of invoices) {
    if (["paid", "cancelled", "written-off", "draft"].includes(inv.status)) continue;
    const outstanding = (inv.totalPaise || 0) - (inv.paidPaise || 0);
    if (outstanding <= 0) continue;

    const late = daysBetween(inv.dueOn, t);
    if (late < -3) continue; // start three days before it falls due

    const amount = `₹${Math.round(outstanding / 100).toLocaleString("en-IN")}`;
    for (const userId of owners) {
      add({
        userId,
        kind: "invoice-due",
        refType: "invoice",
        refId: inv.id,
        dueOn: inv.dueOn,
        urgency: late > 0 ? "now" : "normal",
        title:
          late > 0
            ? `${inv.number} is ${late} day${late === 1 ? "" : "s"} overdue — ${amount}`
            : `${inv.number} falls due in ${-late} day${late === -1 ? "" : "s"} — ${amount}`,
        body: inv.client?.name || inv.billToName || null,
      });
    }
  }

  // ── 6. CVs sent into silence ──────────────────────────────────────────────
  for (const s of submissions) {
    if (s.status !== "sent") continue;
    const silent = daysBetween(s.sentAt, t);
    if (silent < SILENCE_DAYS) continue;

    add({
      userId: s.sentById,
      kind: "no-response",
      refType: "submission",
      refId: s.id,
      dueOn: s.sentAt,
      urgency: silent >= SILENCE_DAYS * 2 ? "now" : "normal",
      title: `${silent} days, no reply — ${name(s.candidate)} at ${s.client?.name || "the client"}`,
      body: `Sent for ${s.requirement?.designation || "an opening"}. Chase it, or the candidate goes elsewhere.`,
    });
  }

  // ── 7. attendance that cannot be paid ─────────────────────────────────────
  // Yesterday's missing check-out, not today's — today's is simply someone who
  // has not gone home yet, and telling them off for that is how a feature gets
  // switched off.
  for (const a of attendance) {
    if (!a.checkIn || a.checkOut) continue;
    const ago = daysBetween(a.day, t);
    if (ago < 1 || ago > 45) continue;

    add({
      userId: a.userId,
      kind: "attendance",
      refType: "attendance",
      refId: a.id,
      dueOn: a.day,
      urgency: "later",
      title: `No check-out on ${day(a.day).toISOString().slice(0, 10)}`,
      body: "That day counts as no hours worked until a manager corrects it, so it will not be paid.",
    });
  }

  return out;
}

/**
 * Group a person's open reminders for display.
 *
 * Late first, then today, then ahead — because that is the order a person
 * should work them, and a list sorted by creation date buries the overdue item
 * under six things due next week.
 */
export function groupReminders(reminders = [], today = new Date()) {
  const t = day(today);
  const late = [];
  const now = [];
  const ahead = [];

  for (const r of reminders) {
    const d = daysBetween(r.dueOn, t);
    if (d > 0) late.push({ ...r, daysLate: d });
    else if (d === 0) now.push({ ...r, daysLate: 0 });
    else ahead.push({ ...r, daysLate: d });
  }

  const byUrgency = (a, b) => rank(b.urgency) - rank(a.urgency) || b.daysLate - a.daysLate;
  late.sort(byUrgency);
  now.sort(byUrgency);
  // daysLate is NEGATIVE for anything in the future, so ascending order puts
  // the item due in thirty days above the one due tomorrow. Descending is what
  // "soonest first" actually means here.
  ahead.sort((a, b) => b.daysLate - a.daysLate);

  return { late, today: now, ahead, total: reminders.length };
}

function rank(u) {
  return u === "now" ? 2 : u === "normal" ? 1 : 0;
}
