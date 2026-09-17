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
//
// Base pay is the fixed monthly rule in lib/payroll.js: full salary, less only
// unpaid absence. Locked runs are NEVER recomputed, so months locked before
// that rule came in keep the figures they were locked with, calculated under
// the older hours-ratio rule. That is deliberate — a payslip somebody has
// already been paid from does not get quietly restated.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability, can } from "@/lib/auth";
import { payslip, achiever, employedDaysInMonth } from "@/lib/payroll";
import { monthRange, istMonth } from "@/lib/day";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function computeMonth(month, range) {
  // BC-08: what this month's payroll needs is everyone who WAS EMPLOYED in it,
  // which is not the same question as who can still log in.
  //
  // This used to select `where: { active: true }`. Deactivate a leaver on their
  // last day — exactly what a manager does — and they vanished from the
  // unlocked month they had actually worked, silently, with no row and no
  // warning. That is the most direct way for a real person not to get paid.
  //
  // `active` belongs on the roster screen. Here, eligibility is "has payable
  // records overlapping this month": attendance, a placement that joined, or an
  // already-locked payroll item. Deactivating someone now removes them from
  // NEXT month, once they have stopped generating records, which is what
  // deactivating is supposed to mean.
  const [structures, rules, attendance, placements, priorItems] = await Promise.all([
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
    prisma.payrollItem.findMany({
      where: { run: { month } },
      select: { userId: true },
    }),
  ]);

  const involved = new Set();
  for (const a of attendance) involved.add(a.userId);
  for (const p of placements) if (p.recruiterId) involved.add(p.recruiterId);
  for (const i of priorItems) involved.add(i.userId);

  const users = await prisma.user.findMany({
    where: { OR: [{ active: true }, { id: { in: [...involved] } }] },
    // joinedOn and leftOn are what payslip() pro-rates a part month from. Left
    // out of this select, they arrive undefined and every joiner is quietly
    // paid a full month — the failure is silent and in the employer's favour,
    // which is the worst shape a payroll bug can have.
    select: {
      id: true, name: true, role: true, email: true, active: true,
      joinedOn: true, leftOn: true,
    },
    orderBy: { name: "asc" },
  });

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

  return users.filter((u) => {
    // Somebody who joined after this month ended, or left before it began, has
    // no payslip for it. They would otherwise appear with a zero and look like
    // an unpaid employee rather than one who simply was not here.
    return employedDaysInMonth(month, { joinedOn: u.joinedOn, leftOn: u.leftOn }) > 0;
  }).map((u) => {
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
      // Present so the screen can mark a leaver rather than quietly listing
      // them as if they were still on the desk.
      activeUser: u.active,
      hasStructure: !!structure,
      ruleName: rule?.name || null,
      // Said plainly rather than shown as ₹0, which reads as "earned nothing".
      blocker: !structure ? "No salary set for this person." : null,
    };
  });
}

