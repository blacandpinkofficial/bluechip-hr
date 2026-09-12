// /api/interviews — the "Interview Schedules" tab.
//
// Company, position and phone number are NOT stored here. They are reached
// through the candidate and the requirement, which is the whole difference
// between this and the spreadsheet: in the workbook those three columns are
// retyped per interview and drift from the candidate row within a week.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability, can } from "@/lib/auth";
import { istDay } from "@/lib/day";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODES = ["telephonic", "direct", "video"];
const OUTCOMES = ["pending", "selected", "rejected", "on-hold", "no-show"];

export async function GET(req) {
  const gate = await requireCapability("interview.read");
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const when = url.searchParams.get("when") || "upcoming"; // today | upcoming | past | all

  // The IST day. On a UTC box, setHours(0,0,0,0) put the boundary at 05:30 IST,
  // so an early-morning interview showed under yesterday.
  const startOfToday = istDay();
  const endOfToday = new Date(startOfToday.getTime() + 86400000);

  const where =
    when === "today" ? { scheduledAt: { gte: startOfToday, lt: endOfToday } }
    : when === "past" ? { scheduledAt: { lt: startOfToday } }
    : when === "all" ? {}
    : { scheduledAt: { gte: startOfToday } };

  const rows = await prisma.interview.findMany({
    where,
    orderBy: { scheduledAt: when === "past" ? "desc" : "asc" },
    take: 300,
    include: {
      candidate: { select: { id: true, name: true, phone: true, stage: true, ownerId: true } },
      requirement: {
        select: {
          id: true, designation: true, location: true,
          client: { select: { name: true } },
        },
      },
    },
  });

  // A recruiter sees the interviews for their own candidates. The desk view is
  // a manager's job.
  const visible = can(gate.user.role, "report.desk")
    ? rows
    : rows.filter((r) => !r.candidate?.ownerId || r.candidate.ownerId === gate.user.id);

  return NextResponse.json({
    when,
    interviews: visible.map((i) => ({
      id: i.id,
      scheduledAt: i.scheduledAt,
      mode: i.mode,
      location: i.location,
      round: i.round,
      interviewer: i.interviewer,
      attended: i.attended,
      outcome: i.outcome,
      feedback: i.feedback,
      candidate: i.candidate,
      requirement: i.requirement && {
        id: i.requirement.id,
        designation: i.requirement.designation,
        location: i.requirement.location,
        clientName: i.requirement.client?.name,
      },
    })),
    counts: {
      // "Direct Line ups scheduled" and "Telephonic scheduled" on the old
      // productivity tab are these two numbers. Counted, not typed.
      direct: visible.filter((i) => i.mode === "direct").length,
      telephonic: visible.filter((i) => i.mode === "telephonic").length,
      video: visible.filter((i) => i.mode === "video").length,
      attended: visible.filter((i) => i.attended === true).length,
      selected: visible.filter((i) => i.outcome === "selected").length,
    },
  });
}

export async function POST(req) {
  const gate = await requireCapability("interview.write");
  if (!gate.ok) return gate.response;

  try {
    const b = await req.json().catch(() => ({}));
    const candidateId = String(b.candidateId || "");
    const requirementId = String(b.requirementId || "");

    if (!candidateId || !requirementId) {
      return NextResponse.json(
        { error: "An interview needs both a candidate and the opening they are being seen for." },
        { status: 400 }
      );
    }

    const when = new Date(b.scheduledAt);
    if (Number.isNaN(when.getTime())) {
      return NextResponse.json({ error: "Enter a valid date and time." }, { status: 400 });
    }

    const [candidate, requirement] = await Promise.all([
      prisma.candidate.findUnique({ where: { id: candidateId } }),
      prisma.requirement.findUnique({ where: { id: requirementId } }),
    ]);
    if (!candidate) return NextResponse.json({ error: "No such candidate." }, { status: 404 });
    if (!requirement) return NextResponse.json({ error: "No such requirement." }, { status: 404 });
    if (!mayTouch(gate.user, candidate)) {
      // Booking against someone else's candidate rewrites their stage and can
      // reassign the candidate to a different opening.
      return NextResponse.json({ error: "That candidate belongs to someone else on the desk." }, { status: 403 });
    }

    const mode = MODES.includes(b.mode) ? b.mode : "telephonic";

    const created = await prisma.$transaction(async (tx) => {
      const iv = await tx.interview.create({
        data: {
          candidateId,
          requirementId,
          scheduledAt: when,
          mode,
          location: String(b.location || "").trim() || requirement.location || null,
          round: Number.isFinite(Number(b.round)) && Number(b.round) > 0 ? Math.round(Number(b.round)) : 1,
          interviewer: String(b.interviewer || "").trim() || null,
          outcome: "pending",
          createdById: gate.user.id,
        },
      });

      // Booking a slot moves them to lined-up, and ties them to this opening if
      // they weren't already — otherwise the candidate list shows someone with
      // an interview tomorrow and no role against their name.
      await tx.candidate.update({
        where: { id: candidateId },
        data: {
          ...(["new", "contacted", "shortlisted"].includes(candidate.stage) ? { stage: "lined-up" } : {}),
          ...(candidate.requirementId ? {} : { requirementId }),
        },
      });

      return iv;
    });

    await prisma.auditLog
      .create({
        data: {
          userId: gate.user.id,
          action: "create",
          entity: "Interview",
          entityId: created.id,
          summary: `${candidate.name} → ${requirement.designation} on ${when.toLocaleString("en-IN")} (${mode})`,
        },
      })
      .catch((e) => console.error("[interviews] audit write failed:", e?.message));

    return NextResponse.json({ interview: created }, { status: 201 });
  } catch (e) {
    console.error("[POST /api/interviews]", e?.message || e);
    return NextResponse.json({ error: "Could not schedule the interview." }, { status: 500 });
  }
}

