// /api/payroll/salary — what each person is paid, and from when.
//
// A salary is never edited. A change writes a NEW row with a new effective
// date, and the old row stays. That is not bureaucracy: it is the only way to
// re-open March and get March's numbers back after somebody got a raise in
// April. An UPDATE here would silently rewrite history, and the history is
// what people are paid from.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/auth";
import { standardMonthHours } from "@/lib/payroll";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireCapability("payroll.read");
  if (!gate.ok) return gate.response;

  const [users, structures] = await Promise.all([
    prisma.user.findMany({
      where: { active: true },
      select: { id: true, name: true, role: true },
      orderBy: { name: "asc" },
    }),
    prisma.salaryStructure.findMany({ orderBy: { effectiveFrom: "desc" } }),
  ]);

  const byUser = new Map();
  for (const s of structures) {
    if (!byUser.has(s.userId)) byUser.set(s.userId, []);
    byUser.get(s.userId).push(s);
  }

  return NextResponse.json({
    people: users.map((u) => {
      const history = byUser.get(u.id) || [];
      const current = history[0] || null;
      return {
        user: u,
        current: current
          ? { ...current, standardMonthHours: standardMonthHours(current) }
          : null,
        history,
      };
    }),
    canWrite: (await requireCapability("salary.write")).ok,
  });
}

export async function POST(req) {
  const gate = await requireCapability("salary.write");
  if (!gate.ok) return gate.response;
  const { user } = gate;

  const b = await req.json().catch(() => ({}));
  const userId = String(b.userId || "").trim();
  if (!userId) return NextResponse.json({ error: "Which person?" }, { status: 400 });

  const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true } });
  if (!target) return NextResponse.json({ error: "That person does not exist." }, { status: 404 });

  const monthlyGross = Math.round(Number(b.monthlyGross));
  if (!Number.isFinite(monthlyGross) || monthlyGross <= 0) {
    return NextResponse.json({ error: "Enter a monthly gross salary in rupees." }, { status: 400 });
  }
  // Not a rule, a typo guard. ₹2,00,00,000 a month on a recruitment desk is a
  // missing decimal point, and it would lock into a payroll run unnoticed.
  if (monthlyGross > 2000000) {
    return NextResponse.json(
      { error: `₹${monthlyGross.toLocaleString("en-IN")} a month looks like a typo — check the zeros.` },
      { status: 400 }
    );
  }

  const hpd = Math.round(Number(b.standardHoursPerDay ?? 8));
  const dpw = Math.round(Number(b.workingDaysPerWeek ?? 6));
  if (!(hpd >= 1 && hpd <= 12)) return NextResponse.json({ error: "Hours per day must be between 1 and 12." }, { status: 400 });
  if (!(dpw >= 1 && dpw <= 7)) return NextResponse.json({ error: "Working days per week must be between 1 and 7." }, { status: 400 });

  const fromStr = String(b.effectiveFrom || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromStr)) {
    return NextResponse.json({ error: "Effective from must look like 2026-09-01." }, { status: 400 });
  }
  const effectiveFrom = new Date(`${fromStr}T00:00:00.000Z`);
  if (Number.isNaN(effectiveFrom.getTime())) {
    return NextResponse.json({ error: "That is not a real date." }, { status: 400 });
  }

  // Backdating into a locked month would make that month's payslips
  // unreproducible — the frozen figures would no longer match a recompute.
  const month = fromStr.slice(0, 7);
  const clash = await prisma.payrollRun.findFirst({
    where: { month: { gte: month }, status: { not: "draft" } },
    orderBy: { month: "asc" },
  });
  if (clash) {
    return NextResponse.json(
      { error: `${clash.month} payroll is already ${clash.status}. Date this change from the month after, or reopen that run first.` },
      { status: 409 }
    );
  }

  const row = await prisma.salaryStructure.create({
    data: {
      userId,
      monthlyGross,
      standardHoursPerDay: hpd,
      workingDaysPerWeek: dpw,
      effectiveFrom,
      note: String(b.note || "").trim() || null,
      createdById: user.id,
    },
  });

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "create",
      entity: "SalaryStructure",
      entityId: row.id,
      // The amount is deliberately NOT in the audit summary. An audit log a
      // manager can read should not be a back door to everyone's salary.
      summary: `Salary set for ${target.name} from ${fromStr}`,
    },
  }).catch(() => {});

  return NextResponse.json({
    row,
    message: `${target.name}'s salary is set from ${fromStr}. Earlier months keep the figures they had.`,
  });
}
