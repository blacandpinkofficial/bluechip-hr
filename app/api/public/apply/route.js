// POST /api/public/apply — a candidate applying from the public careers site.
//
// This is one of two routes in the app that an unauthenticated stranger can
// write through, so it is one of the two that needs to be suspicious. Four
// defences, each for a different failure:
//
//   the careers page must be switched on   — off by default; no accidental
//                                            public write endpoint
//   rate limit per IP                      — one bored person with a script
//   honeypot                               — the cheap half of the bot traffic
//   duplicate phone is an update, not a    — a real candidate applying to a
//   new row or an error                      second role should not be told
//                                            they already exist
//
// It writes a Candidate like any other, marked source "website". It never
// returns anything about existing candidates: "is 9876543210 in your database"
// is not a question a stranger gets to ask.
//
// Why this still writes to Candidate rather than to a review table the way the
// hiring form does: a candidate application already IS a review queue. The row
// lands at stage "new" with source "website" and no owner, which is exactly
// what an unworked lead looks like on the calling screen, and Candidate.phone
// is unique — the constraint that stops one person becoming four rows. A
// parallel table would fork the pipeline and would have to re-implement that
// constraint against the table it was trying to stay out of. A hiring enquiry
// has no such home: it would have to invent a Client and a Requirement, which
// is why that one waits for a human.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { clientIp, tooMany } from "../_ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Ten applications an hour from one address. A genuine candidate applies to
// two or three roles in a sitting; ten is already generous.
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 10;

// Hard ceilings on everything stored. Applied after trimming, so a field is
// never rejected for length — it is cut. A refused application is a lost
// candidate; a truncated one is a candidate someone can still call.
const CAP = {
  name: 120,
  email: 200,
  designation: 120,
  location: 120,
  skills: 500,
  education: 200,
  resumeText: 5000,
};

