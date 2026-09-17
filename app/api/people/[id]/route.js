// /api/people/[id] — one person's desk.
//
// The scope is decided HERE, from the session, not from what the URL asks for.
// A recruiter opening /people/<someone else> gets their own figures back, with
// `scopedToSelf: true` so the screen can say so plainly. Scoping down silently
// and saying nothing is how a screen quietly lies; a 403 on a page they are
// entitled to open is just confusing.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability, can } from "@/lib/auth";
import { funnel, weakestStage } from "@/lib/stats";
import { istDay, monthRange, istMonth } from "@/lib/day";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req, { params }) {
  const gate = await requireCapability("report.own");
  if (!gate.ok) return gate.response;
  const { user } = gate;

  const seesDesk = can(user.role, "report.desk");
  const asked = String(params?.id || "");
  const scopedToSelf = !seesDesk && asked !== user.id;
  const userId = seesDesk ? asked || user.id : user.id;

  const url = new URL(req.url);
  const month = url.searchParams.get("month") || istMonth();
  const range = monthRange(month);
  if (!range) return NextResponse.json({ error: "Month must look like 2026-09." }, { status: 400 });

  const person = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, phone: true, role: true, active: true, createdAt: true, lastLoginAt: true },
  });
  if (!person) return NextResponse.json({ error: "No such person." }, { status: 404 });

  const today = istDay();

  // Two different questions about placements, asked separately because they
  // have two different answers.
  //
  //   selectedThisMonth — the client said yes in this month
  //   joinedThisMonth   — the candidate started work in this month
  //
  // A candidate selected on 28 September who starts on 3 October belongs to
  // September by the first measure and October by the second, and the recruiter
  // is paid their incentive in October: /api/payroll filters on joinedOn within
  // the month. So "joined" on this page counts joinedOn too, to the same
  // definition, and the recruiter's own screen and their payslip agree. Keeping
  // only the selectedOn list would also lose the other half of the problem — a
  // placement selected in August and joined in September appeared on NEITHER
  // month's profile, because September's query never fetched it.
  const [
    calls,
    connects,
    interviews,
    selectedThisMonth,
    joinedThisMonth,
    lineUps,
    followUps,
    submissions,
    allTimePlacements,
  ] =
    await Promise.all([
      prisma.candidateCall.count({ where: { userId, calledAt: { gte: range.from, lt: range.to } } }),
      // outcome === "connected", the same definition Reports uses. An exclusion
      // list here would be a SECOND definition of "connected" that drifts from
      // the first — and two screens disagreeing about one recruiter's connect
      // rate is worse than either number alone.
      prisma.candidateCall.count({
        where: { userId, calledAt: { gte: range.from, lt: range.to }, outcome: "connected" },
      }),
      prisma.interview.findMany({
        where: { candidate: { is: { ownerId: userId } }, scheduledAt: { gte: range.from, lt: range.to } },
        select: { id: true, attended: true, outcome: true, scheduledAt: true },
      }),
      // Selected this month. Its own measure, and a useful one: it is what the
      // desk did, on the date it did it, before the notice period had its say.
      prisma.placement.findMany({
        where: { recruiterId: userId, selectedOn: { gte: range.from, lt: range.to } },
        include: {
          candidate: { select: { name: true } },
          client: { select: { name: true } },
          requirement: { select: { designation: true } },
        },
        orderBy: { selectedOn: "desc" },
      }),
      // Joined this month. Identical where-clause to /api/payroll's, on
      // purpose — if these two ever need to change, they change together.
      prisma.placement.findMany({
        where: {
          recruiterId: userId,
          joinedOn: { gte: range.from, lt: range.to },
          droppedOn: null,
        },
        include: {
          candidate: { select: { name: true } },
          client: { select: { name: true } },
          requirement: { select: { designation: true } },
        },
        orderBy: { joinedOn: "desc" },
      }),
      // Live line-ups: an interview ahead of today with no outcome recorded.
      prisma.interview.findMany({
        where: {
          candidate: { is: { ownerId: userId } },
          scheduledAt: { gte: today },
          OR: [{ outcome: null }, { outcome: "pending" }],
        },
        orderBy: { scheduledAt: "asc" },
        take: 50,
        include: {
          candidate: { select: { id: true, name: true, phone: true } },
          requirement: { select: { designation: true, client: { select: { name: true } } } },
        },
      }),
      prisma.candidate.count({
        where: { ownerId: userId, archived: false, nextFollowUpAt: { not: null, lte: today }, stage: { notIn: ["joined", "dropped"] } },
      }),
      prisma.submission.count({ where: { sentById: userId, sentAt: { gte: range.from, lt: range.to } } }),
      // Everything they have ever closed — the number people are actually proud
      // of, and it should not reset on the first of the month.
      prisma.placement.findMany({
        where: { recruiterId: userId, joinedOn: { not: null }, droppedOn: null },
        select: { id: true, revenue: true, joinedOn: true },
      }),
    ]);

  const attended = interviews.filter((i) => i.attended === true).length;
  const selected = interviews.filter((i) => i.outcome === "selected").length;
  const joinedCount = joinedThisMonth.length;
  const selectedCount = selectedThisMonth.length;

  const f = funnel({
    calls,
    connects,
    lineUps: interviews.length,
    attended,
    selected,
    joined: joinedCount,
  });

  const seesMoney = can(user.role, "revenue.read") || userId === user.id;

  // Explicitly-shaped, never the raw row. Both placement lists below use it,
  // so they cannot drift into showing different columns.
  const placementRow = (p) => ({
    id: p.id,
    candidate: p.candidate?.name,
    client: p.client?.name,
    designation: p.requirement?.designation || p.designation,
    selectedOn: p.selectedOn,
    joinedOn: p.joinedOn,
    droppedOn: p.droppedOn,
    // A recruiter may always see the fee on their OWN placement — it is what
    // their incentive is calculated from. Someone else's is desk revenue.
    revenue: seesMoney ? p.revenue : null,
  });

  return NextResponse.json({
    person,
    month,
    scopedToSelf,
    isSelf: userId === user.id,
    canSeeTranscripts: can(user.role, "training.review"),
    counts: {
      calls, connects,
      lineUps: interviews.length,
      attended, selected,
      // Placements whose joinedOn falls in this month — the same set payroll
      // pays incentive on. This is the headline "Joined in <month>" figure.
      joined: joinedCount,
      // Placements whose selectedOn falls in this month. A different number
      // from the one above and deliberately so; it is what `closed` lists.
      placementsSelected: selectedCount,
      submissions,
      followUpsDue: followUps,
    },
    funnel: f,
    weakest: weakestStage(f),
    // Which date each list below is keyed on, so a screen can label itself
    // honestly rather than guessing.
    basis: { closed: "selectedOn", joined: "joinedOn" },
    // Closed work, which is the point of the page. Selected in this month —
    // some of these will have joined in a later one.
    closed: selectedThisMonth.map(placementRow),
    // Joined in this month — some of these were selected in an earlier one,
    // and until now they appeared on no month's profile at all.
    joined: joinedThisMonth.map(placementRow),
    lineUps: lineUps.map((i) => ({
      id: i.id,
      candidate: i.candidate?.name,
      candidateId: i.candidate?.id,
      phone: i.candidate?.phone,
      designation: i.requirement?.designation,
      client: i.requirement?.client?.name,
      scheduledAt: i.scheduledAt,
      mode: i.mode,
    })),
    allTime: {
      joinings: allTimePlacements.length,
      revenue: seesMoney ? allTimePlacements.reduce((s, p) => s + (p.revenue || 0), 0) : null,
    },
  });
}
