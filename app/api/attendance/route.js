// /api/attendance — who is in today, and who was in last month.
//
// The day is computed on the SERVER, in IST, from the server clock. It is never
// taken from the browser. A check-in whose date comes from the device is a
// check-in anyone can change by changing their laptop clock, and the first
// person to work that out gets paid for a month they did not work.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability, can } from "@/lib/auth";
import { hoursWorked, summariseAttendance, MAX_SHIFT_HOURS } from "@/lib/payroll";
import { istDay, istMonth, monthRange, timeLabel } from "@/lib/day";

// Only handlers and segment config may be exported from a route file.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DAY_MS = 86400000;

/**
 * The locked-month guard, in one place.
 *
 * BC-09: this check used to live only in the manager branch, physically below
 * the self check-in/out branch, which returns before ever reaching it. So a
 * manager was blocked from touching a locked month and the employee was not —
 * the person whose pay it is could still change the attendance behind a payslip
 * that had already been issued. It is now called for every attendance write,
 * against the month of the row actually being modified (which, for an overnight
 * check-out, may be last month).
 */
async function lockedMonth(month) {
  const run = await prisma.payrollRun.findUnique({ where: { month } });
  return run && run.status !== "draft" ? run : null;
}

function lockedResponse(month, run) {
  return NextResponse.json(
    { error: `${month} payroll is ${run.status}. Reopen it before changing attendance for that month.` },
    { status: 409 }
  );
}

