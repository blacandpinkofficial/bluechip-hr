// GET /api/reports — the daily productivity tab and the recruiter funnel,
// derived rather than typed.
//
// Everything here is a count of rows that already exist. The old workbook asked
// someone to type six numbers every evening and a revenue column every month;
// both were knowable from the rows above them, and both were therefore wrong
// about as often as people are tired.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability, can } from "@/lib/auth";
import { funnel, weakestStage, daily } from "@/lib/stats";
import { istDay } from "@/lib/day";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req) {
  const gate = await requireCapability("report.own");
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const days = Math.min(90, Math.max(7, Number(url.searchParams.get("days")) || 14));
  const deskWide = can(gate.user.role, "report.desk");
  // Seeing the desk's WORK and seeing the desk's MONEY are two different
  // permissions, and report.desk is only the first. A team_leader holds
  // report.desk so they can watch every caller — they do not hold revenue.read.
  // Gating a rupee figure on deskWide hands them the whole desk's revenue and
  // there is then no difference between a team leader and a manager, which is
  // the entire reason the role exists.
  const showMoney = can(gate.user.role, "revenue.read");
  // A recruiter sees themselves. A manager sees the desk, or one person.
  const focusId = deskWide ? (url.searchParams.get("user") || null) : gate.user.id;

  // The IST day, from lib/day.js, not the box's local midnight. The server runs
  // on UTC, so setHours(0,0,0,0) made the working day run 05:30 IST to 05:30
  // IST — and this desk has night and US-shift roles. Calls logged at 2am IST
  // were landing in the previous day's figures.
  const today = istDay();
  const since = new Date(today.getTime() - (days - 1) * 86400000);

  const userFilter = focusId ? { userId: focusId } : {};

  const [calls, interviews, placements, users] = await Promise.all([
    prisma.candidateCall.findMany({
      where: { calledAt: { gte: since }, ...userFilter },
      select: { calledAt: true, outcome: true, userId: true },
    }),
    prisma.interview.findMany({
      where: {
        scheduledAt: { gte: since },
        ...(focusId ? { candidate: { is: { ownerId: focusId } } } : {}),
      },
      select: { scheduledAt: true, mode: true, attended: true, outcome: true,
                candidate: { select: { ownerId: true } } },
    }),
    prisma.placement.findMany({
      where: { selectedOn: { gte: since }, ...(focusId ? { recruiterId: focusId } : {}) },
      select: { selectedOn: true, joinedOn: true, droppedOn: true, revenue: true, recruiterId: true },
    }),
    prisma.user.findMany({
      where: { active: true },
      select: { id: true, name: true, role: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const connects = calls.filter((c) => c.outcome === "connected");

  const overall = funnel({
    calls: calls.length,
    connects: connects.length,
    lineUps: interviews.length,
    attended: interviews.filter((i) => i.attended === true).length,
    selected: interviews.filter((i) => i.outcome === "selected").length,
    joined: placements.filter((p) => p.joinedOn && !p.droppedOn).length,
  });

  // Per-person funnels, only when looking at the whole desk.
  let byUser = [];
  if (deskWide && !focusId) {
    const ids = new Set([
      ...calls.map((c) => c.userId),
      ...interviews.map((i) => i.candidate?.ownerId),
      ...placements.map((p) => p.recruiterId),
    ].filter(Boolean));

    byUser = [...ids].map((id) => {
      const u = users.find((x) => x.id === id);
      const mine = calls.filter((c) => c.userId === id);
      const myIv = interviews.filter((i) => i.candidate?.ownerId === id);
      const myPl = placements.filter((p) => p.recruiterId === id);
      const f = funnel({
        calls: mine.length,
        connects: mine.filter((c) => c.outcome === "connected").length,
        lineUps: myIv.length,
        attended: myIv.filter((i) => i.attended === true).length,
        selected: myIv.filter((i) => i.outcome === "selected").length,
        joined: myPl.filter((p) => p.joinedOn && !p.droppedOn).length,
      });
      return {
        id,
        name: u?.name || "Unassigned",
        role: u?.role || null,
        ...f,
        weakest: weakestStage(f),
        // Omitted, not zeroed: a zero reads as "this person earned nothing".
        ...(showMoney
          ? { revenue: myPl.filter((p) => p.joinedOn && !p.droppedOn).reduce((n, p) => n + (p.revenue || 0), 0) }
          : {}),
      };
    }).sort((a, b) => b.counts.joined - a.counts.joined || b.counts.calls - a.counts.calls);
  }

  return NextResponse.json({
    days,
    deskWide,
    focusId,
    users: deskWide ? users : [],
    overall: { ...overall, weakest: weakestStage(overall) },
    byUser,
    series: {
      calls: daily(calls, { days, key: "calledAt" }),
      connects: daily(connects, { days, key: "calledAt" }),
      interviews: daily(interviews, { days, key: "scheduledAt" }),
      placements: daily(placements.filter((p) => p.joinedOn && !p.droppedOn),
                        { days, key: "joinedOn" }),
    },
    // The old "Daily productivity" row, for today.
    today: (() => {
      // Both ends. `>= start` alone counted every interview booked for the next
      // fortnight as happening today — the interviews query has no upper bound
      // — so "today's line-ups" reported twelve when three were in the diary.
      const start = today;
      const end = new Date(start.getTime() + 86400000);
      const inDay = (d) => d && new Date(d) >= start && new Date(d) < end;
      const ivToday = interviews.filter((i) => inDay(i.scheduledAt));
      return {
        calls: calls.filter((c) => inDay(c.calledAt)).length,
        connects: connects.filter((c) => inDay(c.calledAt)).length,
        directLineUps: ivToday.filter((i) => i.mode === "direct").length,
        telephonic: ivToday.filter((i) => i.mode === "telephonic").length,
        attended: ivToday.filter((i) => i.attended === true).length,
        selects: ivToday.filter((i) => i.outcome === "selected").length,
      };
    })(),
    revenue: showMoney
      ? placements.filter((p) => p.joinedOn && !p.droppedOn).reduce((n, p) => n + (p.revenue || 0), 0)
      : undefined,
  });
}
