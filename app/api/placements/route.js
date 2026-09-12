// /api/placements — the "Recruiters MTD Performance" tab, and the half of the
// business that gets Blue Chip paid.
//
// Revenue is computed once, from terms frozen at the moment of selection, and
// then stored. It is NOT recalculated on read: when a rate is renegotiated with
// a client next year, every placement already made must keep the terms it was
// made under, or closed months silently change value and no report can be
// trusted twice.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability, can, ownScope } from "@/lib/auth";
import { freezeTerms, resolveFee, replacementDeadline } from "@/lib/fees";
import { parseRupees } from "@/lib/money";
import { getSettings } from "@/lib/settings";
import { istMonth, monthRange as istMonthRange } from "@/lib/day";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One definition of a month, shared with payroll and invoicing. This file used
// to build its own from the server's LOCAL calendar: on a UTC box, for the first
// five and a half hours of every month, "this month" still resolved to the last
// one — and the screen showed September's figures under an October heading.
function monthRange(ym) {
  const label = /^\d{4}-\d{2}$/.test(ym || "") ? ym : istMonth();
  const range = istMonthRange(label);
  if (!range) {
    const fallback = istMonth();
    return { ...istMonthRange(fallback), label: fallback };
  }
  return { ...range, label };
}

export async function GET(req) {
  const gate = await requireCapability("report.own");
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const { from, to, label } = monthRange(url.searchParams.get("month"));
  const deskWide = can(gate.user.role, "revenue.read");
  // The frozen fee terms ARE the client's commercial rate — freezeTerms copies
  // them straight off the client or the requirement. client.fees is owner-only,
  // and /api/clients and /api/requirements both strip these correctly; this
  // route was handing every manager the agreed rate for every client.
  const showFees = can(gate.user.role, "client.fees");

  const rows = await prisma.placement.findMany({
    where: {
      selectedOn: { gte: from, lt: to },
      // A recruiter sees their own placements and their own revenue. Desk-wide
      // revenue is the number people leave over, so it is owner and manager
      // only — and enforced here, not hidden in the UI.
      ...(deskWide ? {} : ownScope(gate.user, "recruiterId")),
    },
    orderBy: [{ selectedOn: "desc" }],
    include: {
      candidate: { select: { id: true, name: true, phone: true } },
      client: { select: { id: true, name: true } },
      requirement: { select: { id: true, designation: true } },
      recruiter: { select: { id: true, name: true } },
    },
  });

  // Joined is real; selected is a promise. Both are worth seeing, and
  // conflating them is how a month looks better than it was.
  const joined = rows.filter((p) => p.joinedOn && !p.droppedOn);
  const atRisk = rows.filter((p) => p.droppedOn);

  const byRecruiter = new Map();
  for (const p of rows) {
    const k = p.recruiter?.id || "—";
    const e = byRecruiter.get(k) || { id: k, name: p.recruiter?.name || "Unassigned", selected: 0, joined: 0, revenue: 0 };
    e.selected += 1;
    if (p.joinedOn && !p.droppedOn) { e.joined += 1; e.revenue += p.revenue || 0; }
    byRecruiter.set(k, e);
  }

  return NextResponse.json({
    month: label,
    deskWide,
    placements: rows.map((p) => ({
      id: p.id,
      candidate: p.candidate,
      client: p.client,
      requirement: p.requirement,
      recruiter: p.recruiter,
      designation: p.designation,
      location: p.location,
      selectedOn: p.selectedOn,
      joinedOn: p.joinedOn,
      droppedOn: p.droppedOn,
      dropReason: p.dropReason,
      employeeId: p.employeeId,
      ctcOfferedAnnual: p.ctcOfferedAnnual,
      takeHomeMonthly: p.takeHomeMonthly,
      ...(showFees ? { feeType: p.feeType, feeBps: p.feeBps, feeFlat: p.feeFlat } : {}),
      revenue: p.revenue,
      invoiceStatus: p.invoiceStatus,
      invoiceNo: p.invoiceNo,
      replacementUntil: p.replacementUntil,
      // Within the free-replacement window the fee is not safe yet.
      stillReplaceable:
        !!p.replacementUntil && !p.droppedOn && new Date(p.replacementUntil) > new Date(),
    })),
    totals: {
      selected: rows.length,
      joined: joined.length,
      dropped: atRisk.length,
      // Only joined, not-dropped placements count. Revenue on a selection that
      // never turned up is a number that feels good and cannot be invoiced.
      revenue: joined.reduce((n, p) => n + (p.revenue || 0), 0),
      invoiced: joined.filter((p) => p.invoiceStatus !== "pending").reduce((n, p) => n + (p.revenue || 0), 0),
      paid: joined.filter((p) => p.invoiceStatus === "paid").reduce((n, p) => n + (p.revenue || 0), 0),
    },
    byRecruiter: [...byRecruiter.values()].sort((a, b) => b.revenue - a.revenue),
  });
}

