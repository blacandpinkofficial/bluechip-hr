// /api/submissions — the CV went to the client, and here is the proof.
//
// The row is written even when the email fails. That ordering is the whole
// point: the recruiter did the work, and losing the record because an SMTP
// server was down would mean the desk has no evidence of a submission it
// actually made. Email is a convenience layered on top of the record, never the
// other way round.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability, can } from "@/lib/auth";
import { sendMail, submissionEmail, mailReady } from "@/lib/mailer";
import { getSettings } from "@/lib/settings";
import { resolveKey } from "@/lib/storage";
import fs from "fs/promises";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = ["sent", "acknowledged", "shortlisted", "interview-scheduled", "rejected", "no-response"];

// The candidate pipeline, in order. Used to move a candidate FORWARDS only.
// "dropped" is deliberately NOT in this list, and that is exactly why the index
// must be checked for -1 first. indexOf("dropped") is -1, and -1 is less than
// 2, so the naive comparison quietly moved a dropped candidate FORWARDS to
// shortlisted — the precise thing this guard exists to stop. Any unrecognised
// stage is left alone rather than guessed at.
const ORDER = ["new", "contacted", "shortlisted", "lined-up", "interviewed", "selected", "joined"];

// What a client's reply honestly tells us about the candidate, and nothing
// more. A client acknowledging receipt says nothing about the candidate, so it
// moves nobody. A rejection does NOT move anyone to "dropped": the client
// passed on them for THIS opening, which is not the same as the candidate being
// out of play, and the stage rule only ever moves forwards anyway.
const STAGE_FLOOR = {
  shortlisted: "shortlisted",
  "interview-scheduled": "lined-up",
};

// A reply is a reply. "no-response" is the absence of one, so it must not stamp
// a responded-at date — that date is what the chase list is measured from.
const REPLIED = ["acknowledged", "shortlisted", "interview-scheduled", "rejected"];

// Enough to name the file type on the way out. Anything not listed goes without
// a content type, which is better than asserting the wrong one.
const MIME = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".rtf": "application/rtf",
};

