// POST /api/candidates/[id]/calls — log one dial.
//
// This is the single most-used write in the whole app, and the one that makes
// the "Daily productivity" tab of the old workbook unnecessary: counting rows
// here by recruiter and day IS "No of Calls for the day". Nobody tallies their
// own calls at seven in the evening any more, and nobody rounds up.
//
// It does three things atomically — append the call, stamp the candidate's
// last-contacted, bump the counter — because a call that logs but doesn't move
// the candidate out of the "never called" queue means the next recruiter dials
// them again ten minutes later.
//
// It is also the ONLY write behind the one-click buttons on the call list, so
// that a whole outcome is one round trip while somebody is still on the phone:
//
//   { outcome }                       log it, infer the obvious stage move
//   { outcome: "connected", advance } log it and move them to the next stage
//   { outcome, archive: true|false }  log it and move them into, or out of,
//                                     History — which is a filter, never a
//                                     delete; every call stays on the record.
//
// There is deliberately no second endpoint for "advance the stage": two writes
// means one of them can fail, and the one that fails is always the one that
// matters.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability, can } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OUTCOMES = ["connected", "no-answer", "busy", "wrong-number", "not-interested", "callback"];

// What a call outcome implies about the candidate's stage, when the stage
// hasn't been set by hand. Only ever moves forward: a no-answer on someone
// already lined up must not drag them back to "contacted".
const STAGE_ORDER = ["new", "contacted", "shortlisted", "lined-up", "interviewed", "selected", "joined", "dropped"];

// "Ready for next" on the call list: one button that says the candidate is
// interested and clears whatever the last step was, so they move on without
// anybody opening a form. Where "on" is depends on where they are now.
//
// It stops at interviewed on purpose. Selected and joined are money, and they
// are recorded through Placements where the offer and the joining date are
// captured; a recruiter must not be able to mark someone placed with one
// click on a list.
const ADVANCE_NEXT = {
  new: "shortlisted",
  contacted: "shortlisted",
  shortlisted: "lined-up",
  "lined-up": "interviewed",
};

export async function POST(req, { params }) {
  const gate = await requireCapability("candidate.write");
  if (!gate.ok) return gate.response;

  try {
    const candidateId = params?.id;
    const b = await req.json().catch(() => ({}));
    const outcome = String(b.outcome || "").trim();

    if (!OUTCOMES.includes(outcome)) {
      return NextResponse.json(
        { error: `Outcome must be one of: ${OUTCOMES.join(", ")}` },
        { status: 400 }
      );
    }

    const candidate = await prisma.candidate.findUnique({ where: { id: candidateId } });
    if (!candidate) return NextResponse.json({ error: "No such candidate." }, { status: 404 });

    if (!can(gate.user.role, "report.desk") && candidate.ownerId && candidate.ownerId !== gate.user.id) {
      return NextResponse.json(
        { error: "This candidate belongs to another recruiter." },
        { status: 403 }
      );
    }

    let followUpAt = null;
    if (b.followUpAt) {
      const d = new Date(b.followUpAt);
      if (!Number.isNaN(d.getTime())) followUpAt = d;
    }
    if (outcome === "callback" && !followUpAt) {
      return NextResponse.json(
        { error: "A callback needs a time — otherwise it is just a note nobody sees again." },
        { status: 400 }
      );
    }

    // A connected call means they have been spoken to. Anything else means the
    // phone rang; it does not.
    const implied = outcome === "connected" ? "contacted"
                  : outcome === "not-interested" ? "dropped"
                  : null;
    const shouldAdvance =
      implied &&
      STAGE_ORDER.indexOf(implied) > STAGE_ORDER.indexOf(candidate.stage) &&
      // "dropped" is terminal and must never be inferred over a real outcome
      // like "selected" just because someone logged a stray call.
      !(implied === "dropped" && ["selected", "joined"].includes(candidate.stage));

    // The call list's "Ready for next" button. Asked for explicitly by the
    // caller rather than guessed from the outcome, because "we spoke" and "they
    // are good for the next step" are two different pieces of news and only the
    // recruiter knows the second. Requires a connected call: you cannot move
    // somebody on from a ringing phone.
    let nextStage = shouldAdvance ? implied : null;
    if (b.advance === true) {
      if (outcome !== "connected") {
        return NextResponse.json(
          { error: "Only a connected call can move someone on." },
          { status: 400 }
        );
      }
      // Missing from the map means there is nowhere sensible left to go —
      // interviewed, selected, joined, dropped. Those move through Interviews
      // and Placements, not from here.
      nextStage = ADVANCE_NEXT[candidate.stage] || nextStage;
    }

    // Leaving the working list is not deletion. An archived candidate keeps
    // every call, note and callback ever logged and sits in History, one click
    // from being brought back.
    let archived;
    if (typeof b.archive === "boolean") {
      archived = b.archive;
    } else if (nextStage === "dropped") {
      // Not interested means not now. They come off the list the recruiter is
      // working, and stay on the books.
      archived = true;
    }

    const [call] = await prisma.$transaction([
      prisma.candidateCall.create({
        data: {
          candidateId,
          userId: gate.user.id,
          outcome,
          notes: String(b.notes || "").trim() || null,
          followUpAt,
        },
      }),
      prisma.candidate.update({
        where: { id: candidateId },
        data: {
          lastContactedAt: new Date(),
          callCount: { increment: 1 },
          // Set when a callback was promised, CLEARED otherwise. Clearing is
          // the half that matters: without it, making the callback leaves the
          // candidate sitting in the "due" queue permanently.
          nextFollowUpAt: followUpAt,
          ...(nextStage && nextStage !== candidate.stage ? { stage: nextStage } : {}),
          ...(archived === undefined ? {} : { archived }),
          // Claim an unowned candidate for whoever actually did the work.
          ...(candidate.ownerId ? {} : { ownerId: gate.user.id }),
        },
      }),
    ]);

    return NextResponse.json(
      {
        call,
        stage: nextStage || candidate.stage,
        archived: archived === undefined ? candidate.archived : archived,
      },
      { status: 201 }
    );
  } catch (e) {
    console.error("[POST /api/candidates/[id]/calls]", e?.message || e);
    return NextResponse.json({ error: "Could not log the call." }, { status: 500 });
  }
}

