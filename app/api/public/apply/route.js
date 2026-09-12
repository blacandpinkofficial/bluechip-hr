// POST /api/public/apply — a candidate applying from the public careers page.
//
// This is the only route in the app that an unauthenticated stranger can write
// through, so it is the only one that needs to be suspicious. Three defences,
// each for a different failure:
//
//   the careers page must be switched on   — off by default; no accidental
//                                            public write endpoint
//   rate limit per IP                      — one bored person with a script
//   duplicate phone is an update, not a    — a real candidate applying to a
//   new row or an error                      second role should not be told
//                                            they already exist
//
// It writes a Candidate like any other, marked source "website". It never
// returns anything about existing candidates: "is 9876543210 in your database"
// is not a question a stranger gets to ask.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Small in-memory window. Not a real rate limiter — one process, lost on
// restart — but enough to stop a loop, and it costs nothing. A serious one
// belongs at the edge, not here.
const HITS = new Map();
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 10;

function tooMany(ip) {
  const now = Date.now();
  const list = (HITS.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  HITS.set(ip, list);
  // Keep the map from growing without bound on a long-lived process.
  if (HITS.size > 5000) {
    for (const [k, v] of HITS) {
      if (!v.some((t) => now - t < WINDOW_MS)) HITS.delete(k);
    }
  }
  return list.length > MAX_PER_WINDOW;
}

export async function POST(req) {
  try {
    const settings = await getSettings();
    if (!settings.careersEnabled) {
      return NextResponse.json({ error: "Applications are closed." }, { status: 404 });
    }

    const ip =
      req.headers.get("cf-connecting-ip") ||
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("x-real-ip") ||
      "unknown";
    if (tooMany(ip)) {
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

    const name = String(b.name || "").trim().slice(0, 120);
    const phone = String(b.phone || "").replace(/\D/g, "").slice(-10);
    const requirementId = String(b.requirementId || "");

    if (!name) return NextResponse.json({ error: "Please enter your name." }, { status: 400 });
    if (phone.length !== 10) {
      return NextResponse.json({ error: "Please enter a 10-digit mobile number." }, { status: 400 });
    }

    const requirement = requirementId
      ? await prisma.requirement.findFirst({
          where: { id: requirementId, status: "open", publishOnline: true },
        })
      : null;
    if (requirementId && !requirement) {
      return NextResponse.json({ error: "That opening is no longer available." }, { status: 404 });
    }

    const fields = {
      name,
      email: String(b.email || "").trim().toLowerCase().slice(0, 200) || null,
      designation: String(b.designation || "").trim().slice(0, 120) || null,
      location: String(b.location || "").trim().slice(0, 120) || null,
      expMonths: intOrNull(b.expMonths),
      noticeDays: intOrNull(b.noticeDays),
      skills: String(b.skills || "").trim().slice(0, 500) || null,
      education: String(b.education || "").trim().slice(0, 200) || null,
    };

    const existing = await prisma.candidate.findUnique({ where: { phone } });

    if (existing) {
      // Someone already known applying again. Fill the gaps in what we hold,
      // never overwrite what a recruiter typed after speaking to them, and
      // attach the new role if they had none.
      const fill = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v != null && existing[k] == null) fill[k] = v;
      }
      if (requirement && !existing.requirementId) fill.requirementId = requirement.id;
      if (existing.archived) fill.archived = false;

      if (Object.keys(fill).length > 0) {
        await prisma.candidate.update({ where: { id: existing.id }, data: fill });
      }
      return NextResponse.json({ ok: true });
    }

    await prisma.candidate.create({
      data: {
        ...fields,
        phone,
        source: "website",
        stage: "new",
        requirementId: requirement?.id || null,
        status: requirement ? `Applied online for ${requirement.designation}` : "Applied online",
      },
    });

    // Deliberately the same response either way. A different message for a
    // known number turns this endpoint into a way to test whether a phone
    // number is on Blue Chip's books.
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[POST /api/public/apply]", e?.message || e);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}

function intOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n < 1000 ? Math.round(n) : null;
}