export async function GET(req) {
  const gate = await requireCapability("candidate.read");
  if (!gate.ok) return gate.response;
  const { user } = gate;

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const clientId = url.searchParams.get("clientId");
  const candidateId = url.searchParams.get("candidateId");

  // A recruiter sees their own submissions; a manager sees the desk. Same rule
  // as everywhere else in the app, using the same helper so it cannot drift.
  const scope = can(user.role, "report.desk") ? {} : { sentById: user.id };

  const rows = await prisma.submission.findMany({
    where: {
      ...scope,
      ...(status ? { status } : {}),
      ...(clientId ? { clientId } : {}),
      ...(candidateId ? { candidateId } : {}),
    },
    orderBy: { sentAt: "desc" },
    take: 300,
    include: {
      candidate: { select: { id: true, name: true, phone: true, designation: true } },
      requirement: { select: { id: true, designation: true, location: true } },
      client: { select: { id: true, name: true, hrName: true, hrEmail: true } },
      sentBy: { select: { id: true, name: true } },
    },
  });

  // Is there an actual interview behind "interview-scheduled"? Until now this
  // screen could say an interview was scheduled while the Interviews screen sat
  // empty, because the status was a string and nothing else. There is no
  // submissionId column on Interview, so the two are matched on the (candidate,
  // opening) pair — the same key the interviews route uses to find placements.
  const interviewBy = new Map();
  const canSeeInterviews = can(user.role, "interview.read");
  if (rows.length > 0 && canSeeInterviews) {
    const seen = new Set();
    const pairs = [];
    for (const r of rows) {
      const k = `${r.candidateId}::${r.requirementId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      pairs.push({ candidateId: r.candidateId, requirementId: r.requirementId });
    }
    const ivs = await prisma.interview
      .findMany({
        where: { OR: pairs },
        // Latest round first, and within a round the latest booking. That is
        // the one the desk is working towards; earlier rounds are history.
        orderBy: [{ round: "desc" }, { scheduledAt: "desc" }],
        take: 600,
        select: {
          id: true, candidateId: true, requirementId: true,
          scheduledAt: true, mode: true, round: true,
          interviewer: true, attended: true, outcome: true,
        },
      })
      .catch((e) => {
        console.error("[submissions] interview lookup failed:", e?.message);
        return [];
      });
    for (const iv of ivs) {
      const k = `${iv.candidateId}::${iv.requirementId}`;
      if (interviewBy.has(k)) continue;
      interviewBy.set(k, {
        id: iv.id,
        scheduledAt: iv.scheduledAt,
        mode: iv.mode,
        round: iv.round,
        interviewer: iv.interviewer,
        attended: iv.attended,
        outcome: iv.outcome,
      });
    }
  }

  const now = Date.now();
  const withAge = rows.map((r) => ({
    ...r,
    daysSilent: r.status === "sent" ? Math.floor((now - new Date(r.sentAt).getTime()) / 86400000) : null,
    // Null is a real answer: no interview has been booked for this candidate on
    // this opening.
    interview: interviewBy.get(`${r.candidateId}::${r.requirementId}`) || null,
  }));

  return NextResponse.json({
    submissions: withAge,
    statuses: STATUSES,
    // Counted server-side so every screen showing this number shows the same one.
    silent: withAge.filter((r) => r.status === "sent" && r.daysSilent >= 4).length,
    mailConfigured: mailReady(await getSettings()),
    me: user.id,
    // What this person may actually do, decided here by capability and never by
    // a role string in the browser. Booking the interview is a separate
    // capability from recording the client's reply, and the screen must hide
    // the button it would only be refused for.
    canSeeInterviews,
    // Both, because booking from here writes an Interview AND this Submission,
    // and the handler that does it checks both. Showing a button for one of the
    // two would be a button that is refused the moment it is pressed.
    canScheduleInterview: can(user.role, "interview.write") && can(user.role, "candidate.write"),
    // How many submissions claim an interview that does not exist. Zero is the
    // healthy answer. Null, not zero, when this person cannot read interviews:
    // the lookup above did not run, so the honest answer is "not known" rather
    // than a reassuring number nobody computed.
    scheduledWithoutInterview: canSeeInterviews
      ? withAge.filter((r) => r.status === "interview-scheduled" && !r.interview).length
      : null,
  });
}

/**
 * body: { candidateId, requirementId, method, toEmail, send: bool, note }
 */
export async function POST(req) {
  const gate = await requireCapability("candidate.write");
  if (!gate.ok) return gate.response;
  const { user } = gate;

  const b = await req.json().catch(() => ({}));
  const candidateId = String(b.candidateId || "");
  const requirementId = String(b.requirementId || "");
  if (!candidateId || !requirementId) {
    return NextResponse.json({ error: "Pick a candidate and an opening." }, { status: 400 });
  }

  const [candidate, requirement] = await Promise.all([
    prisma.candidate.findUnique({ where: { id: candidateId } }),
    prisma.requirement.findUnique({ where: { id: requirementId }, include: { client: true } }),
  ]);
  if (!candidate) return NextResponse.json({ error: "That candidate does not exist." }, { status: 404 });
  if (!requirement) return NextResponse.json({ error: "That opening does not exist." }, { status: 404 });

  // Without this, a recruiter could post any candidate id and have that
  // person's CV emailed to an address of their choosing — the entire candidate
  // database, one id at a time. PATCH below already checked ownership; POST,
  // which is the one that actually sends the file, did not.
  if (candidate.ownerId && candidate.ownerId !== user.id && !can(user.role, "report.desk")) {
    return NextResponse.json(
      { error: "That candidate belongs to someone else on the desk." },
      { status: 403 }
    );
  }

  // Sending the same CV to the same opening twice makes the desk look
  // disorganised to the client and wastes the candidate's goodwill. Warned
  // rather than blocked — a genuine resubmission after two months is normal.
  const recent = await prisma.submission.findFirst({
    where: { candidateId, requirementId },
    orderBy: { sentAt: "desc" },
  });
  if (recent && !b.confirmDuplicate) {
    const days = Math.floor((Date.now() - new Date(recent.sentAt).getTime()) / 86400000);
    return NextResponse.json(
      {
        error: `${candidate.name} was already sent to ${requirement.client?.name || "this client"} for this opening ${days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`} (${recent.status}).`,
        needsConfirmation: true,
      },
      { status: 409 }
    );
  }

  const method = ["email", "whatsapp", "portal", "in-person"].includes(b.method) ? b.method : "email";

  // The destination is the CLIENT's address on file, never one supplied with
  // the request. A caller-chosen address turns "send this CV to the client"
  // into "send this CV anywhere", and the attachment is a real person's
  // private document. Changing where a client's CVs go is a deliberate edit on
  // the client record, which is owner/manager only.
  const toEmail = String(requirement.client?.hrEmail || "").trim() || null;

  const settings = await getSettings();
  const mail = submissionEmail({
    candidate,
    requirement,
    client: requirement.client,
    sender: { name: user.name, phone: b.senderPhone || null },
    companyName: settings.companyName,
  });

  // ── the record, first ─────────────────────────────────────────────────────
  const submission = await prisma.submission.create({
    data: {
      candidateId,
      requirementId,
      clientId: requirement.clientId,
      sentById: user.id,
      method,
      toEmail,
      subject: mail.subject,
      status: "sent",
      response: String(b.note || "").trim() || null,
    },
  });

  // Moving the candidate on is the point of submitting them. Only forwards —
  // a candidate already at "interviewed" does not go back to "shortlisted"
  // because someone sent the CV to a second client. See ORDER at the top of the
  // file for why the -1 check is not optional.
  await advanceStage(candidateId, candidate.stage, "shortlisted");

  // ── the email, second and optional ────────────────────────────────────────
  let mailResult = { ok: false, reason: "Not sent — recorded only." };
  if (b.send && method === "email") {
    if (!toEmail) {
      mailResult = { ok: false, reason: `No email address for ${requirement.client?.name || "this client"}.` };
    } else {
      const attachments = [];
      if (candidate.resumeKey) {
        try {
          const path = resolveKey(candidate.resumeKey);
          // null means the key tried to escape the uploads directory. That is
          // not a missing file, it is a stored key that should not exist.
          if (!path) throw new Error(`refused to read key outside uploads: ${candidate.resumeKey}`);
          // The stored key keeps the original extension (storage.js), and it
          // is the only record of the file type — Candidate has no mimeType
          // column. Without it the recipient gets an attachment called
          // "Ramesh Kumar CV" with no extension, which Windows and most mail
          // clients simply refuse to open.
          const ext = (candidate.resumeKey.match(/\.[a-z0-9]+$/i) || [""])[0].toLowerCase();
          attachments.push({
            filename: `${candidate.name.replace(/[^\w\s-]/g, "").trim()} CV${ext}`,
            contentType: MIME[ext] || undefined,
            content: await fs.readFile(path),
          });
        } catch (e) {
          console.error("[submission] could not attach CV:", e?.message || e);
        }
      }
      mailResult = await sendMail({
        to: toEmail,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        replyTo: user.email,
        attachments,
      });
      if (!mailResult.ok && attachments.length === 0 && candidate.resumeKey) {
        mailResult.reason += " (the CV file could not be read, either)";
      }
    }
  }

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "create",
      entity: "Submission",
      entityId: submission.id,
      summary: `${candidate.name} → ${requirement.client?.name || "client"} for ${requirement.designation}`,
    },
  }).catch(() => {});

  return NextResponse.json({
    submission,
    mail: mailResult,
    // Two separate facts, said separately, because they can differ and the
    // recruiter needs to know which one happened.
    message: mailResult.ok
      ? `Recorded, and the email went to ${toEmail}.`
      : `Recorded. ${mailResult.reason}`,
  });
}

