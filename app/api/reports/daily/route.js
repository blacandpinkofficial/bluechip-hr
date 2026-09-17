// GET /api/reports/daily — one day, one row per recruiter.
//
// This replaces the "recruiters daily report" workbook: the sheet somebody
// filled in every evening so the desk could be read the next morning. Every
// figure here is a count of rows that already exist, so nobody types it and
// nobody rounds it up.
//
// The question the sheet was really for is "who worked today and who didn't",
// and that is not answered by a call count alone. Sixty calls with four
// connects and six calls with four connects are two different problems, and the
// second is not even the same conversation as the first. So the connect ratio
// travels next to the count everywhere, and a short reading is attached to each
// row saying which of those two a person is having.
//
// Only handlers and segment config may be exported from a route file. Every
// helper below is module-local on purpose — one extra export fails the
// production build with an error that does not name the export.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability, can, ROLE_LABELS } from "@/lib/auth";
import { rate } from "@/lib/stats";
import { istDay, IST_OFFSET_MIN } from "@/lib/day";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MS_DAY = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Attendance statuses that mean "not expected on the phones today". A blank row
// under one of these is not a finding; a blank row without one is the finding.
const OFF_STATUSES = new Set(["leave", "holiday", "week-off", "absent"]);

// What a full day on the phones looks like on this desk. Deliberately a
// constant with a name rather than a number buried in a comparison — when the
// desk decides a day is thirty calls and not twenty-five, this is the line that
// changes, and it changes once.
const CALLS_FOR_A_FULL_DAY = 25;
// Below this many calls a connect RATE means nothing. One connect out of two is
// not a 50% day. Same volume floor reasoning as weakestStage() in lib/stats.js.
const RATE_FLOOR = 10;
const POOR_CONNECT_PCT = 25;

const UNASSIGNED = "unassigned";

/**
 * "2026-09-15" → the UTC-midnight Date that labels that IST working day.
 * Null if it is not a real date — 2026-02-31 must be rejected, not quietly
 * rolled into March, because a report for a day that does not exist is a report
 * somebody will read as a real one.
 */
function parseDay(raw) {
  const s = String(raw || "");
  if (!DATE_RE.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(day.getTime())) return null;
  if (day.toISOString().slice(0, 10) !== s) return null;
  return day;
}

function dateString(day) {
  return day.toISOString().slice(0, 10);
}

function blank() {
  return {
    calls: 0,
    connects: 0,
    newCandidates: 0,
    submissions: 0,
    lineUps: 0,
    attended: 0,
    selected: 0,
    joined: 0,
    callbacksDue: 0,
    callbacksKept: 0,
    revenue: 0,
  };
}

/** Everything a person did, as one number, for sorting the idle to the bottom. */
function activityOf(b) {
  return (
    b.calls + b.newCandidates + b.submissions + b.lineUps + b.attended + b.selected + b.joined
  );
}

/**
 * The one-line reading of a person's day. Returned from the server so the page
 * renders a decision rather than making one — and so the thresholds live in
 * exactly one file.
 */
function reading(b, status, activity) {
  const off = status ? OFF_STATUSES.has(status) : false;
  const owed = b.callbacksDue - b.callbacksKept;

  if (activity === 0) {
    if (off) return { flag: "off", note: `Marked ${status}. Nothing logged, which is expected.` };
    if (b.callbacksDue > 0) {
      return {
        flag: "idle",
        note: `Nothing logged all day, and ${b.callbacksDue} ${
          b.callbacksDue === 1 ? "person was" : "people were"
        } promised a call back today.`,
      };
    }
    return { flag: "idle", note: "Nothing logged all day." };
  }
  if (off) {
    return { flag: "check", note: `Marked ${status}, but work is logged against them.` };
  }

  // The distinction the old sheet could never make. Sixty calls reaching four
  // people is a list problem or a calling-hour problem; six calls is neither,
  // and telling the second person to fix their list is how a report stops being
  // read. So volume is judged first, and only a day with real volume behind it
  // gets judged on its ratio.
  const r = rate(b.connects, b.calls);
  if (b.calls >= RATE_FLOOR && r != null && r < POOR_CONNECT_PCT) {
    return {
      flag: "low-connect",
      note: `${b.calls} calls and only ${b.connects} reached. The effort is there; the list or the calling hour is not.`,
    };
  }
  if (b.calls < CALLS_FOR_A_FULL_DAY) {
    return {
      flag: "thin",
      note:
        b.calls === 0
          ? "No calls logged, though other work is on the board."
          : `Only ${b.calls} ${b.calls === 1 ? "call" : "calls"} logged — under half a day on the phones.`,
    };
  }
  if (owed > 0) {
    return {
      flag: "check",
      note: `A full day on the phones, but ${owed} promised call ${
        owed === 1 ? "back was" : "backs were"
      } never made.`,
    };
  }
  return { flag: "ok", note: "" };
}