/** Strip revenue from the achiever block for anyone who may not see it. */
function hideRevenue(ach, seesDesk) {
  if (!ach || seesDesk) return ach;
  return {
    ...ach,
    revenue: null,
    runnerUp: ach.runnerUp ? { ...ach.runnerUp, revenue: null } : null,
  };
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
      // BC-07: these two were hardcoded 0 / false, because PayrollItem had no
      // column for them. The effect was that a forgotten check-out was paid as
      // zero hours AND the locked screen then asserted the month was clean —
      // the warning vanished at the exact moment it became unfixable. They are
      // persisted at lock time now, so the locked view keeps telling the truth.
      incompleteDays: i.incompleteDays,
      needsAttention: i.needsAttention,
      overtimeHours: 0,
      earnedBasic: i.earnedBasic,
      // Unpaid days as frozen. Older runs locked under the superseded
      // hours-ratio rule have no unpaid-day concept; absentDays is what was
      // stored and it is reported as-is, never recomputed.
      unpaidDays: i.absentDays,
      incentive: i.incentive,
      incentiveBasis: i.incentiveBasis,
      joinings: i.joinings,
      revenue: i.revenue,
      deductions: i.deductions,
      netPay: i.netPay,
      // Every figure on a locked row is a stored copy. The screen says so
      // rather than implying these were recalculated under today's rule.
      frozen: true,
      payBasis: "Frozen at lock time — not recalculated.",
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
    // The achiever board is desk-wide on purpose — it is meant to be seen, and
    // it is ranked on JOININGS, which is the achievement.
    //
    // Revenue per named colleague is a different thing, and it was leaking:
    // this board is served to everyone, so a recruiter could read every
    // colleague's monthly billing out of it — precisely the desk-wide revenue
    // that revenue.read exists to keep to owners and managers. Ranking still
    // uses revenue to break ties server-side; the figure is only sent to
    // someone entitled to see it.
    achiever: hideRevenue(
      achiever(rows.map((r) => ({ userId: r.userId, name: r.name, joinings: r.joinings, revenue: r.revenue }))),
      seesDesk
    ),
    board: rows
      .map((r) => ({ userId: r.userId, name: r.name, joinings: r.joinings, revenue: r.revenue }))
      .filter((r) => r.joinings > 0 || r.revenue > 0)
      .sort((a, b) => b.joinings - a.joinings || b.revenue - a.revenue)
      .map((r) => (seesDesk || r.userId === user.id ? r : { ...r, revenue: null })),
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
          confirmKey: "confirmEarly",
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
        confirmKey: "confirmMissing",
        missing: missing.map((m) => m.name),
      },
      { status: 409 }
    );
  }

  // BC-07: the warning that locking used to hide from itself.
  //
  // needsAttention has always been computed and shown on screen, and the lock
  // endpoint has never once looked at it. A month with forgotten check-outs
  // could be locked without a word, and the locked screen then reported the
  // month as clean. Unresolved attendance now blocks the lock, and overriding
  // it takes a written reason that is stored on the run and in the audit log —
  // if a month is going to be locked dirty, it will at least say who decided
  // that and why.
  const unresolved = rows.filter((r) => r.needsAttention && !r.blocker);
  const overrideReason = String(b.overrideReason || "").trim();
  if (unresolved.length && !b.confirmIncomplete) {
    const totalDays = unresolved.reduce((s, r) => s + (r.incompleteDays || 0), 0);
    return NextResponse.json(
      {
        error: `${unresolved.length} ${unresolved.length === 1 ? "person has" : "people have"} attendance that is not resolved (${totalDays} day${totalDays === 1 ? "" : "s"} with missing times): ${unresolved.map((m) => m.name).join(", ")}. Fix those days, or give a reason for locking the month anyway.`,
        needsConfirmation: true,
        confirmKey: "confirmIncomplete",
        needsReason: true,
        unresolved: unresolved.map((m) => ({ name: m.name, incompleteDays: m.incompleteDays })),
      },
      { status: 409 }
    );
  }
  if (unresolved.length && b.confirmIncomplete && overrideReason.length < 10) {
    return NextResponse.json(
      {
        error: "Locking a month with unresolved attendance needs a reason — a few words about why these days are being left as they are.",
        needsConfirmation: true,
        confirmKey: "confirmIncomplete",
        needsReason: true,
      },
      { status: 409 }
    );
  }

  const deductions = b.deductions && typeof b.deductions === "object" ? b.deductions : {};

  // The override is part of the permanent record of the run, not a transient
  // click. It goes on the run note so it is visible next to the figures.
  const overrideNote = unresolved.length
    ? `Locked with ${unresolved.length} unresolved attendance row(s). Reason: ${overrideReason}`
    : null;
  const runNote = [b.note || null, overrideNote].filter(Boolean).join(" — ") || null;

  const run = await prisma.$transaction(async (tx) => {
    const r = existing
      ? await tx.payrollRun.update({
          where: { id: existing.id },
          data: { status: "locked", lockedAt: new Date(), lockedById: user.id, note: runNote },
        })
      : await tx.payrollRun.create({
          data: { month, status: "locked", lockedAt: new Date(), lockedById: user.id, note: runNote },
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
          // BC-07: frozen with the rest of the row, so the locked view can say
          // what was wrong with the month instead of asserting it was clean.
          incompleteDays: row.incompleteDays,
          needsAttention: row.needsAttention,
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
    data: {
      userId: user.id,
      action: "update",
      entity: "PayrollRun",
      entityId: run.id,
      summary: unresolved.length
        ? `${month} locked with ${unresolved.length} unresolved attendance row(s) — ${overrideReason}`
        : `${month} locked`,
    },
  }).catch(() => {});

  return NextResponse.json({
    message: unresolved.length
      ? `${month} locked with ${unresolved.length} unresolved row(s); the reason is on the run. The figures will not move again.`
      : `${month} locked. The figures will not move again.`,
    status: "locked",
  });
}