/** body: { id, status, response } */
export async function PATCH(req) {
  const gate = await requireCapability("candidate.write");
  if (!gate.ok) return gate.response;
  const { user } = gate;

  const b = await req.json().catch(() => ({}));
  const id = String(b.id || "");
  if (!id) return NextResponse.json({ error: "Which submission?" }, { status: 400 });

  const status = b.status ? String(b.status) : null;
  if (status && !STATUSES.includes(status)) {
    return NextResponse.json({ error: `Status must be one of: ${STATUSES.join(", ")}` }, { status: 400 });
  }
  if (!status && b.response === undefined) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  const existing = await prisma.submission.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "That submission no longer exists." }, { status: 404 });
  if (existing.sentById !== user.id && !can(user.role, "report.desk")) {
    return NextResponse.json({ error: "That is not your submission." }, { status: 403 });
  }

  const row = await prisma.submission.update({
    where: { id },
    data: {
      ...(status ? { status } : {}),
      // The moment of the reply is recorded the first time a reply is recorded,
      // and not overwritten afterwards — it is when the client responded, not
      // when someone last edited the note.
      ...(status && REPLIED.includes(status) && !existing.respondedAt ? { respondedAt: new Date() } : {}),
      ...(b.response !== undefined ? { response: String(b.response || "").trim() || null } : {}),
    },
  });

  // A client shortlisting someone is a real fact about that candidate, and the
  // candidate screen is where the desk looks. Recording it in one place and not
  // the other is how a candidate ends up sitting at "contacted" with an
  // interview booked. Forwards only, same rule as everywhere else.
  let movedTo = null;
  const floor = status ? STAGE_FLOOR[status] : null;
  if (floor) {
    const candidate = await prisma.candidate
      .findUnique({ where: { id: row.candidateId }, select: { id: true, stage: true } })
      .catch(() => null);
    if (candidate) movedTo = await advanceStage(candidate.id, candidate.stage, floor);
  }

  // Setting the status by hand is still allowed — someone correcting a week-old
  // row should not be forced to invent a date and time. But the status on its
  // own puts nothing on the Interviews screen and nothing on anyone's day
  // sheet, so the screen is told, and it can offer to book the slot properly.
  // Booking it is POST /api/interviews with this submission's id, which writes
  // the interview, this status and the candidate's stage in one transaction.
  let interview;
  if (status === "interview-scheduled" && can(user.role, "interview.read")) {
    interview = await prisma.interview
      .findFirst({
        where: { candidateId: row.candidateId, requirementId: row.requirementId },
        orderBy: [{ round: "desc" }, { scheduledAt: "desc" }],
        select: { id: true, scheduledAt: true, round: true, mode: true, outcome: true },
      })
      .catch(() => null);
  }

  return NextResponse.json({
    submission: row,
    candidateStage: movedTo,
    ...(interview !== undefined
      ? { interview: interview || null, interviewMissing: !interview }
      : {}),
  });
}

/**
 * Move a candidate forward to `target`, never backward, never sideways.
 *
 * Both indexes are checked against -1 before they are compared. A stage that is
 * not in ORDER — "dropped", or anything a future migration adds — has an index
 * of -1, and -1 is less than every real index, so an unchecked comparison reads
 * as "miles behind, push them forward". That is how a dropped candidate gets
 * resurrected by a client's reply. Unknown stages are left exactly as they are.
 *
 * Returns the stage it moved to, or null if it left the candidate alone.
 */
async function advanceStage(candidateId, currentStage, target) {
  const at = ORDER.indexOf(currentStage);
  const to = ORDER.indexOf(target);
  if (at < 0 || to < 0 || at >= to) return null;
  // Un-archive as we go. A candidate set aside by hand keeps archived:true,
  // and every working queue filters on archived:false — so without this the
  // client's reply moves them up the pipeline and straight out of the call
  // list, visible only under History, where nobody is dialling.
  const ok = await prisma.candidate
    .update({ where: { id: candidateId }, data: { stage: target, archived: false } })
    .then(() => true)
    .catch(() => false);
  return ok ? target : null;
}
