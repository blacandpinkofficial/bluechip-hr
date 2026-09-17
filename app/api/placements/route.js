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
import { requireCapability, can } from "@/lib/auth";
import { placementForRole } from "@/lib/placementView";
import { freezeTerms, resolveFee, replacementDeadline } from "@/lib/fees";
import { parseRupees } from "@/lib/money";
import { getSettings } from "@/lib/settings";
import { istMonth, monthRange as istMonthRange } from "@/lib/day";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The candidate pipeline, in order. Forwards only — see the guard in POST.
// "dropped" is deliberately absent, which is why every index is checked against
// -1 before it is compared.
const ORDER = ["new", "contacted", "shortlisted", "lined-up", "interviewed", "selected", "joined"];

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

  // Four separate questions, and they have four different answers. Running any
  // two of them together is how the desk's money leaks.
  //
  //   deskRows    — whose placements may this person SEE AT ALL
  //   deskRevenue — whose fees may this person see
  //   ownRevenue  — may they see the fee on their own placements
  //   showFees    — may they see the client's agreed RATE behind the fee
  //
  // A team_leader is the case that matters. They hold placement.read and
  // report.desk, because running a team means seeing the team's work — but they
  // hold neither revenue.read nor client.fees, because the desk's money is not
  // theirs. Gate the money on report.desk (as this route used to) and every
  // team leader is handed the whole month's revenue.
  const deskRows = can(gate.user.role, "report.desk");
  const deskRevenue = can(gate.user.role, "revenue.read");
  const ownRevenue = can(gate.user.role, "revenue.own");
  // The frozen fee terms ARE the client's commercial rate — freezeTerms copies
  // them straight off the client or the requirement. client.fees is owner-only,
  // and /api/clients and /api/requirements both strip these correctly; this
  // route was handing every manager the agreed rate for every client.
  const showFees = can(gate.user.role, "client.fees");

  const rows = await prisma.placement.findMany({
    where: {
      selectedOn: { gte: from, lt: to },
      // A recruiter sees their own placements. The desk view is a manager's or
      // a team leader's job — and it is a view of the WORK, not the money.
      ...(deskRows ? {} : { recruiterId: gate.user.id }),
    },
    orderBy: [{ selectedOn: "desc" }],
    include: {
      candidate: { select: { id: true, name: true, phone: true } },
      client: { select: { id: true, name: true } },
      requirement: { select: { id: true, designation: true } },
      recruiter: { select: { id: true, name: true } },
    },
  });

  // Whose fee may this person see? Asked once, per row, and then used for the
  // row, the totals and the by-recruiter bars alike, so the three can never
  // disagree with each other. The row projection asks exactly the same question
  // in lib/placementView.js — this local copy still decides the TOTALS, which
  // are not a row and so cannot be projected.
  const maySeeFee = (p) => deskRevenue || (ownRevenue && p.recruiterId === gate.user.id);

  // Joined is real; selected is a promise. Both are worth seeing, and
  // conflating them is how a month looks better than it was.
  const joined = rows.filter((p) => p.joinedOn && !p.droppedOn);
  const atRisk = rows.filter((p) => p.droppedOn);
  const countable = joined.filter(maySeeFee);

  const byRecruiter = new Map();
  if (deskRevenue) {
    for (const p of rows) {
      const k = p.recruiter?.id || "—";
      const e = byRecruiter.get(k) || { id: k, name: p.recruiter?.name || "Unassigned", selected: 0, joined: 0, revenue: 0 };
      e.selected += 1;
      if (p.joinedOn && !p.droppedOn) { e.joined += 1; e.revenue += p.revenue || 0; }
      byRecruiter.set(k, e);
    }
  }

  return NextResponse.json({
    month: label,
    deskWide: deskRevenue,
    showFees,
    // What this person may do on the rows below, decided by capability here and
    // never by a role string in the browser. The handlers refuse it regardless.
    me: {
      id: gate.user.id,
      canWrite: can(gate.user.role, "placement.write"),
      canInvoice: can(gate.user.role, "invoice.write"),
      // Is there any money on this screen for this person at all? Not "does the
      // role hold revenue.own" — every role holds that — but whether a single
      // row in front of them is theirs. A team leader with no placements of
      // their own gets no fee column and no invoice column, rather than two
      // columns of dashes that invite someone to go looking.
      canSeeMoney: deskRevenue || rows.some((p) => maySeeFee(p)),
    },
    // One projector, shared with POST and PATCH. It is an allow-list: money is
    // omitted entirely rather than zeroed (a 0 reads as "this one earned
    // nothing", which is a different and untrue statement), the client's agreed
    // rate rides on client.fees, and the invoice travels with the fee rather
    // than with the placement — an invoice number and a "paid" chip say what
    // the desk billed and collected just as plainly as the rupee figure does.
    placements: rows.map((p) =>
      placementForRole(p, gate.user.role, { viewerId: gate.user.id })
    ),
    totals: {
      selected: rows.length,
      joined: joined.length,
      dropped: atRisk.length,
      // Only joined, not-dropped placements count, and only the ones whose fee
      // this person is allowed to see. Revenue on a selection that never turned
      // up is a number that feels good and cannot be invoiced; a total that
      // quietly includes rows the reader may not see is a back door to the
      // same figure.
      revenue: countable.reduce((n, p) => n + (p.revenue || 0), 0),
      invoiced: countable.filter((p) => p.invoiceStatus !== "pending").reduce((n, p) => n + (p.revenue || 0), 0),
      paid: countable.filter((p) => p.invoiceStatus === "paid").reduce((n, p) => n + (p.revenue || 0), 0),
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

      // Move the candidate to match — forwards only. Writing the stage flat
      // sent a candidate who had already joined somewhere back to "selected"
      // the moment a second placement was recorded against them.
      //
      // The one deliberate exception is "dropped". It is not in ORDER, so it
      // indexes to -1 and every other write in the app leaves it alone. Here it
      // is lifted, because a placement is not a guess: somebody with
      // placement.write has typed a CTC and a client against this person. A
      // candidate written off after one rejection and then placed elsewhere
      // must not stay marked dropped.
      const target = joinedOn ? "joined" : "selected";
      const at = ORDER.indexOf(candidate.stage);
      const to = ORDER.indexOf(target);
      if (candidate.stage === "dropped" || (at >= 0 && at < to)) {
        await tx.candidate.update({
          where: { id: candidateId },
          data: { stage: target, archived: false },
        });
      }

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

    // BC-01. The created row is a full Placement: it carries `revenue` — the
    // frozen fee — AND feeType/feeBps/feeFlat, which are the client's agreed
    // commercial rate. This used to delete `revenue` alone and hand a
    // team_leader the rate in the confirmation toast. Deleting named keys is
    // the wrong shape of fix: it leaks every column added to Placement
    // afterwards. Project through the shared allow-list instead, the same one
    // GET and PATCH use.
    return NextResponse.json(
      {
        placement: placementForRole(created, gate.user.role, {
          viewerId: gate.user.id,
        }),
      },
      { status: 201 }
    );
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
