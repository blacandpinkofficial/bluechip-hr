// /api/cron/daily — the nightly job that makes the app speak up.
//
// Called by a systemd timer with a shared secret, NOT by a signed-in person:
//
//   curl -fsS -X POST -H "X-Service-Token: $CRON_SECRET" \
//        http://127.0.0.1:3100/api/cron/daily
//
// Two things about that which have already bitten on the Pulse side:
//
//   1. THIS PATH MUST BE IN middleware.js's PUBLIC LIST. Otherwise the edge
//      middleware sees no session cookie and 401s the request before this
//      handler ever runs — and the timer logs a 401 that looks like a broken
//      secret rather than a routing rule.
//
//   2. The secret is compared in CONSTANT TIME. A plain === on a secret leaks
//      its length and, given enough attempts, its contents. It costs one line.
//
// Safe to run twice. Every reminder has a stable identity and is upserted, so
// running this by hand at 11am tops up the day rather than duplicating it.
import { NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { buildReminders } from "@/lib/reminders";
import { istDay } from "@/lib/day";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorised(req) {
  const expected = process.env.CRON_SECRET || "";
  // No secret configured means the endpoint is closed, not open. The opposite
  // default would leave a fresh install with an unauthenticated write endpoint.
  if (!expected) return false;
  const got = req.headers.get("x-service-token") || "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function POST(req) {
  if (!authorised(req)) {
    return NextResponse.json({ error: "Not authorised" }, { status: 401 });
  }

  const today = istDay();
  const horizon = new Date(today.getTime() + 45 * 86400000);
  const back = new Date(today.getTime() - 60 * 86400000);

  try {
    const [candidates, interviews, placements, invoices, submissions, attendance, owners] = await Promise.all([
      prisma.candidate.findMany({
        where: { archived: false, nextFollowUpAt: { not: null, lte: today }, stage: { notIn: ["joined", "dropped"] } },
        select: { id: true, name: true, ownerId: true, stage: true, designation: true, location: true, nextFollowUpAt: true, archived: true },
        take: 2000,
      }),
      prisma.interview.findMany({
        where: { scheduledAt: { gte: back, lte: horizon }, OR: [{ attended: null }, { outcome: null }, { outcome: "pending" }] },
        include: {
          candidate: { select: { name: true, ownerId: true } },
          requirement: { select: { designation: true, client: { select: { name: true } } } },
        },
        take: 1000,
      }),
      prisma.placement.findMany({
        where: { replacementUntil: { not: null, gte: back } },
        include: { candidate: { select: { name: true } }, client: { select: { name: true } } },
        take: 1000,
      }),
      prisma.invoice.findMany({
        where: { status: { notIn: ["paid", "cancelled", "written-off", "draft"] } },
        include: { client: { select: { name: true } } },
        take: 1000,
      }),
      prisma.submission.findMany({
        where: { status: "sent" },
        include: {
          candidate: { select: { name: true } },
          client: { select: { name: true } },
          requirement: { select: { designation: true } },
        },
        take: 1000,
      }),
      prisma.attendance.findMany({
        where: { checkIn: { not: null }, checkOut: null, day: { gte: back, lt: today } },
        take: 2000,
      }),
      prisma.user.findMany({ where: { active: true, role: { in: ["owner", "manager"] } }, select: { id: true } }),
    ]);

    const specs = buildReminders({
      today,
      candidates,
      interviews,
      placements,
      invoices,
      submissions,
      attendance,
      owners: owners.map((o) => o.id),
    });

    let created = 0;
    let refreshed = 0;
    for (const s of specs) {
      try {
        const existing = await prisma.reminder.findUnique({
          where: { userId_kind_refId_dueOn: { userId: s.userId, kind: s.kind, refId: s.refId, dueOn: s.dueOn } },
        });
        if (existing) {
          // Refresh the wording (a follow-up goes from "1 day late" to "4 days
          // late") but NEVER reopen one someone has already dealt with. Undoing
          // a person's "done" every night is how a list gets abandoned.
          if (existing.status === "open") {
            await prisma.reminder.update({
              where: { id: existing.id },
              data: { title: s.title, body: s.body, urgency: s.urgency },
            });
            refreshed += 1;
          }
        } else {
          await prisma.reminder.create({ data: s });
          created += 1;
        }
      } catch (e) {
        console.error("[cron] reminder failed", s.kind, s.refId, e?.message || e);
      }
    }

    // Close reminders whose reason has gone away — the follow-up was made, the
    // invoice was paid. Left alone they become a list of things that are no
    // longer true, which is worse than no list.
    //
    // But ONLY if every query above returned everything it was asked for. Each
    // has a `take` cap; if one of them hit its cap, `specs` is an incomplete
    // picture of what is due, and closing everything absent from an incomplete
    // picture would silently wipe real work off people's lists. Far better to
    // leave a few stale reminders standing than to delete live ones.
    const truncated =
      candidates.length >= 2000 || attendance.length >= 2000 ||
      interviews.length >= 1000 || placements.length >= 1000 ||
      invoices.length >= 1000 || submissions.length >= 1000;

    if (truncated) {
      console.warn("[cron/daily] a query hit its row cap — skipping the close-out pass this run");
      const summary = { created, refreshed, closed: 0, considered: specs.length, truncated: true };
      return NextResponse.json({ ok: true, ...summary });
    }

    const liveKeys = new Set(specs.map((s) => `${s.userId}|${s.kind}|${s.refId}`));
    const open = await prisma.reminder.findMany({
      where: { status: "open", kind: { in: ["follow-up", "invoice-due", "no-response", "attendance", "interview", "guarantee"] } },
      select: { id: true, userId: true, kind: true, refId: true },
      take: 5000,
    });
    const stale = open.filter((r) => !liveKeys.has(`${r.userId}|${r.kind}|${r.refId}`)).map((r) => r.id);
    if (stale.length) {
      await prisma.reminder.updateMany({
        where: { id: { in: stale } },
        data: { status: "dismissed", doneAt: new Date() },
      });
    }

    const summary = { created, refreshed, closed: stale.length, considered: specs.length };
    console.log("[cron/daily]", JSON.stringify(summary));
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    console.error("[cron/daily] failed", e?.message || e);
    return NextResponse.json({ error: e?.message || "The nightly job failed." }, { status: 500 });
  }
}
