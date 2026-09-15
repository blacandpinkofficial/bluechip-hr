// /api/candidates — the people the desk is calling.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability, ownScope, can } from "@/lib/auth";
import { parseRupees } from "@/lib/money";
import { screen } from "@/lib/screening";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A recruiter's working day, as filters.
const QUEUES = {
  // Everyone, newest first.
  all: () => ({}),
  // Never been called. The top of the pile.
  new: () => ({ callCount: 0 }),
  // A callback was promised and the time has come.
  //
  // This reads Candidate.nextFollowUpAt, NOT "any call with a past
  // followUpAt". The latter looks equivalent and is not: once you actually
  // make the callback, that old call row still carries its past followUpAt,
  // so the candidate stays in the queue forever. Within a week the queue is
  // all handled callbacks and the recruiter stops trusting it — which is the
  // one queue that must never be wrong.
  due: (now) => ({
    nextFollowUpAt: { lte: now },
    stage: { notIn: ["joined", "dropped"] },
  }),
  // Live but going cold — the candidates quietly lost to inattention.
  cold: (now) => ({
    stage: { in: ["contacted", "shortlisted", "lined-up", "interviewed"] },
    OR: [
      { lastContactedAt: { lt: new Date(now.getTime() - 3 * 86400000) } },
      { lastContactedAt: null },
    ],
  }),
  // Everyone who has left the working list: not interested, or put aside. This
  // is a DESTINATION, not a bin. Nothing is ever deleted — the calls, the
  // notes, the number are all still here, because "we spoke to him in March
  // and he wanted 25k" is exactly what you need when the next opening lands,
  // and because a candidate who says no to one process says yes to another.
  history: () => ({
    OR: [{ archived: true }, { stage: "dropped" }],
  }),
};