/**
 * PATCH — write the remark against the call that has just been made.
 *
 * The note a recruiter wants to leave arrives AFTER the outcome button has
 * been pressed: they click "Connected" while the phone is still at their ear,
 * and the useful sentence ("wants 22k, can join in a week, wife works in
 * Sholinganallur") only forms once the call is over. Until now the only way to
 * attach it was to log a second call, which is how a desk's call count stops
 * meaning anything.
 *
 * So this edits the most recent call rather than creating one: no callCount
 * increment, no lastContactedAt touch, and above all no stage write — a remark
 * is not news about where the candidate has got to.
 */
export async function PATCH(req, { params }) {
  const gate = await requireCapability("candidate.write");
  if (!gate.ok) return gate.response;

  try {
    const candidateId = params?.id;
    const b = await req.json().catch(() => ({}));
    if (b.notes === undefined) {
      return NextResponse.json({ error: "Nothing to save." }, { status: 400 });
    }

    const candidate = await prisma.candidate.findUnique({
      where: { id: candidateId },
      select: { id: true, ownerId: true },
    });
    if (!candidate) return NextResponse.json({ error: "No such candidate." }, { status: 404 });

    // Same boundary as POST and GET above: a recruiter writes on their own
    // candidates, the desk roles write on anyone's.
    if (!can(gate.user.role, "report.desk") && candidate.ownerId && candidate.ownerId !== gate.user.id) {
      return NextResponse.json(
        { error: "This candidate belongs to another recruiter." },
        { status: 403 }
      );
    }

    // Scoped to the candidate either way, so a call id belonging to somebody
    // else's candidate is simply not found rather than quietly edited.
    const target = b.callId
      ? await prisma.candidateCall.findFirst({
          where: { id: String(b.callId), candidateId },
        })
      : await prisma.candidateCall.findFirst({
          where: { candidateId },
          orderBy: { calledAt: "desc" },
        });

    if (!target) {
      return NextResponse.json(
        { error: "There is no call to write this against yet — log the call first." },
        { status: 409 }
      );
    }

    const notes = String(b.notes || "").trim().slice(0, 2000);
    const call = await prisma.candidateCall.update({
      where: { id: target.id },
      data: { notes: notes || null },
    });

    return NextResponse.json({ call });
  } catch (e) {
    console.error("[PATCH /api/candidates/[id]/calls]", e?.message || e);
    return NextResponse.json({ error: "Could not save the note." }, { status: 500 });
  }
}

export async function GET(req, { params }) {
  const gate = await requireCapability("candidate.read");
  if (!gate.ok) return gate.response;

  // The POST handler in this file checks ownership; this GET did not, so any
  // candidate id returned the last fifty calls on a colleague's candidate —
  // including the free-text notes of what was actually said on the phone.
  // Candidate ids are easy to come by: the duplicate-phone response on
  // POST /api/candidates hands one over for any number.
  const owner = await prisma.candidate.findUnique({
    where: { id: params?.id },
    select: { ownerId: true },
  });
  if (!owner) return NextResponse.json({ error: "No such candidate." }, { status: 404 });
  if (owner.ownerId && owner.ownerId !== gate.user.id && !can(gate.user.role, "report.desk")) {
    return NextResponse.json({ error: "That candidate belongs to someone else on the desk." }, { status: 403 });
  }

  const calls = await prisma.candidateCall.findMany({
    where: { candidateId: params?.id },
    orderBy: { calledAt: "desc" },
    take: 50,
    include: { user: { select: { name: true } } },
  });

  return NextResponse.json({ calls });
}
