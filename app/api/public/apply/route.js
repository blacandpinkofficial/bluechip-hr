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
// It writes a Candidate like any other, marked source "website", AND an
// Application row for the opening applied to. The two are not the same record
// and must not be collapsed into one: Candidate.phone is unique because a
// phone number is one person, while a person may apply to four openings over a
// year and every one of them is a separate thing a recruiter has to answer.
// Candidate.requirementId holds one opening — the one this person is currently
// being worked for — and the Application rows are the complete history.
//
// It never returns anything about existing candidates: "is 9876543210 in your
// database" is not a question a stranger gets to ask. The success response is
// byte-identical whether this was a brand new person, a known person applying
// to a second role, or the same form submitted twice.
//
// What { ok: true } means here: the application is persisted. If the write
// fails it says so and asks for a retry, because a candidate who is told
// "thank you, a recruiter will call" and is in nobody's queue is worse served
// than one who is asked to press the button again. The single exception is the
// honeypot, which answers as though it worked and writes nothing — telling a
// bot it was detected only teaches whoever wrote it what to change.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { intOrNull, rupeesOrNull, recordApplication } from "@/lib/applications";
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
  userAgent: 300,
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
      // Provenance on the gap-fill path too, not only on create. A blank
      // source column filled from the public form should say where the data
      // came from; a column a recruiter already filled in with "referral" is
      // left exactly as it is, like every other field here.
      source: "website",
    };

    const saved = await recordApplication({
      phone,
      fields,
      requirement,
      ip,
      userAgent: clean(req.headers.get("user-agent"), CAP.userAgent) || null,
    });

    if (!saved?.ok) {
      return NextResponse.json(
        { error: "We could not save your application just now. Please try again in a moment." },
        { status: 503 }
      );
    }

    // Identical for a new candidate, a known one, and a resubmission.
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
// not a style opinion. Anything another file needs is in lib/applications.js.

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