export async function GET(req) {
  const gate = await requireCapability("candidate.read");
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const queue = url.searchParams.get("queue") || "all";
  const stage = url.searchParams.get("stage") || "";
  const q = (url.searchParams.get("q") || "").trim();
  const requirementId = url.searchParams.get("requirement") || "";
  const mine = url.searchParams.get("mine") === "1";
  const now = new Date();

  const queueWhere = (QUEUES[queue] || QUEUES.all)(now);
  const isHistory = queue === "history";

  // Built as an AND list rather than one spread object. Both the "cold" queue
  // and the search use a top-level OR, and spreading them into the same object
  // silently discards the first — the search would quietly widen the queue
  // instead of narrowing it, and nothing would look broken.
  const where = {
    AND: [
      // Two ways out of the working list, and both lead to the same place:
      // archived (put aside by hand or by a "not now") and dropped (said no on
      // a call). Everywhere except History, both are hidden — a recruiter
      // working a queue should not be reading past the people they already
      // finished with. An explicit ?stage= is honoured as asked, so a report
      // or a link can still ask for the dropped ones by name.
      isHistory ? {} : { archived: false },
      isHistory || stage ? {} : { stage: { not: "dropped" } },
      queueWhere,
      stage ? { stage } : {},
      requirementId ? { requirementId } : {},
      // A recruiter always sees only their own; a manager can narrow to theirs.
      mine ? { ownerId: gate.user.id } : ownScope(gate.user),
      q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { phone: { contains: q } },
              { designation: { contains: q, mode: "insensitive" } },
              { skills: { contains: q, mode: "insensitive" } },
            ],
          }
        : {},
    ],
  };

  const rows = await prisma.candidate.findMany({
    where,
    orderBy:
      queue === "due" ? [{ lastContactedAt: "asc" }]
      : queue === "cold" ? [{ lastContactedAt: "asc" }]
      // History reads newest-first: the person you set aside this morning is
      // the one you are most likely to be looking for.
      : isHistory ? [{ lastContactedAt: "desc" }]
      : [{ createdAt: "desc" }],
    take: 200,
    include: {
      owner: { select: { id: true, name: true } },
      requirement: {
        include: { client: { select: { name: true } } },
      },
      calls: {
        orderBy: { calledAt: "desc" },
        take: 1,
        select: { calledAt: true, outcome: true, notes: true, followUpAt: true },
      },
      _count: { select: { calls: true, interviews: true } },
    },
  });

  // "Last reached" is not "last dialled". Three no-answers in a row move
  // lastContactedAt every time and say nothing about whether anybody has
  // actually spoken to this person — which is the fact a telecaller needs
  // before deciding how to open the call. One grouped query for the whole
  // page, not one per row.
  const ids = rows.map((r) => r.id);
  const reached = ids.length
    ? await prisma.candidateCall
        .groupBy({
          by: ["candidateId"],
          where: { candidateId: { in: ids }, outcome: "connected" },
          _max: { calledAt: true },
        })
        .catch((e) => {
          console.error("[candidates] last-reached lookup failed:", e?.message);
          return [];
        })
    : [];
  const reachedAt = new Map(
    (Array.isArray(reached) ? reached : []).map((r) => [r.candidateId, r._max?.calledAt || null])
  );

  return NextResponse.json({
    candidates: rows.map((c) => {
      // Screening runs here, not in the browser: the requirement's criteria
      // are the client's business terms and a recruiter's device has no need
      // of the whole rulebook, only the verdict for the person in front of them.
      const s = c.requirement ? screen(c, c.requirement) : null;
      return {
        id: c.id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        designation: c.designation,
        location: c.location,
        expMonths: c.expMonths,
        currentCtc: c.currentCtc,
        expectedCtc: c.expectedCtc,
        noticeDays: c.noticeDays,
        source: c.source,
        skills: c.skills,
        stage: c.stage,
        status: c.status,
        rating: c.rating,
        archived: c.archived,
        hasRelieving: c.hasRelieving,
        hasArrears: c.hasArrears,
        education: c.education,
        callCount: c.callCount,
        lastContactedAt: c.lastContactedAt,
        // The last time anyone actually got through, as opposed to the last
        // time the number was dialled.
        lastConnectedAt: reachedAt.get(c.id) || null,
        // The single outstanding callback. The call list shows and edits it in
        // place, so it has to come down with the row.
        nextFollowUpAt: c.nextFollowUpAt,
        interviewCount: c._count.interviews,
        lastCall: c.calls[0] || null,
        owner: c.owner,
        // Flat, alongside the nested summary: the opening picker on the row
        // needs an id to compare against, not an object to dig through.
        requirementId: c.requirementId,
        requirement: c.requirement && {
          id: c.requirement.id,
          designation: c.requirement.designation,
          location: c.requirement.location,
          clientName: c.requirement.client?.name,
          takeHomeMin: c.requirement.takeHomeMin,
          takeHomeMax: c.requirement.takeHomeMax,
          relievingRequired: c.requirement.relievingRequired,
          arrearsAllowed: c.requirement.arrearsAllowed,
          educationMin: c.requirement.educationMin,
          expMinMonths: c.requirement.expMinMonths,
          expMaxMonths: c.requirement.expMaxMonths,
        },
        screening: s,
      };
    }),
    queue,
    canSeeWholeDesk: can(gate.user.role, "report.desk"),
  });
}

