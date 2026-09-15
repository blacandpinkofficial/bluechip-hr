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

// The outcome vocabulary, as a real runtime list and not a comment on the
// schema. Anything not on this list is refused: an outcome is read back by the
// productivity counts, by Reports and by the candidate's stage, and one typo'd
// value ("Selected", "select") is a row that is counted by nothing and noticed
// by nobody until the month is closed.
const OUTCOMES = ["pending", "selected", "rejected", "on-hold", "no-show"];

// A round is a small positive integer. The cap is not fussiness — a fat-finger
// "202" in the round box makes the interview sort and read as nonsense forever.
const MAX_ROUND = 20;

// The candidate pipeline, in order. Used to move a candidate FORWARDS only.
// "dropped" is deliberately NOT in this list, and that is exactly why every
// index is checked against -1 before it is compared. indexOf("dropped") is -1,
// and -1 is less than every real index, so an unchecked comparison reads as
// "miles behind, push them forward" and quietly resurrects a dropped candidate.
// Any unrecognised stage is left exactly as it is rather than guessed at.
const ORDER = ["new", "contacted", "shortlisted", "lined-up", "interviewed", "selected", "joined"];
const SELECTED_AT = ORDER.indexOf("selected");

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
          client: { select: { id: true, name: true } },
        },
      },
    },
  });

  // A recruiter sees the interviews for their own candidates. The desk view is
  // a manager's job.
  const visible = can(gate.user.role, "report.desk")
    ? rows
    : rows.filter((r) => !r.candidate?.ownerId || r.candidate.ownerId === gate.user.id);

  // Has a selection already been turned into a placement? The screen needs to
  // know so it can offer the handover once and then stop offering it — there is
  // a unique constraint on (candidateId, requirementId), and a button that
  // always fails on the second press is worse than no button.
  //
  // Only the existence of the placement is looked up here, never its money.
  const placementBy = new Map();
  const selectedRows = visible.filter((i) => i.outcome === "selected");
  if (selectedRows.length > 0 && can(gate.user.role, "placement.read")) {
    const pairs = selectedRows.map((i) => ({
      candidateId: i.candidateId,
      requirementId: i.requirementId,
    }));
    const placed = await prisma.placement
      .findMany({
        where: { OR: pairs },
        select: {
          id: true, candidateId: true, requirementId: true,
          joinedOn: true, droppedOn: true,
        },
      })
      .catch((e) => {
        console.error("[interviews] placement lookup failed:", e?.message);
        return [];
      });
    for (const p of placed) {
      placementBy.set(`${p.candidateId}::${p.requirementId}`, {
        id: p.id,
        joined: !!p.joinedOn,
        dropped: !!p.droppedOn,
      });
    }
  }

  return NextResponse.json({
    when,
    // What this person may actually do, decided here by capability and never by
    // a role string in the browser. The screen hides what it cannot do; the
    // handlers below refuse it regardless.
    me: {
      id: gate.user.id,
      canWrite: can(gate.user.role, "interview.write"),
      canPlace: can(gate.user.role, "placement.write"),
      canSeePlacements: can(gate.user.role, "placement.read"),
    },
    interviews: visible.map((i) => ({
      id: i.id,
      candidateId: i.candidateId,
      requirementId: i.requirementId,
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
      placement: placementBy.get(`${i.candidateId}::${i.requirementId}`) || null,
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
      //
      // Forwards only: someone already at "interviewed" or "selected" is not
      // pulled back to lined-up because a second round was booked.
      const at = ORDER.indexOf(candidate.stage);
      const to = ORDER.indexOf("lined-up");
      const moveUp = at >= 0 && at < to;
      await tx.candidate.update({
        where: { id: candidateId },
        data: {
          ...(moveUp ? { stage: "lined-up", archived: false } : {}),
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

/**
 * Move a candidate forward to `target`, never backward, never sideways.
 *
 * Both indexes are checked against -1 before they are compared — see ORDER at
 * the top of the file for why that is not optional. Returns the stage it moved
 * to, or null if it left the candidate alone.
 */
async function advanceStage(tx, candidateId, currentStage, target) {
  const to = ORDER.indexOf(target);
  if (to < 0) return null;
  const at = ORDER.indexOf(currentStage);
  if (at < 0 || at >= to) return null;
  // Un-archive as we go. A candidate set aside by hand keeps archived:true, and
  // every working queue filters on archived:false — so without this the
  // interview moves them up the pipeline and straight out of the call list.
  await tx.candidate.update({
    where: { id: candidateId },
    data: { stage: target, archived: false },
  });
  return target;
}

/**
 * A rejection at interview drops the candidate — but only if they are not
 * already further on than that. Someone at "selected" or "joined" has an offer
 * somewhere; a rejection recorded later on a different opening must not reach
 * back and kill it. An unrecognised stage (including "dropped" itself, which is
 * not in ORDER) is left alone.
 */
async function markDropped(tx, candidateId, currentStage) {
  const at = ORDER.indexOf(currentStage);
  if (at < 0 || at >= SELECTED_AT) return null;
  await tx.candidate.update({ where: { id: candidateId }, data: { stage: "dropped" } });
  return "dropped";
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
    if (b.location !== undefined) data.location = String(b.location || "").trim() || null;
    if (b.mode !== undefined && MODES.includes(b.mode)) data.mode = b.mode;
    if (b.scheduledAt !== undefined) {
      const d = new Date(b.scheduledAt);
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json({ error: "Enter a valid date and time." }, { status: 400 });
      }
      data.scheduledAt = d;
    }
    if (b.round !== undefined) {
      const n = Number(b.round);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > MAX_ROUND) {
        return NextResponse.json(
          { error: `The round must be a whole number between 1 and ${MAX_ROUND}.` },
          { status: 400 }
        );
      }
      data.round = n;
      // A later round starts over: the panel has not happened yet, so the
      // attendance mark and the outcome from the previous round must not be
      // left standing against it. Without this a second round shows up already
      // "selected" the moment it is booked.
      if (n > existing.round && b.outcome === undefined && b.attended === undefined) {
        data.outcome = "pending";
        data.attended = null;
      }
    }
    if (b.outcome !== undefined) {
      if (!OUTCOMES.includes(b.outcome)) {
        return NextResponse.json({ error: `Unknown outcome "${b.outcome}".` }, { status: 400 });
      }
      data.outcome = b.outcome;
      // Recording an outcome at all means they turned up, unless it was a
      // no-show. Saves the recruiter a second click on every single interview.
      if (b.attended === undefined) {
        if (b.outcome === "no-show") data.attended = false;
        else if (b.outcome !== "pending") data.attended = true;
      }
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }

    const result = await prisma.$transaction(async (tx) => {
      const iv = await tx.interview.update({ where: { id }, data });

      // Pull the candidate along to match what just happened, forwards only.
      //
      // Each fact has a floor, and the furthest-forward floor wins: booking a
      // time means at least lined-up, turning up means at least interviewed,
      // and a selection means selected. Nothing here can move anyone back, so
      // the order these are applied in does not change the answer.
      let stage = existing.candidate?.stage || null;
      let moved = null;

      if (existing.candidate) {
        let floor = null;
        const raise = (s) => {
          if (ORDER.indexOf(s) > ORDER.indexOf(floor)) floor = s;
        };
        if (data.scheduledAt !== undefined) raise("lined-up");
        if (data.attended === true) raise("interviewed");
        if (data.outcome === "selected") raise("selected");

        if (floor) {
          const to = await advanceStage(tx, existing.candidate.id, stage, floor);
          if (to) { stage = to; moved = to; }
        }
        if (data.outcome === "rejected") {
          const to = await markDropped(tx, existing.candidate.id, stage);
          if (to) { stage = to; moved = to; }
        }
      }

      return { interview: iv, candidateStage: stage, movedTo: moved };
    });

    return NextResponse.json(result);
  } catch (e) {
    console.error("[PATCH /api/interviews]", e?.message || e);
    return NextResponse.json({ error: "Could not save the change." }, { status: 500 });
  }
}