/** "2026-09" for a UTC-midnight day Date. */
function monthOf(day) {
  return `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function GET(req) {
  const gate = await requireCapability("attendance.own");
  if (!gate.ok) return gate.response;
  const { user } = gate;

  const url = new URL(req.url);
  const month = url.searchParams.get("month") || istMonth();
  const range = monthRange(month);
  if (!range) return NextResponse.json({ error: "Month must look like 2026-09." }, { status: 400 });

  const seesDesk = can(user.role, "attendance.desk");
  const askedUserId = url.searchParams.get("userId");
  // A recruiter asking for someone else's month gets their own, not a 403.
  // Silently scoping down is wrong; 403 on a screen they can legitimately open
  // is confusing. So: scope down AND say so in the payload.
  const scopedToSelf = !seesDesk || askedUserId === user.id;
  const userId = scopedToSelf ? user.id : askedUserId || undefined;

  const [rows, structures] = await Promise.all([
    prisma.attendance.findMany({
      where: { day: { gte: range.from, lt: range.to }, ...(userId ? { userId } : {}) },
      orderBy: [{ day: "asc" }],
      include: { user: { select: { id: true, name: true, role: true } } },
    }),
    // Needed for the totals below. A person on a 9-hour shift gets a 9-hour
    // credit for a day of approved leave; assuming 8 for everyone here would
    // make this screen disagree with the payroll screen about the same month,
    // and two screens showing different hours is worse than one showing none.
    prisma.salaryStructure.findMany({
      where: { effectiveFrom: { lt: range.to } },
      orderBy: { effectiveFrom: "asc" },
      select: { userId: true, standardHoursPerDay: true },
    }),
  ]);

  const hoursPerDay = new Map();
  for (const st of structures) hoursPerDay.set(st.userId, st.standardHoursPerDay); // ascending, last wins

  const withHours = rows.map((r) => ({
    ...r,
    hours: hoursWorked(r.checkIn, r.checkOut),
    // Named so the screen can say what is wrong rather than showing a blank.
    incomplete: !!r.checkIn && !r.checkOut,
  }));

  // Per-person totals, so the screen does not recompute them in the browser
  // and get a different answer from the payroll screen.
  const byUser = new Map();
  for (const r of withHours) {
    if (!byUser.has(r.userId)) byUser.set(r.userId, { user: r.user, rows: [] });
    byUser.get(r.userId).rows.push(r);
  }
  const people = [...byUser.values()].map((p) => ({
    user: p.user,
    ...summariseAttendance(p.rows, { standardHoursPerDay: hoursPerDay.get(p.user.id) ?? 8 }),
  })).sort((a, b) => a.user.name.localeCompare(b.user.name));

  const today = istDay();
  const mine = withHours.find((r) => r.userId === user.id && r.day.getTime() === today.getTime()) || null;

  // The open shift this person can still close, which is NOT always today's
  // row: a night shift started yesterday at 23:00 is closed after midnight.
  // Queried outside the month filter on purpose — on the 1st, the shift being
  // closed belongs to last month. Without this the Check out button stays
  // disabled and the API fix for the overnight case is unreachable.
  const yesterday = new Date(today.getTime() - DAY_MS);
  const openRow = await prisma.attendance.findFirst({
    where: {
      userId: user.id,
      day: { in: [today, yesterday] },
      checkIn: { not: null },
      checkOut: null,
    },
    orderBy: { day: "desc" },
  });

  let openShift = null;
  if (openRow) {
    const elapsed = (Date.now() - new Date(openRow.checkIn).getTime()) / 3600000;
    openShift = {
      day: openRow.day.toISOString().slice(0, 10),
      checkIn: openRow.checkIn,
      fromPreviousDay: openRow.day.getTime() !== today.getTime(),
      hoursOpen: Math.round(elapsed * 10) / 10,
      // Past the bound it is a forgotten check-out, and the person needs a
      // manager rather than a button that will refuse them.
      canCheckOut: elapsed <= MAX_SHIFT_HOURS,
    };
  }

  return NextResponse.json({
    month,
    rows: withHours,
    people,
    scopedToSelf,
    seesDesk,
    canEdit: can(user.role, "attendance.edit"),
    today: today.toISOString().slice(0, 10),
    mine,
    openShift,
    maxShiftHours: MAX_SHIFT_HOURS,
    me: user.id,
  });
}

/**
 * Check in, check out, or (for a manager) mark someone's day.
 *
 * body: { action: "in" | "out" }                      — the person themselves
 *       { userId, day, status, checkIn, checkOut, note } — a manager correcting
 */
export async function POST(req) {
  const gate = await requireCapability("attendance.own");
  if (!gate.ok) return gate.response;
  const { user } = gate;

  const b = await req.json().catch(() => ({}));

  // ── the person's own tap ──────────────────────────────────────────────────
  if (b.action === "in" || b.action === "out") {
    const day = istDay();
    const now = new Date();
    const today = await prisma.attendance.findUnique({
      where: { userId_day: { userId: user.id, day } },
    });

    if (b.action === "in") {
      const run = await lockedMonth(monthOf(day));
      if (run) return lockedResponse(monthOf(day), run);

      if (today?.checkIn) {
        return NextResponse.json(
          { error: `You already checked in at ${timeLabel(today.checkIn)}.`, row: today },
          { status: 409 }
        );
      }
      const row = today
        ? await prisma.attendance.update({
            where: { id: today.id },
            data: { checkIn: now, status: "present" },
          })
        : await prisma.attendance.create({
            data: { userId: user.id, day, checkIn: now, status: "present", source: "self" },
          });
      return NextResponse.json({ row, message: `Checked in at ${timeLabel(now)}.` });
    }

    // ── checking out ────────────────────────────────────────────────────────
    //
    // BC-09: a check-out used to resolve against istDay() alone. Attendance is
    // unique on (userId, day), so a shift that starts at 23:00 and ends at
    // 01:00 looked up the NEW date, found nothing, and told the person "You
    // have not checked in today" — leaving the previous day permanently
    // incomplete at zero hours. On a desk that runs night shifts that is not an
    // edge case, it is most of the week.
    //
    // So: prefer an open check-in on today's row; otherwise fall back to
    // yesterday's row if it is still open and the shift is within the same
    // 16-hour bound that hoursWorked uses. Anything longer is a forgotten
    // check-out and is left to a manager correction rather than guessed at.
    const yesterday = new Date(day.getTime() - DAY_MS);
    let target = null;
    let targetDay = day;

    if (today?.checkIn && !today.checkOut) {
      target = today;
    } else {
      const prior = await prisma.attendance.findUnique({
        where: { userId_day: { userId: user.id, day: yesterday } },
      });
      if (prior?.checkIn && !prior.checkOut) {
        const elapsed = (now.getTime() - new Date(prior.checkIn).getTime()) / 3600000;
        if (elapsed <= MAX_SHIFT_HOURS) {
          target = prior;
          targetDay = yesterday;
        } else {
          // Say what is actually wrong. "You have not checked in today" sends
          // people to a manager with the wrong problem.
          return NextResponse.json(
            {
              error: `Your check-in from ${yesterday.toISOString().slice(0, 10)} at ${timeLabel(prior.checkIn)} was never closed and is now more than ${MAX_SHIFT_HOURS} hours ago. A manager needs to correct that day.`,
            },
            { status: 409 }
          );
        }
      }
    }

    if (!target) {
      if (today?.checkOut) {
        return NextResponse.json(
          { error: `You already checked out at ${timeLabel(today.checkOut)}.`, row: today },
          { status: 409 }
        );
      }
      return NextResponse.json({ error: "You have not checked in today." }, { status: 400 });
    }

    // The guard, applied to the month of the row being written — for an
    // overnight shift on the 1st, that is last month, and last month is exactly
    // the one likely to be locked.
    const month = monthOf(targetDay);
    const run = await lockedMonth(month);
    if (run) return lockedResponse(month, run);

    const row = await prisma.attendance.update({
      where: { id: target.id },
      data: { checkOut: now },
    });
    const h = hoursWorked(row.checkIn, row.checkOut);
    const overnight = targetDay.getTime() !== day.getTime();
    return NextResponse.json({
      row,
      message: h == null
        ? `Checked out — but that is more than ${MAX_SHIFT_HOURS} hours, so the day needs a manager to correct it.`
        : overnight
        ? `Checked out at ${timeLabel(now)} — ${h} hours on ${targetDay.toISOString().slice(0, 10)}.`
        : `Checked out at ${timeLabel(now)} — ${h} hours.`,
    });
  }

  // ── a manager marking or correcting someone ──────────────────────────────
  if (!can(user.role, "attendance.edit")) {
    return NextResponse.json({ error: "Only a manager can change someone's attendance." }, { status: 403 });
  }

  const targetId = String(b.userId || "").trim();
  if (!targetId) return NextResponse.json({ error: "Which person?" }, { status: 400 });

  const dayStr = String(b.day || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayStr)) {
    return NextResponse.json({ error: "Day must look like 2026-09-12." }, { status: 400 });
  }
  const day = new Date(`${dayStr}T00:00:00.000Z`);
  if (Number.isNaN(day.getTime())) return NextResponse.json({ error: "That is not a real date." }, { status: 400 });
  if (day > istDay()) {
    // Marking tomorrow present is how a month gets paid before it is worked.
    return NextResponse.json({ error: "You cannot mark attendance for a day that has not happened." }, { status: 400 });
  }

  // "unpaid-leave" is explicit rather than implied. Under the fixed-monthly
  // rule the only statuses that cost anyone money are the ones somebody
  // deliberately chose, so leave that is NOT paid has to be sayable — otherwise
  // it gets recorded as "leave" (paid) or as "absent" (which reads as
  // unauthorised on the sheet, and means something different in a dispute).
  const STATUSES = ["present", "leave", "holiday", "week-off", "absent", "unpaid-leave", "half-day"];
  const status = String(b.status || "present");
  if (!STATUSES.includes(status)) {
    return NextResponse.json({ error: `Status must be one of: ${STATUSES.join(", ")}` }, { status: 400 });
  }

  const checkIn = b.checkIn ? new Date(b.checkIn) : null;
  const checkOut = b.checkOut ? new Date(b.checkOut) : null;
  if (checkIn && Number.isNaN(checkIn.getTime())) return NextResponse.json({ error: "Check-in time is not readable." }, { status: 400 });
  if (checkOut && Number.isNaN(checkOut.getTime())) return NextResponse.json({ error: "Check-out time is not readable." }, { status: 400 });
  if (checkIn && checkOut && checkOut <= checkIn) {
    return NextResponse.json({ error: "Check-out must be after check-in." }, { status: 400 });
  }

  // A month that has been locked is a month that has been paid. Changing its
  // attendance afterwards makes the payslip and the sheet disagree, and the
  // payslip is the one the person is holding. Same guard the self branch above
  // now runs — one rule, both paths.
  const month = dayStr.slice(0, 7);
  const run = await lockedMonth(month);
  if (run) return lockedResponse(month, run);

  const data = {
    status,
    checkIn,
    checkOut,
    note: String(b.note || "").trim() || null,
    markedById: user.id,
    source: "manager",
  };

  const row = await prisma.attendance.upsert({
    where: { userId_day: { userId: targetId, day } },
    create: { userId: targetId, day, ...data },
    update: data,
  });

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "update",
      entity: "Attendance",
      entityId: row.id,
      summary: `${dayStr} marked ${status}`,
    },
  }).catch(() => {});

  return NextResponse.json({ row, message: `${dayStr} saved as ${status}.` });
}