export async function GET(req) {
  const gate = await requireCapability("report.own");
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);

  // Two permissions, not one. report.desk is seeing the whole desk's WORK;
  // revenue.read is seeing its MONEY. A team_leader holds the first and not the
  // second, which is the entire reason that role exists — so every rupee below
  // is gated on showMoney and never on deskWide.
  const deskWide = can(gate.user.role, "report.desk");
  const showMoney = can(gate.user.role, "revenue.read");

  const today = istDay();
  const asked = url.searchParams.get("date");
  const parsed = asked ? parseDay(asked) : null;
  // A bad date is refused rather than quietly becoming today. A report headed
  // with one date and counted from another is the worst thing this page could
  // do, because it looks exactly like a working report.
  if (asked && !parsed) {
    return NextResponse.json(
      { error: "Date must look like 2026-09-15." },
      { status: 400 }
    );
  }
  const day = parsed || today;

  // istDay() gives the working day's LABEL, at UTC midnight. The IST day itself
  // began five and a half hours before that. Querying timestamps from the label
  // makes the working day run 05:30 IST to 05:30 IST, which loses every call
  // made between midnight and dawn — and night and US-shift work is normal on
  // this desk, so those calls are not a rounding error, they are somebody's
  // whole shift landing on the wrong day.
  const start = new Date(day.getTime() - IST_OFFSET_MIN * 60000);
  const end = new Date(start.getTime() + MS_DAY);
  const inDay = { gte: start, lt: end };

  // A recruiter sees their own row and nothing else. Scoped in the WHERE of
  // every query rather than filtered out afterwards: work that never leaves the
  // database cannot be leaked by a mistake further down.
  const focusId = deskWide ? null : gate.user.id;

  // Eight queries ISSUED TOGETHER, not eight awaited in a row. In parallel this
  // page costs one slow query's worth of time; in series it costs the sum. And
  // it is eight queries for the whole desk, not eight per person — the grouping
  // happens in JavaScript below, over rows we already have.
  const [
    userRows,
    callRows,
    dueRows,
    candidateRows,
    submissionRows,
    interviewRows,
    placementRows,
    attendanceRows,
  ] = await Promise.all([
    // Not filtered to active. Somebody deactivated last week still worked last
    // Tuesday, and a report for last Tuesday that silently drops them is wrong
    // about last Tuesday. Who gets a row is decided below, from the capability.
    prisma.user.findMany({
      where: focusId ? { id: focusId } : {},
      select: { id: true, name: true, role: true, active: true },
      orderBy: { name: "asc" },
    }),

    prisma.candidateCall.findMany({
      where: { calledAt: inDay, ...(focusId ? { userId: focusId } : {}) },
      select: { userId: true, candidateId: true, calledAt: true, outcome: true },
      take: 20000,
    }),

    // The callbacks PROMISED for this day, whoever promised them and whenever
    // they promised. "Did they ring back the people they said they would" is
    // the column the old sheet had and the one nobody could ever fill in
    // honestly, because it needed yesterday's page open next to today's.
    prisma.candidateCall.findMany({
      where: { followUpAt: inDay, ...(focusId ? { userId: focusId } : {}) },
      select: { userId: true, candidateId: true, followUpAt: true },
      take: 20000,
    }),

    prisma.candidate.findMany({
      where: { createdAt: inDay, ...(focusId ? { ownerId: focusId } : {}) },
      select: { ownerId: true },
      take: 20000,
    }),

    prisma.submission.findMany({
      where: { sentAt: inDay, ...(focusId ? { sentById: focusId } : {}) },
      select: { sentById: true },
      take: 20000,
    }),

    // Attributed to the candidate's owner, the same way /api/reports does it —
    // the interview belongs to whoever has been working that person, not to
    // whoever typed the row in.
    prisma.interview.findMany({
      where: {
        scheduledAt: inDay,
        ...(focusId ? { candidate: { is: { ownerId: focusId } } } : {}),
      },
      select: {
        attended: true,
        outcome: true,
        candidate: { select: { ownerId: true } },
      },
      take: 20000,
    }),

    // Joinings, not selections: a selection is a promise and only a joining can
    // be invoiced. The revenue on these rows is the frozen figure from the
    // placement, and it is only ever read out when showMoney is true.
    prisma.placement.findMany({
      where: { joinedOn: inDay, ...(focusId ? { recruiterId: focusId } : {}) },
      select: { recruiterId: true, droppedOn: true, revenue: true },
      take: 5000,
    }),

    // Attendance.day is a DATE column and istDay() is exactly the value stored
    // in it, but a half-open range is used rather than equality so a stray time
    // component from any driver cannot make a marked day look unmarked.
    prisma.attendance.findMany({
      where: {
        day: { gte: day, lt: new Date(day.getTime() + MS_DAY) },
        ...(focusId ? { userId: focusId } : {}),
      },
      select: { userId: true, status: true, checkIn: true, checkOut: true },
      take: 500,
    }),
  ]);

  const users = Array.isArray(userRows) ? userRows : [];
  const calls = Array.isArray(callRows) ? callRows : [];
  const due = Array.isArray(dueRows) ? dueRows : [];
  const candidates = Array.isArray(candidateRows) ? candidateRows : [];
  const submissions = Array.isArray(submissionRows) ? submissionRows : [];
  const interviews = Array.isArray(interviewRows) ? interviewRows : [];
  const placements = Array.isArray(placementRows) ? placementRows : [];
  const attendance = Array.isArray(attendanceRows) ? attendanceRows : [];

  // ── group in JavaScript, over rows we already have ────────────────────────
  const acc = new Map();
  function bucket(id) {
    const key = id || UNASSIGNED;
    if (!acc.has(key)) acc.set(key, blank());
    return acc.get(key);
  }

  for (const c of calls) {
    const b = bucket(c.userId);
    b.calls += 1;
    if (c.outcome === "connected") b.connects += 1;
  }

  for (const c of candidates) bucket(c.ownerId).newCandidates += 1;
  for (const s of submissions) bucket(s.sentById).submissions += 1;

  for (const iv of interviews) {
    const b = bucket(iv.candidate?.ownerId);
    b.lineUps += 1;
    if (iv.attended === true) b.attended += 1;
    if (iv.outcome === "selected") b.selected += 1;
  }

  for (const p of placements) {
    if (p.droppedOn) continue;
    const b = bucket(p.recruiterId);
    b.joined += 1;
    b.revenue += p.revenue || 0;
  }

  // Callbacks. The latest call this person made to this candidate today, so a
  // promise counts as kept only if the ring-back happened AT OR AFTER the hour
  // it was promised for — otherwise the very call that made the promise would
  // count as having kept it.
  const lastCallTo = new Map();
  for (const c of calls) {
    const k = `${c.userId || ""}|${c.candidateId}`;
    const at = new Date(c.calledAt).getTime();
    if (Number.isNaN(at)) continue;
    if (!lastCallTo.has(k) || at > lastCallTo.get(k)) lastCallTo.set(k, at);
  }
  // One promise per person per candidate: two calls yesterday that both set a
  // callback for today are one person to ring, not two owed calls.
  const promises = new Map();
  for (const p of due) {
    const k = `${p.userId || ""}|${p.candidateId}`;
    const at = new Date(p.followUpAt).getTime();
    if (Number.isNaN(at)) continue;
    const held = promises.get(k);
    if (!held || at < held.at) promises.set(k, { at, userId: p.userId });
  }
  for (const [k, p] of promises) {
    const b = bucket(p.userId);
    b.callbacksDue += 1;
    const last = lastCallTo.get(k);
    if (last != null && last >= p.at) b.callbacksKept += 1;
  }

  const attendanceBy = new Map();
  for (const a of attendance) attendanceBy.set(a.userId, a);

  // ── one row per person ────────────────────────────────────────────────────
  const rows = [];
  for (const u of users) {
    const b = acc.get(u.id) || blank();
    const att = attendanceBy.get(u.id) || null;
    const activity = activityOf(b);

    // Whose job is the desk's work, decided by capability and never by
    // comparing role strings: a role string comparison is a permission rule
    // with no home, and it is always the one that gets missed when a role is
    // added. Anyone who does NOT hold report.desk is on the phones, so they get
    // a row every single day — the empty row is the whole point of the sheet.
    // Anyone who does hold it supervises, and appears only when they actually
    // worked or were marked in. So does anyone no longer active.
    const onThePhones = u.active && !can(u.role, "report.desk");
    if (!onThePhones && activity === 0 && b.callbacksDue === 0 && !att) continue;

    const r = reading(b, att?.status || null, activity);
    rows.push({
      id: u.id,
      name: u.name,
      role: u.role,
      roleLabel: ROLE_LABELS[u.role] || u.role,
      active: u.active,
      onThePhones,
      attendance: att ? { status: att.status, checkIn: att.checkIn, checkOut: att.checkOut } : null,
      calls: b.calls,
      connects: b.connects,
      connectRate: rate(b.connects, b.calls),
      newCandidates: b.newCandidates,
      submissions: b.submissions,
      lineUps: b.lineUps,
      attended: b.attended,
      selected: b.selected,
      joined: b.joined,
      callbacksDue: b.callbacksDue,
      callbacksKept: b.callbacksKept,
      activity,
      flag: r.flag,
      note: r.note,
      // Omitted, not zeroed. A zero in a money column reads as "this person
      // earned nothing", which is a different statement from "you may not see
      // what anyone earned".
      ...(showMoney ? { revenue: b.revenue } : {}),
    });
  }

  // Work nobody is named on still has to appear, or the desk total silently
  // disagrees with the rows above it.
  const orphan = acc.get(UNASSIGNED);
  if (orphan && (activityOf(orphan) > 0 || orphan.callbacksDue > 0)) {
    rows.push({
      id: UNASSIGNED,
      name: "Unassigned",
      role: null,
      roleLabel: "Nobody named on the row",
      active: false,
      onThePhones: false,
      attendance: null,
      calls: orphan.calls,
      connects: orphan.connects,
      connectRate: rate(orphan.connects, orphan.calls),
      newCandidates: orphan.newCandidates,
      submissions: orphan.submissions,
      lineUps: orphan.lineUps,
      attended: orphan.attended,
      selected: orphan.selected,
      joined: orphan.joined,
      callbacksDue: orphan.callbacksDue,
      callbacksKept: orphan.callbacksKept,
      activity: activityOf(orphan),
      flag: "check",
      note: "Work with no owner on it. Usually an import, or a candidate nobody has been assigned.",
      ...(showMoney ? { revenue: orphan.revenue } : {}),
    });
  }

  // Busiest first, then alphabetical, and Unassigned last however busy it is.
  rows.sort((a, b) => {
    if (a.id === UNASSIGNED) return 1;
    if (b.id === UNASSIGNED) return -1;
    return b.activity - a.activity || a.name.localeCompare(b.name);
  });

  // Totals summed from the rows themselves, so the last line of the table can
  // never disagree with the lines above it.
  const totals = blank();
  for (const r of rows) {
    totals.calls += r.calls;
    totals.connects += r.connects;
    totals.newCandidates += r.newCandidates;
    totals.submissions += r.submissions;
    totals.lineUps += r.lineUps;
    totals.attended += r.attended;
    totals.selected += r.selected;
    totals.joined += r.joined;
    totals.callbacksDue += r.callbacksDue;
    totals.callbacksKept += r.callbacksKept;
    totals.revenue += r.revenue || 0;
  }

  const nextDay = new Date(day.getTime() + MS_DAY);

  return NextResponse.json({
    date: dateString(day),
    // Stepping is computed on the SERVER, in IST. A day boundary the browser
    // decides is a day boundary the browser's clock can move.
    prevDate: dateString(new Date(day.getTime() - MS_DAY)),
    nextDate: nextDay.getTime() > today.getTime() ? null : dateString(nextDay),
    today: dateString(today),
    isToday: day.getTime() === today.getTime(),
    dateLabel: day.toLocaleDateString("en-IN", {
      weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
    }),
    deskWide,
    showMoney,
    thresholds: {
      fullDayCalls: CALLS_FOR_A_FULL_DAY,
      rateFloor: RATE_FLOOR,
      poorConnectPct: POOR_CONNECT_PCT,
    },
    onDesk: rows.filter((r) => r.id !== UNASSIGNED).length,
    worked: rows.filter((r) => r.id !== UNASSIGNED && r.activity > 0).length,
    rows,
    totals: {
      calls: totals.calls,
      connects: totals.connects,
      connectRate: rate(totals.connects, totals.calls),
      newCandidates: totals.newCandidates,
      submissions: totals.submissions,
      lineUps: totals.lineUps,
      attended: totals.attended,
      selected: totals.selected,
      joined: totals.joined,
      callbacksDue: totals.callbacksDue,
      callbacksKept: totals.callbacksKept,
      ...(showMoney ? { revenue: totals.revenue } : {}),
    },
  });
}
