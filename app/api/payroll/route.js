// /api/payroll — what everyone is owed this month.
//
// Two states and the difference matters:
//
//   DRAFT   — nothing is stored. Every figure is recomputed from attendance,
//             the salary structure in force, and the placements that joined.
//             Correct a check-out and the number moves. That is the point.
//
//   LOCKED  — the figures are COPIED into PayrollItem rows and stop moving.
//             A payslip that changes after someone has been paid from it is not
//             a payslip, it is an argument.
//
// Revenue is attributed to the month the candidate JOINED, not the month they
// were selected. A selection is a promise; a joining is money. Paying incentive
// on selections means paying for candidates who never turned up.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability, can } from "@/lib/auth";
import { payslip, achiever } from "@/lib/payroll";
import { monthRange, istMonth } from "@/lib/day";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function computeMonth(month, range) {
  const [users, structures, rules, attendance, placements] = await Promise.all([
    prisma.user.findMany({
      where: { active: true },
      select: { id: true, name: true, role: true, email: true },
      orderBy: { name: "asc" },
    }),
    // Every structure effective on or before the END of the month. The one in
    // force is the latest of those — a raise dated mid-month applies to the
    // whole month, which is the simple rule and the one people expect.
    prisma.salaryStructure.findMany({
      where: { effectiveFrom: { lt: range.to } },
      orderBy: { effectiveFrom: "asc" },
    }),
    prisma.incentiveRule.findMany({ where: { active: true } }),
    prisma.attendance.findMany({
      where: { day: { gte: range.from, lt: range.to } },
      orderBy: { day: "asc" },
    }),
    prisma.placement.findMany({
      where: { joinedOn: { gte: range.from, lt: range.to }, droppedOn: null },
      select: { recruiterId: true, revenue: true },
    }),
  ]);

  const structureFor = new Map();
  for (const s of structures) structureFor.set(s.userId, s); // ascending, so last wins

  const deskRule = rules.find((r) => !r.userId) || null;
  const ruleFor = new Map();
  for (const r of rules) if (r.userId) ruleFor.set(r.userId, r);

  const attFor = new Map();
  for (const a of attendance) {
    if (!attFor.has(a.userId)) attFor.set(a.userId, []);
    attFor.get(a.userId).push(a);
  }

  const perfFor = new Map();
  for (const p of placements) {
    const cur = perfFor.get(p.recruiterId) || { joinings: 0, revenue: 0 };
    cur.joinings += 1;
    cur.revenue += p.revenue || 0;
    perfFor.set(p.recruiterId, cur);
  }

  return users.map((u) => {
    const structure = structureFor.get(u.id) || null;
    const perf = perfFor.get(u.id) || { joinings: 0, revenue: 0 };
    const raw = ruleFor.get(u.id) || deskRule;
    const rule = raw ? { ...raw, slabs: safeSlabs(raw.slabsJson) } : null;

    const slip = payslip({
      user: u,
      structure,
      attendance: attFor.get(u.id) || [],
      joinings: perf.joinings,
      revenue: perf.revenue,
      incentiveRule: rule,
      deductions: 0,
      month,
    });

    return {
      ...slip,
      role: u.role,
      hasStructure: !!structure,
      ruleName: rule?.name || null,
      // Said plainly rather than shown as ₹0, which reads as "earned nothing".
      blocker: !structure ? "No salary set for this person." : null,
    };
  });
}

function safeSlabs(json) {
  try {
    const v = JSON.parse(json || "[]");
    return Array.isArray(v) ? v.filter((s) => Number.isFinite(s?.min) && Number.isFinite(s?.amount)) : [];
  } catch {
    return [];
  }
}

export async function GET(req) {
  const gate = await requireCapability("payroll.own");
  if (!gate.ok) return gate.response;
  const { user } = gate;

  const url = new URL(req.url);
  const month = url.searchParams.get("month") || istMonth();
  const range = monthRange(month);
  if (!range) return NextResponse.json({ error: "Month must look like 2026-09." }, { status: 400 });

  const run = await prisma.payrollRun.findUnique({
    where: { month },
    include: { items: { include: { user: { select: { id: true, name: true, role: true } } } } },
  });

  const locked = run && run.status !== "draft";

  let rows;
  if (locked) {
    // Locked: read the frozen rows. Never recompute — recomputing a locked
    // month is how the screen and the payslip in someone's hand disagree.
    rows = run.items.map((i) => ({
      userId: i.userId,
      name: i.user?.name,
      role: i.user?.role,
      month,
      monthlyGross: i.monthlyGross,
      standardHours: i.standardHours,
      workedHours: i.workedHours,
      presentDays: i.presentDays,
      paidLeaveDays: i.paidLeaveDays,
      absentDays: i.absentDays,
      incompleteDays: 0,
      overtimeHours: 0,
      earnedBasic: i.earnedBasic,
      proRataPct: i.standardHours ? Math.round(Math.min(i.workedHours / i.standardHours, 1) * 1000) / 10 : 0,
      incentive: i.incentive,
      incentiveBasis: i.incentiveBasis,
      joinings: i.joinings,
      revenue: i.revenue,
      deductions: i.deductions,
      netPay: i.netPay,
      needsAttention: false,
      hasStructure: true,
      blocker: null,
    }));
  } else {
    rows = await computeMonth(month, range);
  }

  const seesDesk = can(user.role, "payroll.read");
  const visible = seesDesk ? rows : rows.filter((r) => r.userId === user.id);

  return NextResponse.json({
    month,
    status: run?.status || "draft",
    lockedAt: run?.lockedAt || null,
    paidOn: run?.paidOn || null,
    rows: visible,
    // The achiever board is desk-wide by design — it is meant to be seen. But
    // it carries joinings and revenue, not pay, so a recruiter seeing it does
    // not learn anyone's salary.
    achiever: achiever(rows.map((r) => ({ userId: r.userId, name: r.name, joinings: r.joinings, revenue: r.revenue }))),
    board: rows
      .map((r) => ({ userId: r.userId, name: r.name, joinings: r.joinings, revenue: r.revenue }))
      .filter((r) => r.joinings > 0 || r.revenue > 0)
      .sort((a, b) => b.joinings - a.joinings || b.revenue - a.revenue),
    totals: seesDesk
      ? {
          people: visible.length,
          basic: visible.reduce((s, r) => s + r.earnedBasic, 0),
          incentive: visible.reduce((s, r) => s + r.incentive, 0),
          net: visible.reduce((s, r) => s + r.netPay, 0),
          needsAttention: visible.filter((r) => r.needsAttention || r.blocker).length,
        }
      : null,
    seesDesk,
    canLock: can(user.role, "payroll.write"),
    me: user.id,
  });
}

