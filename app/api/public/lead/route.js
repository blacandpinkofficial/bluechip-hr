// POST /api/public/lead — a company asking Blue Chip to recruit for them.
//
// The second and last route an unauthenticated stranger can write through, and
// the more dangerous of the two, because what is being described is a piece of
// business: a client, an opening and a budget. So it does NOT create any of
// those. It creates a RequirementLead — a row in a table nothing else in the
// app reads — and a person with requirement.write decides at /leads whether it
// becomes a Client and a Requirement.
//
// That indirection is the entire security design of the hiring form. Validation
// and rate limiting below reduce the noise; they are not what stops a bad
// submission mattering. What stops it mattering is that the row it creates has
// no effect on anything until a human approves it.
//
// The same defences as /api/public/apply, with a tighter window: a company
// posts a requirement occasionally, not repeatedly.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { clientIp, tooMany } from "../_ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 5;

// Hard ceilings on stored text. The job description is the only generous one,
// and 4000 characters is already longer than any JD the desk has ever been
// sent. Everything is cut rather than refused; an enquiry rejected for being
// forty characters too long is an enquiry that does not get made again.
const CAP = {
  companyName: 160,
  contactName: 120,
  email: 200,
  city: 120,
  designation: 160,
  shift: 60,
  jobDescription: 4000,
  userAgent: 300,
};

export async function POST(req) {
  try {
    const settings = await getSettings();
    if (!settings.careersEnabled) {
      // One switch turns the whole public site off, this form included. A kill
      // switch that leaves half the write surface up is not a kill switch.
      return NextResponse.json({ error: "This form is closed." }, { status: 404 });
    }

    const ip = clientIp(req);
    if (tooMany("lead", ip, { windowMs: WINDOW_MS, max: MAX_PER_WINDOW })) {
      return NextResponse.json(
        { error: "Too many enquiries from this connection. Please email us instead." },
        { status: 429 }
      );
    }

    const b = await req.json().catch(() => ({}));

    // Honeypot, same as the apply form: answer as though it worked.
    if (String(b.website || "").trim()) {
      return NextResponse.json({ ok: true });
    }

    const companyName = clean(b.companyName, CAP.companyName);
    const designation = clean(b.designation, CAP.designation);
    const phone = String(b.phone || "").replace(/\D/g, "").slice(-10);

    if (!companyName) {
      return NextResponse.json({ error: "Please enter your company name." }, { status: 400 });
    }
    if (!designation) {
      return NextResponse.json({ error: "Please tell us which role you are hiring for." }, { status: 400 });
    }
    if (phone.length !== 10) {
      return NextResponse.json({ error: "Please enter a 10-digit contact number." }, { status: 400 });
    }

    const email = clean(b.email, CAP.email).toLowerCase();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return NextResponse.json({ error: "That does not look like an email address." }, { status: 400 });
    }

    // Experience and budget are read as a pair and put in order. Someone who
    // types 5 in "from" and 2 in "to" means two to five; refusing the form over
    // it teaches them nothing and loses the enquiry.
    const [expMinMonths, expMaxMonths] = ordered(
      intOrNull(b.expMinMonths, 600),
      intOrNull(b.expMaxMonths, 600)
    );
    const [budgetMin, budgetMax] = ordered(
      rupeesOrNull(b.budgetMin),
      rupeesOrNull(b.budgetMax)
    );

    await prisma.requirementLead.create({
      data: {
        companyName,
        contactName: clean(b.contactName, CAP.contactName) || null,
        phone,
        email: email || null,
        city: clean(b.city, CAP.city) || null,
        designation,
        openings: intOrNull(b.openings, 999),
        expMinMonths,
        expMaxMonths,
        budgetMin,
        budgetMax,
        shift: clean(b.shift, CAP.shift) || null,
        jobDescription: clean(b.jobDescription, CAP.jobDescription) || null,
        status: "new",
        // Kept for abuse triage and nothing else. Both are attacker-controlled
        // strings — never rendered as markup, never treated as identity.
        ip,
        userAgent: clean(req.headers.get("user-agent"), CAP.userAgent) || null,
      },
      select: { id: true },
    });

    // Nothing about the created row comes back. The submitter gets "we have
    // it"; the id, the status and every other lead stay inside.
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[POST /api/public/lead]", e?.message || e);
    return NextResponse.json(
      { error: "Something went wrong. Please try again, or call us." },
      { status: 500 }
    );
  }
}

// ── helpers, none exported ──────────────────────────────────────────────────

function clean(v, max) {
  return stripControls(String(v == null ? "" : v)).trim().slice(0, max);
}

/**
 * Control characters out of anything a stranger typed. A NUL or an ESC in a
 * company name is not a name — it is somebody finding out what the log viewer,
 * the CSV export or the terminal on the other end of them does with it. Tab,
 * newline and carriage return survive, because a pasted job description is full
 * of them and /leads renders it as written.
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

/** Monthly take-home in integer rupees. Plain digits only — this side of the
 *  form is filled in by strangers, so it does not accept the "18k" shorthand
 *  lib/money.js allows a recruiter. */
function rupeesOrNull(v) {
  const n = Number(String(v == null ? "" : v).replace(/[₹,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 && n <= 10000000 ? Math.round(n) : null;
}

/** Two numbers, smallest first. Either may be null. */
function ordered(a, b) {
  if (a != null && b != null && a > b) return [b, a];
  return [a, b];
}