export async function POST(req) {
  try {
    const settings = await getSettings();
    if (!settings.careersEnabled) {
      return NextResponse.json({ error: "Applications are closed." }, { status: 404 });
    }

    const ip = clientIp(req);
    if (tooMany("apply", ip, { windowMs: WINDOW_MS, max: MAX_PER_WINDOW })) {
      return NextResponse.json(
        { error: "Too many applications from this connection. Try again later." },
        { status: 429 }
      );
    }

    const b = await req.json().catch(() => ({}));

    // Honeypot: a field hidden from people and irresistible to bots.
    if (String(b.website || "").trim()) {
      // Answer as though it worked. Telling a bot it was detected only teaches
      // whoever wrote it what to change.
      return NextResponse.json({ ok: true });
    }

    const name = clean(b.name, CAP.name);
    const phone = String(b.phone || "").replace(/\D/g, "").slice(-10);
    const requirementId = String(b.requirementId || "").slice(0, 40);

    if (!name) return NextResponse.json({ error: "Please enter your name." }, { status: 400 });
    if (phone.length !== 10) {
      return NextResponse.json({ error: "Please enter a 10-digit mobile number." }, { status: 400 });
    }

    // The opening is re-checked here rather than trusted from the form. The id
    // arrives from a browser, so "open and published" has to be asserted
    // against the database at the moment of the write — otherwise a saved page
    // from last month attaches a candidate to a closed or unpublished role.
    const requirement = requirementId
      ? await prisma.requirement.findFirst({
          where: { id: requirementId, status: "open", publishOnline: true },
          select: { id: true, designation: true },
        })
      : null;
    if (requirementId && !requirement) {
      return NextResponse.json({ error: "That opening is no longer available." }, { status: 404 });
    }

    const fields = {
      name,
      email: clean(b.email, CAP.email).toLowerCase() || null,
      designation: clean(b.designation, CAP.designation) || null,
      location: clean(b.location, CAP.location) || null,
      expMonths: intOrNull(b.expMonths, 960),
      noticeDays: intOrNull(b.noticeDays, 365),
      currentCtc: rupeesOrNull(b.currentCtc),
      expectedCtc: rupeesOrNull(b.expectedCtc),
      skills: clean(b.skills, CAP.skills) || null,
      education: clean(b.education, CAP.education) || null,
      resumeText: clean(b.resumeText, CAP.resumeText) || null,
    };

    const existing = await prisma.candidate.findUnique({
      where: { phone },
      select: candidateGapShape(),
    });

    if (existing) {
      await fillGaps(existing, fields, requirement);
      return NextResponse.json({ ok: true });
    }

    try {
      await prisma.candidate.create({
        data: {
          ...fields,
          phone,
          source: "website",
          stage: "new",
          requirementId: requirement?.id || null,
          status: requirement
            ? `Applied online for ${requirement.designation}`
            : "Applied online",
        },
      });
    } catch (e) {
      // P2002 on phone. Two applications from the same number arriving close
      // enough together that both passed the findUnique above, or a recruiter
      // typing the same person in at the same moment. Treat the second one as
      // what it is — the same person — and fold it into the row that won.
      //
      // The response below is identical either way, which is the point: a
      // different status code here would turn this endpoint into a way to ask
      // "is this number on Blue Chip's books", one guess at a time.
      if (e?.code !== "P2002") throw e;
      const row = await prisma.candidate
        .findUnique({ where: { phone }, select: candidateGapShape() })
        .catch(() => null);
      if (row) await fillGaps(row, fields, requirement);
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[POST /api/public/apply]", e?.message || e);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────
// None of these are exported. A route.js may export HTTP handlers and Next's
// segment config and nothing else; an exported helper here is a build error,
// not a style opinion.

/**
 * Someone already known applying again. Fill the gaps in what we hold, never
 * overwrite what a recruiter typed after speaking to them, and attach the new
 * role if they had none.
 *
 * "Never overwrite" is doing real work: without it, anyone who knows a
 * candidate's mobile number could rewrite that candidate's record from the
 * public form. They can still fill a blank — see the note in the summary — but
 * they cannot change an answer a recruiter already got on the phone.
 */
async function fillGaps(existing, fields, requirement) {
  const fill = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v != null && existing[k] == null) fill[k] = v;
  }
  if (requirement && !existing.requirementId) fill.requirementId = requirement.id;
  // Un-archive ONLY someone nobody has worked yet.
  //
  // This endpoint is on the open internet. Flipping archived:false for any
  // known phone number means a stranger who has someone's mobile can push a
  // candidate a recruiter deliberately set aside — or one already dropped,
  // selected or joined — back onto the working queues, which all filter on
  // archived:false. A fresh row nobody has touched is a real application; an
  // archived row with calls behind it is a decision somebody made.
  if (existing.archived && existing.stage === "new" && !existing.callCount) {
    fill.archived = false;
  }
  if (Object.keys(fill).length === 0) return;
  await prisma.candidate
    .update({ where: { id: existing.id }, data: fill })
    .catch((e) => console.error("[apply] gap fill failed:", e?.message || e));
}

/** Exactly the columns fillGaps reads. Selected explicitly so a future column
 *  on Candidate is not pulled into this route by accident. */
function candidateGapShape() {
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
    requirementId: true,
    archived: true,
  };
}

function clean(v, max) {
  return stripControls(String(v == null ? "" : v)).trim().slice(0, max);
}

/**
 * Control characters out of anything a stranger typed. A NUL or an ESC in a
 * name is not a name — it is somebody finding out what the log viewer, the CSV
 * export or the terminal on the other end of them does with it. Tab, newline
 * and carriage return survive, because pasted CV text is full of them and the
 * screens that show it render it as written.
 *
 * Written as a loop rather than a regex character class so that this source
 * file contains no control characters of its own.
 */
function stripControls(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += (c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127 ? " " : s[i];
  }
  return out;
}

function intOrNull(v, max) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n) : null;
}

/** Monthly take-home, integer rupees. A plain number only: lib/money.js's
 *  parseRupees accepts "18k" because a recruiter says it out loud, but this
 *  form has a numeric field and a stranger typing on the other side of it. */
function rupeesOrNull(v) {
  const n = Number(String(v == null ? "" : v).replace(/[₹,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 && n <= 10000000 ? Math.round(n) : null;
}
