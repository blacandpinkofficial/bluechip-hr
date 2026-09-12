// /api/payroll/incentive — how a recruiter earns on top of salary.
//
// One rule may cover the whole desk (userId null) or one person (userId set),
// and the person's own rule wins. That ordering is in the payroll route, not
// here, so there is exactly one place that decides it.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/auth";
import { incentive } from "@/lib/payroll";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS = ["per-joining", "percent-of-revenue", "slab"];

export async function GET() {
  const gate = await requireCapability("payroll.read");
  if (!gate.ok) return gate.response;

  const rules = await prisma.incentiveRule.findMany({
    orderBy: [{ active: "desc" }, { createdAt: "asc" }],
    include: { user: { select: { id: true, name: true } } },
  });

  return NextResponse.json({
    rules: rules.map((r) => ({
      ...r,
      slabs: parseSlabs(r.slabsJson).slabs,
      // A worked example beside every rule. "5% of revenue" is abstract;
      // "on 3 joinings worth ₹2,00,000 that is ₹10,000" is not, and it is how
      // someone spots that they meant 5% and typed 50%.
      example: incentive(
        { ...r, slabs: parseSlabs(r.slabsJson).slabs },
        { joinings: 3, revenue: 200000 }
      ),
    })),
    kinds: KINDS,
    canWrite: (await requireCapability("payroll.write")).ok,
  });
}

function parseSlabs(json) {
  try {
    const v = JSON.parse(json || "[]");
    if (!Array.isArray(v)) return { slabs: [], error: "Slabs must be a list." };
    const slabs = v
      .map((s) => ({ min: Math.round(Number(s?.min)), amount: Math.round(Number(s?.amount)) }))
      .filter((s) => Number.isFinite(s.min) && Number.isFinite(s.amount) && s.min >= 0 && s.amount >= 0);
    return { slabs, error: slabs.length === v.length ? null : "Some slabs had unreadable numbers and were dropped." };
  } catch {
    return { slabs: [], error: "Slabs could not be read." };
  }
}

export async function POST(req) {
  const gate = await requireCapability("payroll.write");
  if (!gate.ok) return gate.response;
  const { user } = gate;

  const b = await req.json().catch(() => ({}));
  const kind = String(b.kind || "");
  if (!KINDS.includes(kind)) {
    return NextResponse.json({ error: `Type must be one of: ${KINDS.join(", ")}` }, { status: 400 });
  }

  const name = String(b.name || "").trim();
  if (!name) return NextResponse.json({ error: "Give the rule a name — it appears on the payslip." }, { status: 400 });

  const userId = b.userId ? String(b.userId) : null;

  const data = { name, kind, userId, active: b.active !== false };

  if (kind === "per-joining") {
    const per = Math.round(Number(b.perJoining));
    if (!Number.isFinite(per) || per <= 0) {
      return NextResponse.json({ error: "Enter the rupees paid per joining." }, { status: 400 });
    }
    data.perJoining = per;
  }

  if (kind === "percent-of-revenue") {
    // Accepted as a percentage and stored as basis points, because 8.33% has
    // no exact float. The conversion happens here, once.
    const pct = Number(b.percent);
    if (!Number.isFinite(pct) || pct <= 0) {
      return NextResponse.json({ error: "Enter the percentage of revenue." }, { status: 400 });
    }
    if (pct > 50) {
      return NextResponse.json(
        { error: `${pct}% of revenue would pay out more than most placements earn. Check the figure.` },
        { status: 400 }
      );
    }
    data.revenueBps = Math.round(pct * 100);
  }

  if (kind === "slab") {
    const { slabs, error } = parseSlabs(JSON.stringify(b.slabs || []));
    if (error) return NextResponse.json({ error }, { status: 400 });
    if (!slabs.length) return NextResponse.json({ error: "Add at least one slab." }, { status: 400 });

    // A slab that pays LESS for more joinings is always a typo, and it would
    // quietly punish the best month someone has.
    const sorted = [...slabs].sort((a, b2) => a.min - b2.min);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].amount < sorted[i - 1].amount) {
        return NextResponse.json(
          { error: `The ${sorted[i].min}+ slab pays less than the ${sorted[i - 1].min}+ slab. Check the amounts.` },
          { status: 400 }
        );
      }
      if (sorted[i].min === sorted[i - 1].min) {
        return NextResponse.json({ error: `Two slabs both start at ${sorted[i].min}.` }, { status: 400 });
      }
    }
    data.slabsJson = JSON.stringify(sorted);
  }

  const row = b.id
    ? await prisma.incentiveRule.update({ where: { id: String(b.id) }, data })
    : await prisma.incentiveRule.create({ data });

  await prisma.auditLog.create({
    data: { userId: user.id, action: b.id ? "update" : "create", entity: "IncentiveRule", entityId: row.id, summary: name },
  }).catch(() => {});

  return NextResponse.json({ row, message: `"${name}" saved. It applies from the next payroll calculation.` });
}
