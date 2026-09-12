// /api/attendance — who is in today, and who was in last month.
//
// The day is computed on the SERVER, in IST, from the server clock. It is never
// taken from the browser. A check-in whose date comes from the device is a
// check-in anyone can change by changing their laptop clock, and the first
// person to work that out gets paid for a month they did not work.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability, can } from "@/lib/auth";
import { hoursWorked, summariseAttendance } from "@/lib/payroll";
import { istDay, istMonth, monthRange, timeLabel } from "@/lib/day";

// Only handlers and segment config may be exported from a route file.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  return NextResponse.json({
    month,
    rows: withHours,
    people,
    scopedToSelf,
    seesDesk,
    canEdit: can(user.role, "attendance.edit"),
    today: today.toISOString().slice(0, 10),
    mine,
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
    const existing = await prisma.attendance.findUnique({
      where: { userId_day: { userId: user.id, day } },
    });

    if (b.action === "in") {
      if (existing?.checkIn) {
        return NextResponse.json(
          { error: `You already checked in at ${timeLabel(existing.checkIn)}.`, row: existing },
          { status: 409 }
        );
      }
      const row = existing
        ? await prisma.attendance.update({
            where: { id: existing.id },
            data: { checkIn: now, status: "present" },
          })
        : await prisma.attendance.create({
            data: { userId: user.id, day, checkIn: now, status: "present", source: "self" },
          });
      return NextResponse.json({ row, message: `Checked in at ${timeLabel(now)}.` });
    }

    if (!existing?.checkIn) {
      return NextResponse.json({ error: "You have not checked in today." }, { status: 400 });
    }
    if (existing.checkOut) {
      return NextResponse.json(
        { error: `You already checked out at ${timeLabel(existing.checkOut)}.`, row: existing },
        { status: 409 }
      );
    }
    const row = await prisma.attendance.update({
      where: { id: existing.id },
      data: { checkOut: now },
    });
    const h = hoursWorked(row.checkIn, row.checkOut);
    return NextResponse.json({
      row,
      message: h == null
        ? "Checked out — but that is more than 16 hours, so the day needs a manager to correct it."
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

  const STATUSES = ["present", "leave", "holiday", "week-off", "absent", "half-day"];
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
  // payslip is the one the person is holding.
  const month = dayStr.slice(0, 7);
  const run = await prisma.payrollRun.findUnique({ where: { month } });
  if (run && run.status !== "draft") {
    return NextResponse.json(
      { error: `${month} payroll is ${run.status}. Reopen it before changing attendance for that month.` },
      { status: 409 }
    );
  }

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