export async function POST(req) {
  const gate = await requireCapability("placement.write");
  if (!gate.ok) return gate.response;

  try {
    const b = await req.json().catch(() => ({}));
    const candidateId = String(b.candidateId || "");
    const requirementId = String(b.requirementId || "");

    if (!candidateId || !requirementId) {
      return NextResponse.json(
        { error: "A placement needs the candidate and the opening they were selected for." },
        { status: 400 }
      );
    }

    const ctc = parseRupees(b.ctcOfferedAnnual);
    if (ctc == null || ctc <= 0) {
      return NextResponse.json(
        { error: "Enter the annual CTC offered — the fee is calculated from it." },
        { status: 400 }
      );
    }

    const selectedOn = b.selectedOn ? new Date(b.selectedOn) : new Date();
    if (Number.isNaN(selectedOn.getTime())) {
      return NextResponse.json({ error: "Enter a valid selection date." }, { status: 400 });
    }
    const joinedOn = b.joinedOn ? new Date(b.joinedOn) : null;
    if (joinedOn && Number.isNaN(joinedOn.getTime())) {
      return NextResponse.json({ error: "Enter a valid joining date." }, { status: 400 });
    }
    if (joinedOn && joinedOn < selectedOn) {
      return NextResponse.json(
        { error: "The joining date cannot be before the selection date." },
        { status: 400 }
      );
    }

    const [candidate, requirement] = await Promise.all([
      prisma.candidate.findUnique({ where: { id: candidateId } }),
      prisma.requirement.findUnique({ where: { id: requirementId }, include: { client: true } }),
    ]);
    if (!candidate) return NextResponse.json({ error: "No such candidate." }, { status: 404 });
    if (!requirement) return NextResponse.json({ error: "No such requirement." }, { status: 404 });

    // Refuse rather than bill zero. A placement with no agreed rate is a real
    // situation — it means someone has to go and agree one — and silently
    // recording ₹0 makes it invisible until the month is closed.
    const fee = resolveFee(requirement, requirement.client);
    if (!fee.feeType) {
      return NextResponse.json(
        {
          error: `No commercials are set for ${requirement.designation} at ${requirement.client?.name}. Set the rate on the opening or the client first — otherwise this placement cannot be billed.`,
          needsFee: true,
          requirementId,
        },
        { status: 409 }
      );
    }

    const existing = await prisma.placement.findFirst({ where: { candidateId, requirementId } });
    if (existing) {
      return NextResponse.json(
        { error: `${candidate.name} is already recorded as placed on this opening.`, placementId: existing.id },
        { status: 409 }
      );
    }

    const settings = await getSettings();
    const frozen = freezeTerms({ requirement, client: requirement.client, ctcOfferedAnnual: ctc });

    const created = await prisma.$transaction(async (tx) => {
      const p = await tx.placement.create({
        data: {
          candidateId,
          requirementId,
          clientId: requirement.clientId,
          recruiterId: b.recruiterId || candidate.ownerId || gate.user.id,
          selectedOn,
          joinedOn,
          employeeId: String(b.employeeId || "").trim() || null,
          ctcOfferedAnnual: ctc,
          takeHomeMonthly: parseRupees(b.takeHomeMonthly),
          designation: requirement.designation,
          location: requirement.location,
          ...frozen,
          replacementUntil: joinedOn ? replacementDeadline(joinedOn, settings.replacementDays) : null,
          invoiceStatus: "pending",
        },
      });

      await tx.candidate.update({
        where: { id: candidateId },
        data: { stage: joinedOn ? "joined" : "selected" },
      });

      return p;
    });

    await prisma.auditLog
      .create({
        data: {
          userId: gate.user.id,
          action: "create",
          entity: "Placement",
          entityId: created.id,
          summary: `${candidate.name} placed at ${requirement.client?.name} as ${requirement.designation} — fee ₹${created.revenue?.toLocaleString("en-IN")}`,
        },
      })
      .catch((e) => console.error("[placements] audit write failed:", e?.message));

    return NextResponse.json({ placement: created }, { status: 201 });
  } catch (e) {
    // P2002 is the new unique constraint on (candidateId, requirementId) doing
    // its job: two clicks raced past the findFirst check above. That is not a
    // server fault and must not read like one — the second click simply lost,
    // which is exactly what should happen.
    if (e?.code === "P2002") {
      return NextResponse.json(
        { error: "That placement has already been recorded." },
        { status: 409 }
      );
    }
    console.error("[POST /api/placements]", e?.message || e);
    return NextResponse.json({ error: "Could not record the placement." }, { status: 500 });
  }
}
