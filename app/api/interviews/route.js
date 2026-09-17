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
import { pageParams, pageMeta } from "@/lib/paging";

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

  const whenWhere =
    when === "today" ? { scheduledAt: { gte: startOfToday, lt: endOfToday } }
    : when === "past" ? { scheduledAt: { lt: startOfToday } }
    : when === "all" ? {}
    : { scheduledAt: { gte: startOfToday } };

  // Whose interviews, decided in the query rather than afterwards.
  //
  // This used to fetch the desk's next 300 and then drop the ones that were
  // not yours in JavaScript. On a busy desk that meant a recruiter was handed
  // 300 rows to read four of — and, worse, their fifth interview could sit at
  // position 301 and simply never appear, because the cut happened after the
  // limit rather than before it. Paging turns that from a slow leak into an
  // obvious one: page two would come back empty while interviews remained.
  //
  // The null branch is deliberate and matches what the old filter did: an
  // interview against a candidate nobody owns is everyone's to see, not
  // nobody's.
  const scope = can(gate.user.role, "report.desk")
    ? {}
    : { OR: [{ candidate: { ownerId: gate.user.id } }, { candidate: { ownerId: null } }] };

  const where = { AND: [whenWhere, scope] };
  const { take, skip } = pageParams(url);

  const rows = await prisma.interview.findMany({
    where,
    // id last — see the note in app/api/candidates/route.js. Interview
    // times are typed by hand and cluster on the hour, so ties are the rule
    // here rather than the exception.
    orderBy: [{ scheduledAt: when === "past" ? "desc" : "asc" }, { id: "asc" }],
    take,
    skip,
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

  // Already scoped by the query above — kept as a name because everything
  // below reads from it.
  const visible = rows;

  // The productivity numbers are for the whole filtered set, not for the page.
  // They were filters over `visible`, which is one page of rows — "Direct line
  // ups scheduled" would have quietly become "direct line ups among the first
  // hundred", which is a different sentence and reads like a drop in output.
  const countWhere = (extra) => prisma.interview.count({ where: { AND: [where, extra] } });
  const [totalCount, direct, telephonic, video, attended, selected] = await Promise.all([
    prisma.interview.count({ where }),
    countWhere({ mode: "direct" }),
    countWhere({ mode: "telephonic" }),
    countWhere({ mode: "video" }),
    countWhere({ attended: true }),
    countWhere({ outcome: "selected" }),
  ]);

  // Where did this interview come from? An interview exists because a CV went
  // to a client and the client said yes, and until now the two halves of that
  // one event lived on two screens that could not see each other. There is no
  // submissionId column on Interview, so the two are matched the only way the
  // schema allows — the (candidate, opening) pair, exactly as the placement
  // lookup below does. Read under candidate.read, because a submission carries
  // who sent it and what the client wrote back.
  const submissionBy = new Map();
  if (visible.length > 0 && can(gate.user.role, "candidate.read")) {
    const pairs = dedupePairs(visible);
    const subs = await prisma.submission
      .findMany({
        where: { OR: pairs },
        orderBy: { sentAt: "desc" },
        take: 600,
        select: {
          id: true, candidateId: true, requirementId: true,
          sentAt: true, status: true, method: true,
          sentBy: { select: { name: true } },
        },
      })
      .catch((e) => {
        console.error("[interviews] submission lookup failed:", e?.message);
        return [];
      });
    // Newest first, so the first one seen for a pair is the current one. A
    // candidate genuinely re-sent to the same opening months later has two
    // rows, and the interview belongs to the later of them.
    for (const s of subs) {
      const k = `${s.candidateId}::${s.requirementId}`;
      if (submissionBy.has(k)) continue;
      submissionBy.set(k, {
        id: s.id,
        sentAt: s.sentAt,
        status: s.status,
        method: s.method,
        sentByName: s.sentBy?.name || null,
      });
    }
  }

  // Has a selection already been turned into a placement? The screen needs to
  // know so it can offer the handover once and then stop offering it — there is
  // a unique constraint on (candidateId, requirementId), and a button that
  // always fails on the second press is worse than no button.
  //
  // Only the existence of the placement is looked up here, never its money.
  const placementBy = new Map();
  const selectedRows = visible.filter((i) => i.outcome === "selected");
  if (selectedRows.length > 0 && can(gate.user.role, "placement.read")) {
    const pairs = dedupePairs(selectedRows);
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
    ...pageMeta({ take, skip, totalCount, rows: visible }),
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
      // The submission this interview came out of, if the CV went through the
      // app. Null is a real answer — an interview can be booked off a phone
      // call with no CV ever having been sent.
      submission: submissionBy.get(`${i.candidateId}::${i.requirementId}`) || null,
    })),
    counts: {
      // "Direct Line ups scheduled" and "Telephonic scheduled" on the old
      // productivity tab are these two numbers. Counted by the database over
      // every interview in this view, not typed and not per-page.
      direct, telephonic, video, attended, selected,
    },
  });
}

