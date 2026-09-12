// /api/reminders — what this person has to do today.
//
// Strictly your own. There is no "see everyone's reminders" mode, deliberately:
// a manager watching a live list of what each recruiter has not done yet turns
// a working tool into surveillance, and the first thing people do with a
// surveillance tool is stop putting real dates in it. The desk-wide view of
// whether work is happening already exists, in Reports.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/auth";
import { groupReminders } from "@/lib/reminders";
import { istDay } from "@/lib/day";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req) {
  const gate = await requireCapability("candidate.read");
  if (!gate.ok) return gate.response;
  const { user } = gate;

  const url = new URL(req.url);
  const includeDone = url.searchParams.get("done") === "1";

  const rows = await prisma.reminder.findMany({
    where: { userId: user.id, ...(includeDone ? {} : { status: "open" }) },
    orderBy: [{ dueOn: "asc" }],
    take: 300,
  });

  return NextResponse.json({
    ...groupReminders(rows, istDay()),
    // The badge count is only ever things that are late or due today. Counting
    // next week's items too makes the number never reach zero, and a number
    // that never reaches zero is a number people stop reading.
    badge: rows.filter((r) => r.status === "open" && r.dueOn <= istDay()).length,
  });
}

/** body: { id, status: "done" | "open" | "dismissed" } */
export async function PATCH(req) {
  const gate = await requireCapability("candidate.read");
  if (!gate.ok) return gate.response;
  const { user } = gate;

  const b = await req.json().catch(() => ({}));
  const id = String(b.id || "");
  const status = String(b.status || "done");
  if (!["done", "open", "dismissed"].includes(status)) {
    return NextResponse.json({ error: "Unknown status." }, { status: 400 });
  }

  // Scoped by userId in the WHERE, not checked after loading. Anyone can guess
  // an id; nobody should be able to tick off someone else's work.
  const result = await prisma.reminder.updateMany({
    where: { id, userId: user.id },
    data: { status, doneAt: status === "open" ? null : new Date() },
  });

  if (result.count === 0) {
    return NextResponse.json({ error: "That reminder is not yours, or no longer exists." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
