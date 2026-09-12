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

  const now = Date.now();
  const withAge = rows.map((r) => ({
    ...r,
    daysSilent: r.status === "sent" ? Math.floor((now - new Date(r.sentAt).getTime()) / 86400000) : null,
  }));

  return NextResponse.json({
    submissions: withAge,
    statuses: STATUSES,
    // Counted server-side so every screen showing this number shows the same one.
    silent: withAge.filter((r) => r.status === "sent" && r.daysSilent >= 4).length,
    mailConfigured: mailReady(await getSettings()),
    me: user.id,
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
  const toEmail = String(b.toEmail || requirement.client?.hrEmail || "").trim() || null;

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
  // because someone sent the CV to a second client.
  // "dropped" is deliberately NOT in this list, and that is exactly why the
  // index must be checked for -1 first. indexOf("dropped") is -1, and -1 is
  // less than 2, so the naive comparison quietly moved a dropped candidate
  // FORWARDS to shortlisted — the precise thing this guard exists to stop.
  // Any unrecognised stage is left alone rather than guessed at.
  const ORDER = ["new", "contacted", "shortlisted", "lined-up", "interviewed", "selected", "joined"];
  const at = ORDER.indexOf(candidate.stage);
  if (at >= 0 && at < ORDER.indexOf("shortlisted")) {
    await prisma.candidate.update({ where: { id: candidateId }, data: { stage: "shortlisted" } }).catch(() => {});
  }

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
      ...(status && status !== "sent" && !existing.respondedAt ? { respondedAt: new Date() } : {}),
      ...(b.response !== undefined ? { response: String(b.response || "").trim() || null } : {}),
    },
  });

  return NextResponse.json({ submission: row });
}
