// lib/applications.js — everything a public job application does to the
// database, and the small pure functions that decide what it does.
//
// It lives here rather than in app/api/public/apply/route.js for two reasons.
// A route.js may export HTTP handlers and Next's segment config and nothing
// else, so a helper that another file — or a test — wants to call cannot live
// there. And the interesting parts of an application are decisions, not
// queries: what counts as a blank number, which blanks a stranger is allowed
// to fill, what the audit line should say. Those are worth being able to run
// on their own.
//
// The shape of the record:
//
//   Candidate      one row per phone number, ever. The person.
//   Application    one row per (candidate, opening). The thing they did.
//
// Candidate.requirementId is still what the calling screens read, so it is
// still set on the first application. It is a pointer to "the opening this
// person is currently being worked for", and it holds exactly one. The
// Application rows are the complete record: a candidate who applies to three
// openings has three of them, and the second and third are no longer silently
// dropped on the floor.

import { prisma } from "@/lib/prisma";

// Monthly take-home, in rupees. A ceiling rather than a validation error: the
// form is numeric and the person on the other side of it is a stranger, so an
// absurd figure is discarded, not argued with.
export const MAX_RUPEES = 10000000;

// ── parsing ─────────────────────────────────────────────────────────────────
//
// The rule both of these obey: absent is null, blank is null, whitespace is
// null, and a zero somebody actually typed is zero.
//
// This matters more than it looks. The gap-fill below only writes where the
// value we hold is null, so a blank salary box that parsed to 0 did not just
// record the wrong number — it filled the blank, and no later application
// could ever correct it. `Number("")` is 0 and `Number("  ")` is 0, which is
// how that happened.

/** A whole number in [0, max], or null. `"0"` is zero; `""` and `"  "` are not. */
export function intOrNull(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n) : null;
}

/**
 * Monthly take-home, integer rupees, or null.
 *
 * A plain number only: lib/money.js's parseRupees accepts "18k" because a
 * recruiter says it out loud, but this form has a numeric field and a stranger
 * typing on the other side of it. The rupee sign, commas and spaces are
 * stripped first, so "₹ 18,000" is 18000 and "₹ " is blank rather than zero.
 */