export async function POST(req) {
  const gate = await requireCapability("candidate.write");
  if (!gate.ok) return gate.response;

  // Parsed outside the try so the duplicate handler in the catch can still see
  // the number it was trying to write.
  const b = await req.json().catch(() => ({}));
  const name = String(b.name || "").trim();
  const phone = String(b.phone || "").replace(/[^\d+]/g, "").slice(-10);

  if (!name) return NextResponse.json({ error: "Enter the candidate's name." }, { status: 400 });
  if (phone.length !== 10) {
    return NextResponse.json(
      { error: "Enter a 10-digit mobile number." },
      { status: 400 }
    );
  }

  try {
    // One phone number, one person. Without this the same candidate arrives
    // three times from three sources and two recruiters call them the same
    // morning — which is exactly what the spreadsheet does today. Tell the
    // caller who already owns them rather than just refusing.
    const existing = await prisma.candidate.findUnique({
      where: { phone },
      include: { owner: { select: { name: true } } },
    });
    if (existing) return duplicateResponse(existing);

    // An opening that does not exist would otherwise surface as a foreign-key
    // error and a 500 that reads like the app is broken, when the real answer
    // is that the requirement was closed while the row was being typed.
    const requirementId = String(b.requirementId || "").trim() || null;
    if (requirementId) {
      const req2 = await prisma.requirement.findUnique({
        where: { id: requirementId },
        select: { id: true },
      });
      if (!req2) {
        return NextResponse.json(
          { error: "That opening no longer exists — pick another one." },
          { status: 400 }
        );
      }
    }

    const created = await prisma.candidate.create({
      data: {
        name,
        phone,
        email: String(b.email || "").trim().toLowerCase() || null,
        designation: String(b.designation || "").trim() || null,
        location: String(b.location || "").trim() || null,
        expMonths: intOrNull(b.expMonths),
        currentCtc: parseRupees(b.currentCtc),
        expectedCtc: parseRupees(b.expectedCtc),
        noticeDays: intOrNull(b.noticeDays),
        source: String(b.source || "").trim() || null,
        skills: String(b.skills || "").trim() || null,
        education: String(b.education || "").trim() || null,
        hasRelieving: typeof b.hasRelieving === "boolean" ? b.hasRelieving : null,
        hasArrears: typeof b.hasArrears === "boolean" ? b.hasArrears : null,
        requirementId,
        ownerId: gate.user.id,
        // Hand-entered or imported, everyone starts at the top of the pile.
        // Never anything else: this is a create, so there is no earlier stage
        // it could be moved backwards from.
        stage: "new",
      },
    });

    await prisma.auditLog
      .create({
        data: {
          userId: gate.user.id,
          action: "create",
          entity: "Candidate",
          entityId: created.id,
          summary: `Added ${created.name} (${created.phone})`,
        },
      })
      .catch((e) => console.error("[candidates] audit write failed:", e?.message));

    return NextResponse.json({ candidate: created }, { status: 201 });
  } catch (e) {
    // The findUnique above is a check, not a lock: two telecallers typing the
    // same referral at the same moment both pass it and one of them hits the
    // @@unique([phone]) index on the way in. That is a duplicate, not a
    // failure, and it must read exactly like the one caught above — a 500 here
    // would look like the app lost the candidate.
    if (e?.code === "P2002") {
      const clash = await prisma.candidate
        .findUnique({ where: { phone }, include: { owner: { select: { name: true } } } })
        .catch(() => null);
      if (clash) return duplicateResponse(clash);
      return NextResponse.json(
        { error: "That number is already on the list.", duplicate: true },
        { status: 409 }
      );
    }
    console.error("[POST /api/candidates]", e?.message || e);
    return NextResponse.json({ error: "Could not save the candidate." }, { status: 500 });
  }
}

/**
 * The one answer to "this number is already here". Says who it is, so the
 * caller can offer to open them instead of leaving a telecaller staring at a
 * refusal, and says where they are so the screen knows which queue to look in
 * — somebody set aside months ago lives in History and would not be found by a
 * search of the working list.
 */
function duplicateResponse(existing) {
  return NextResponse.json(
    {
      error: `${existing.name} is already on the list${existing.owner ? ` (with ${existing.owner.name})` : ""}.`,
      candidateId: existing.id,
      name: existing.name,
      phone: existing.phone,
      stage: existing.stage,
      archived: !!existing.archived,
      duplicate: true,
    },
    { status: 409 }
  );
}

// Blank is "not asked", not zero. Number("") is 0, which is finite and not
// negative, so the old version turned an untouched Experience box into
// "fresher" and an untouched Notice box into "can join immediately" — two
// answers nobody gave, on the two fields a client rejects people over.
function intOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}