/**
 * body: { month, action: "lock" | "reopen" | "paid", deductions?: { userId: rupees } }
 */
export async function POST(req) {
  const gate = await requireCapability("payroll.write");
  if (!gate.ok) return gate.response;
  const { user } = gate;

  const b = await req.json().catch(() => ({}));
  const month = String(b.month || "").trim();
  const range = monthRange(month);
  if (!range) return NextResponse.json({ error: "Month must look like 2026-09." }, { status: 400 });

  const action = String(b.action || "");
  const existing = await prisma.payrollRun.findUnique({ where: { month } });

  if (action === "reopen") {
    if (!existing || existing.status === "draft") {
      return NextResponse.json({ error: "That month is already open." }, { status: 400 });
    }
    if (existing.status === "paid") {
      return NextResponse.json(
        { error: "That month is marked paid. Reopening a paid month would change payslips people already have — record a correction in next month instead." },
        { status: 409 }
      );
    }
    await prisma.$transaction([
      prisma.payrollItem.deleteMany({ where: { runId: existing.id } }),
      prisma.payrollRun.update({
        where: { id: existing.id },
        data: { status: "draft", lockedAt: null, lockedById: null },
      }),
    ]);
    return NextResponse.json({ message: `${month} reopened. The figures are live again.` });
  }

  if (action === "paid") {
    if (!existing || existing.status !== "locked") {
      return NextResponse.json({ error: "Lock the month before marking it paid." }, { status: 400 });
    }
    await prisma.payrollRun.update({
      where: { id: existing.id },
      data: { status: "paid", paidOn: new Date() },
    });
    return NextResponse.json({ message: `${month} marked paid.` });
  }

  if (action !== "lock") return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  if (existing && existing.status !== "draft") {
    return NextResponse.json({ error: `${month} is already ${existing.status}.` }, { status: 409 });
  }

  // Locking a month that is not over yet freezes a partial month as if it were
  // a whole one. Nobody means to do this, and it is invisible afterwards.
  if (new Date() < range.to) {
    if (!b.confirmEarly) {
      return NextResponse.json(
        {
          error: `${month} has not finished yet. Locking now freezes the figures as they stand today.`,
          needsConfirmation: true,
        },
        { status: 409 }
      );
    }
  }

  const rows = await computeMonth(month, range);
  const missing = rows.filter((r) => r.blocker);
  if (missing.length && !b.confirmMissing) {
    return NextResponse.json(
      {
        error: `${missing.length} ${missing.length === 1 ? "person has" : "people have"} no salary set: ${missing.map((m) => m.name).join(", ")}. They would be locked in at zero.`,
        needsConfirmation: true,
        missing: missing.map((m) => m.name),
      },
      { status: 409 }
    );
  }

  const deductions = b.deductions && typeof b.deductions === "object" ? b.deductions : {};

  const run = await prisma.$transaction(async (tx) => {
    const r = existing
      ? await tx.payrollRun.update({
          where: { id: existing.id },
          data: { status: "locked", lockedAt: new Date(), lockedById: user.id, note: b.note || null },
        })
      : await tx.payrollRun.create({
          data: { month, status: "locked", lockedAt: new Date(), lockedById: user.id, note: b.note || null },
        });

    await tx.payrollItem.deleteMany({ where: { runId: r.id } });

    for (const row of rows) {
      const ded = Math.max(0, Math.round(Number(deductions[row.userId]) || 0));
      await tx.payrollItem.create({
        data: {
          runId: r.id,
          userId: row.userId,
          monthlyGross: row.monthlyGross,
          standardHours: row.standardHours,
          workedHours: row.workedHours,
          presentDays: row.presentDays,
          paidLeaveDays: row.paidLeaveDays,
          absentDays: row.absentDays,
          earnedBasic: row.earnedBasic,
          incentive: row.incentive,
          incentiveBasis: row.incentiveBasis,
          joinings: row.joinings,
          revenue: row.revenue,
          deductions: ded,
          netPay: Math.max(0, row.earnedBasic + row.incentive - ded),
        },
      });
    }
    return r;
  });

  await prisma.auditLog.create({
    data: { userId: user.id, action: "update", entity: "PayrollRun", entityId: run.id, summary: `${month} locked` },
  }).catch(() => {});

  return NextResponse.json({ message: `${month} locked. The figures will not move again.`, status: "locked" });
}