export function rupeesOrNull(v) {
  if (v == null) return null;
  const s = String(v).replace(/[₹,\s]/g, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= MAX_RUPEES ? Math.round(n) : null;
}

// ── the gap fill ────────────────────────────────────────────────────────────

/**
 * Exactly the columns gapFillPatch reads, selected explicitly so a future
 * column on Candidate is not pulled into this route by accident.
 *
 * Every key here is load-bearing, and two of them are load-bearing in a way
 * that is easy to miss: an unselected column comes back `undefined`, and
 * `undefined == null` is true. So a column the patch tests for emptiness and
 * forgets to select is treated as permanently empty and overwritten every
 * time (that is `source`), and a column it compares against a string is
 * compared against `undefined` and never matches (that was `stage`, which
 * made the un-archive branch below unreachable).
 */
export function candidateGapShape() {
  return {
    id: true,
    name: true,
    email: true,
    designation: true,
    location: true,
    expMonths: true,
    noticeDays: true,
    currentCtc: true,
    expectedCtc: true,
    skills: true,
    education: true,
    resumeText: true,
    source: true,
    requirementId: true,
    archived: true,
    // Read by the un-archive test. Not optional.
    stage: true,
    callCount: true,
  };
}

/**
 * Someone already known applying again. Fill the gaps in what we hold, never
 * overwrite what a recruiter typed after speaking to them, and attach the new
 * role if they had none.
 *
 * "Never overwrite" is doing real work: without it, anyone who knows a
 * candidate's mobile number could rewrite that candidate's record from the
 * public form. They can still fill a blank, but they cannot change an answer a
 * recruiter already got on the phone.
 *
 * Pure. Returns the patch and, separately, the NAMES of what it filled — the
 * audit line wants to say which fields a stranger supplied, and an audit log
 * of salary figures is its own problem.
 */
export function gapFillPatch(existing, fields, requirement) {
  const data = {};
  const filled = [];
  for (const [k, v] of Object.entries(fields || {})) {
    if (v != null && existing[k] == null) {
      data[k] = v;
      filled.push(k);
    }
  }
  if (requirement && !existing.requirementId) {
    data.requirementId = requirement.id;
    filled.push("requirementId");
  }

  // Un-archive ONLY someone nobody has worked yet.
  //
  // This endpoint is on the open internet. Flipping archived:false for any
  // known phone number means a stranger who has someone's mobile can push a
  // candidate a recruiter deliberately set aside — or one already dropped,
  // selected or joined — back onto the working queues, which all filter on
  // archived:false. A fresh row nobody has touched is a real application; an
  // archived row with calls behind it is a decision somebody made.
  //
  // The guard is right. It just could not run: `stage` was not selected, so
  // `existing.stage` was undefined and the comparison was always false.
  let unarchived = false;
  if (existing.archived === true && existing.stage === "new" && !existing.callCount) {
    data.archived = false;
    unarchived = true;
  }

  return { data, filled, unarchived, changed: Object.keys(data).length > 0 };
}

/**
 * The audit line for one public application. Field NAMES only — never their
 * values, and never the phone number, which is already the candidate's own
 * row and does not need copying into a second table.
 */
export function applyAuditSummary({ created, filled, unarchived, requirement, applicationCreated }) {
  const names = Array.isArray(filled) ? filled : [];
  const parts = [];

  // What happened to the candidate master.
  if (created) {
    parts.push("Public application created this candidate");
  } else if (names.length) {
    parts.push(
      `Public application filled ${names.length} blank field${names.length === 1 ? "" : "s"}: ${names.join(", ")}`
    );
  } else {
    parts.push("Public application left the candidate record unchanged");
  }
  if (unarchived) parts.push("returned to the calling queue");

  // What happened to the application. Said separately, because "nothing
  // changed on the candidate" and "nobody applied" are very different facts
  // and one line used to run them together.
  if (!requirement) {
    parts.push("no opening attached");
  } else if (applicationCreated) {
    parts.push(`new application for ${requirement.designation} (${requirement.id})`);
  } else {
    parts.push(`repeat submission for ${requirement.designation} (${requirement.id})`);
  }

  return parts.join(" · ").slice(0, 500);
}

// ── the write ───────────────────────────────────────────────────────────────

/**
 * Persist one public application.
 *
 * Everything that has to be true together is in one transaction: the candidate
 * row and the Application row for this (candidate, opening) pair. A caller
 * that gets `{ ok: true }` back can tell the applicant their application is
 * in. A caller that gets `{ ok: false }` must not.
 *
 * `db` is injectable so the decision logic can be exercised without a
 * database. Production passes nothing and gets the real client.
 */
export async function recordApplication(
  { phone, fields, requirement, ip, userAgent },
  db = prisma
) {
  let outcome;
  try {
    outcome = await applyOnce({ phone, fields, requirement, ip, userAgent }, db);
  } catch (e) {
    // P2002 is a unique-constraint collision, and there are two that can
    // happen here. Candidate.phone: two applications from the same number
    // arriving close enough together that both missed the findUnique, or a
    // recruiter typing the same person in at the same moment. Application's
    // (candidateId, requirementId): the same person double-tapping Send.
    //
    // Either way the second attempt now finds what the first wrote, so this
    // retries exactly once. The response is identical either way, which is the
    // point: a different status code here would turn this endpoint into a way
    // to ask "is this number on Blue Chip's books", one guess at a time.
    if (e?.code !== "P2002") {
      console.error("[apply] application write failed:", e?.message || e);
      return { ok: false };
    }
    try {
      outcome = await applyOnce({ phone, fields, requirement, ip, userAgent }, db);
    } catch (e2) {
      console.error("[apply] application write failed on retry:", e2?.message || e2);
      return { ok: false };
    }
  }

  // The audit line is written after the transaction commits, deliberately. It
  // is a record OF a thing that happened; it must not be able to undo the
  // thing. A lost audit line is logged and the application still stands.
  await writeApplyAudit({ ...outcome, requirement, ip }, db);

  return outcome;
}

async function applyOnce({ phone, fields, requirement, ip, userAgent }, db) {
  return db.$transaction(async (tx) => {
    const existing = await tx.candidate.findUnique({
      where: { phone },
      select: candidateGapShape(),
    });

    let candidateId;
    let created = false;
    let filled = [];
    let unarchived = false;

    if (existing) {
      const patch = gapFillPatch(existing, fields, requirement);
      if (patch.changed) {
        await tx.candidate.update({ where: { id: existing.id }, data: patch.data });
      }
      candidateId = existing.id;
      filled = patch.filled;
      unarchived = patch.unarchived;
    } else {
      const row = await tx.candidate.create({
        data: {
          ...fields,
          phone,
          source: "website",
          // A create, so there is no earlier stage it could be moved back from.
          stage: "new",
          requirementId: requirement?.id || null,
          status: requirement
            ? `Applied online for ${requirement.designation}`
            : "Applied online",
        },
        select: { id: true },
      });
      candidateId = row.id;
      created = true;
    }

    // The application itself. Without an opening there is nothing to apply TO
    // — a general "keep me in mind" is the candidate row and nothing more —
    // and Application.requirementId is not nullable, which is the schema
    // saying the same thing.
    let applicationCreated = false;
    if (requirement) {
      const where = {
        candidateId_requirementId: { candidateId, requirementId: requirement.id },
      };
      // Asked before the upsert purely so the audit line can tell a genuine
      // second application from somebody pressing Send twice. The upsert is
      // still what makes the write itself safe.
      const prior = await tx.application.findUnique({ where, select: { id: true } });
      applicationCreated = !prior;
      await tx.application.upsert({
        where,
        create: {
          candidateId,
          requirementId: requirement.id,
          source: "website",
          status: "new",
          selfReported: true,
          ip: ip || null,
          userAgent: userAgent || null,
        },
        // Nothing. A resubmission is the same application, and the columns
        // that could be rewritten here are all desk decisions — status,
        // reviewedAt, notes. A stranger pressing Send twice must not walk a
        // shortlisted application back to "new". The @@unique pair is what
        // makes the retry idempotent; this is what makes it harmless.
        update: {},
        select: { id: true },
      });
    }

    return { ok: true, candidateId, created, filled, unarchived, applicationCreated };
  });
}

/**
 * One AuditLog row per public application, with no userId, because there was
 * no user — that blank is the honest record of an anonymous write. Every other
 * write path in the app leaves a line here; this one is the one a stranger can
 * reach, so it is the one that most needs to.
 */
async function writeApplyAudit(
  { candidateId, created, filled, unarchived, applicationCreated, requirement, ip },
  db
) {
  if (!candidateId) return;
  try {
    await db.auditLog.create({
      data: {
        userId: null,
        action: created ? "create" : "update",
        entity: "Candidate",
        entityId: candidateId,
        summary: applyAuditSummary({ created, filled, unarchived, requirement, applicationCreated }),
        ip: ip || null,
      },
    });
  } catch (e) {
    console.error("[apply] audit write failed:", e?.message || e);
  }
}