/**
 * May this person touch this candidate?
 *
 * A recruiter owns their own pipeline and nobody else's. Without this check,
 * PATCHing a colleague's interview with outcome "rejected" moves THEIR
 * candidate to dropped — quietly killing a live placement from another
 * account. GET was already scoped; the writes were not.
 */
function mayTouch(user, candidate) {
  if (!candidate) return false;
  if (can(user.role, "report.desk")) return true;
  return !candidate.ownerId || candidate.ownerId === user.id;
}

export async function PATCH(req) {
  const gate = await requireCapability("interview.write");
  if (!gate.ok) return gate.response;

  try {
    const b = await req.json().catch(() => ({}));
    const id = String(b.id || "");
    if (!id) return NextResponse.json({ error: "Which interview?" }, { status: 400 });

    const existing = await prisma.interview.findUnique({
      where: { id },
      include: { candidate: { select: { id: true, stage: true, name: true, ownerId: true } } },
    });
    if (!existing) return NextResponse.json({ error: "No such interview." }, { status: 404 });
    if (!mayTouch(gate.user, existing.candidate)) {
      return NextResponse.json({ error: "That interview is on someone else's candidate." }, { status: 403 });
    }

    const data = {};
    if (b.attended !== undefined) data.attended = b.attended === null ? null : !!b.attended;
    if (b.feedback !== undefined) data.feedback = String(b.feedback || "").trim() || null;
    if (b.interviewer !== undefined) data.interviewer = String(b.interviewer || "").trim() || null;
    if (b.mode !== undefined && MODES.includes(b.mode)) data.mode = b.mode;
    if (b.scheduledAt !== undefined) {
      const d = new Date(b.scheduledAt);
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json({ error: "Enter a valid date and time." }, { status: 400 });
      }
      data.scheduledAt = d;
    }
    if (b.outcome !== undefined) {
      if (!OUTCOMES.includes(b.outcome)) {
        return NextResponse.json({ error: `Unknown outcome "${b.outcome}".` }, { status: 400 });
      }
      data.outcome = b.outcome;
      // Recording an outcome at all means they turned up, unless it was a
      // no-show. Saves the recruiter a second click on every single interview.
      if (data.attended === undefined) {
        if (b.outcome === "no-show") data.attended = false;
        else if (b.outcome !== "pending") data.attended = true;
      }
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const iv = await tx.interview.update({ where: { id }, data });

      // Move the candidate to match, forward only.
      const nextStage =
        data.outcome === "selected" ? "selected"
        : data.outcome === "rejected" ? "dropped"
        : data.attended === true ? "interviewed"
        : null;
      if (nextStage && existing.candidate && existing.candidate.stage !== "joined") {
        await tx.candidate.update({
          where: { id: existing.candidate.id },
          data: { stage: nextStage },
        });
      }
      return iv;
    });

    return NextResponse.json({ interview: updated });
  } catch (e) {
    console.error("[PATCH /api/interviews]", e?.message || e);
    return NextResponse.json({ error: "Could not save the change." }, { status: 500 });
  }
}
