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

  const [calls, connects, interviews, placementsThisMonth, lineUps, followUps, submissions, allTimePlacements] =
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
      prisma.placement.findMany({
        where: { recruiterId: userId, selectedOn: { gte: range.from, lt: range.to } },
        include: {
          candidate: { select: { name: true } },
          client: { select: { name: true } },
          requirement: { select: { designation: true } },
        },
        orderBy: { selectedOn: "desc" },
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
  const joinedThisMonth = placementsThisMonth.filter((p) => p.joinedOn && !p.droppedOn).length;

  const f = funnel({
    calls,
    connects,
    lineUps: interviews.length,
    attended,
    selected,
    joined: joinedThisMonth,
  });

  const seesMoney = can(user.role, "revenue.read") || userId === user.id;

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
      joined: joinedThisMonth,
      submissions,
      followUpsDue: followUps,
    },
    funnel: f,
    weakest: weakestStage(f),
    // Closed work, which is the point of the page.
    closed: placementsThisMonth.map((p) => ({
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
    })),
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