/**
 * body: { candidateId, requirementId, scheduledAt, mode, location, round,
 *         interviewer, submissionId?, confirmDuplicate? }
 *
 * `submissionId` is what makes "the client said yes on the phone" one action
 * instead of three. The interview row, the submission's status and the
 * candidate's stage are the same event written in three places, and they are
 * written inside one transaction so they cannot disagree. Before this, the
 * submission screen could set the status string "interview-scheduled" and
 * nothing appeared on the Interviews screen at all.
 *
 * This lives here, in the interviews route, and not in the submissions route,
 * because everything that knows how to make a valid Interview already lives
 * here — the mode list, the round cap, the ownership rule, the forwards-only
 * stage mover. A second creator in the submissions route would be a second copy
 * of all of it, drifting from the day it was written. The submissions screen
 * calls this endpoint and passes the submission it is standing on.
 */
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

    // The same cap PATCH enforces. It was missing here, so a fat-fingered "202"
    // in the round box was refused on an edit and accepted on a booking.
    const round = b.round === undefined || b.round === null || b.round === "" ? 1 : Number(b.round);
    if (!Number.isFinite(round) || !Number.isInteger(round) || round < 1 || round > MAX_ROUND) {
      return NextResponse.json(
        { error: `The round must be a whole number between 1 and ${MAX_ROUND}.` },
        { status: 400 }
      );
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

    // ── the submission this is being booked from, if any ────────────────────
    //
    // Writing a Submission is a candidate.write act everywhere else in the app,
    // and whose submission it is matters — the submissions route lets you touch
    // your own or, with report.desk, the desk's. Both rules are enforced here
    // rather than assumed, because this handler is reachable directly.
    const submissionId = String(b.submissionId || "");
    let submission = null;
    if (submissionId) {
      if (!can(gate.user.role, "candidate.write")) {
        return NextResponse.json(
          { error: "You can book the interview, but not update the submission." },
          { status: 403 }
        );
      }
      submission = await prisma.submission.findUnique({ where: { id: submissionId } });
      if (!submission) {
        return NextResponse.json({ error: "That submission no longer exists." }, { status: 404 });
      }
      if (submission.candidateId !== candidateId || submission.requirementId !== requirementId) {
        return NextResponse.json(
          { error: "That submission is for a different candidate or opening." },
          { status: 400 }
        );
      }
      if (submission.sentById !== gate.user.id && !can(gate.user.role, "report.desk")) {
        return NextResponse.json({ error: "That is not your submission." }, { status: 403 });
      }
    }

    // ── one interview per round, not two ────────────────────────────────────
    //
    // Two recruiters taking the same call, or one recruiter pressing the button
    // twice, otherwise produces two rows for one panel: the counts double and
    // the candidate appears on the day sheet twice. Answered rather than
    // blocked — the caller is told what already exists and offered it, and a
    // genuine re-booking of the same round can say so.
    const siblings = await prisma.interview.findMany({
      where: { candidateId, requirementId },
      orderBy: { scheduledAt: "desc" },
      take: 50,
      select: { id: true, round: true, scheduledAt: true, mode: true, outcome: true, interviewer: true },
    });
    const clash = siblings.find((s) => (s.round || 1) === round);
    if (clash && !b.confirmDuplicate) {
      const maxRound = siblings.reduce((m, s) => Math.max(m, s.round || 1), 1);
      return NextResponse.json(
        {
          // The time is deliberately NOT formatted into this sentence. This
          // process runs in UTC, so a server-rendered "11:00" is half past four
          // in the afternoon to the person reading it. The instant goes back in
          // `existing` and the screen renders it against the reader's own clock.
          error: `Round ${round} is already booked for ${candidate.name} on this opening. Open it, or book the next round instead.`,
          needsConfirmation: true,
          existing: {
            id: clash.id,
            round: clash.round || 1,
            scheduledAt: clash.scheduledAt,
            mode: clash.mode,
            outcome: clash.outcome,
            interviewer: clash.interviewer,
          },
          // What to offer instead of a second identical row.
          nextRound: Math.min(maxRound + 1, MAX_ROUND),
        },
        { status: 409 }
      );
    }

    const mode = MODES.includes(b.mode) ? b.mode : "telephonic";

    const result = await prisma.$transaction(async (tx) => {
      const iv = await tx.interview.create({
        data: {
          candidateId,
          requirementId,
          scheduledAt: when,
          mode,
          location: String(b.location || "").trim() || requirement.location || null,
          round,
          interviewer: String(b.interviewer || "").trim() || null,
          outcome: "pending",
          createdById: gate.user.id,
        },
      });

      // Booking a slot moves them to lined-up, and ties them to this opening if
      // they weren't already — otherwise the candidate list shows someone with
      // an interview tomorrow and no role against their name.
      //
      // Forwards only, through the one stage mover in this file: someone
      // already at "interviewed" or "selected" is not pulled back to lined-up
      // because a second round was booked.
      const movedTo = await advanceStage(tx, candidateId, candidate.stage, "lined-up");
      if (!candidate.requirementId) {
        await tx.candidate.update({ where: { id: candidateId }, data: { requirementId } });
      }

      // The submission and the interview are the same event. Updated in the
      // same transaction as the row above, so the Submissions screen can never
      // claim an interview is scheduled while the Interviews screen has no
      // record of it — which is precisely what it used to do.
      let sub = null;
      if (submission) {
        sub = await tx.submission.update({
          where: { id: submission.id },
          data: {
            status: "interview-scheduled",
            // When the client responded, recorded once and never rewritten —
            // the chase list is measured from it. Same rule as the submissions
            // route's own PATCH.
            ...(submission.respondedAt ? {} : { respondedAt: new Date() }),
          },
        });
      }

      return { interview: iv, submission: sub, movedTo, candidateStage: movedTo || candidate.stage };
    });

    await prisma.auditLog
      .create({
        data: {
          userId: gate.user.id,
          action: "create",
          entity: "Interview",
          entityId: result.interview.id,
          summary:
            `${candidate.name} → ${requirement.designation} on ${when.toLocaleString("en-IN")} (${mode})` +
            (submission ? " — from the submission" : ""),
        },
      })
      .catch((e) => console.error("[interviews] audit write failed:", e?.message));

    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    console.error("[POST /api/interviews]", e?.message || e);
    return NextResponse.json({ error: "Could not schedule the interview." }, { status: 500 });
  }
}

/**
 * The distinct (candidate, opening) pairs in a list of interviews, as Prisma
 * OR clauses. Two rounds of the same interview are two rows with one pair, and
 * sending the pair twice makes the lookup do twice the work for the same answer.
 */
function dedupePairs(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = `${r.candidateId}::${r.requirementId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ candidateId: r.candidateId, requirementId: r.requirementId });
  }
  return out;
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
