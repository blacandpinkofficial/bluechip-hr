// POST /api/auth/login
//
// Note for anyone editing this file later: a route.js may export ONLY HTTP
// handlers and Next's segment config (runtime, dynamic, revalidate…). Exporting
// any other function or constant from here breaks the production build, and the
// error it produces names unrelated files — it cost a day on the Pulse app.
// Helpers go in lib/.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  COOKIE,
  verifyPassword,
  createSession,
  sessionCookieOptions,
} from "@/lib/auth";
import { clientIp, overLimit, recordFailure, clearFailures } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (!email || !password) {
      return NextResponse.json(
        { error: "Enter your email and password." },
        { status: 400 }
      );
    }

    // Until now this route would check passwords as fast as anyone could post
    // them. Every other door in the app is behind a session, so this is the one
    // worth guessing at, and the accounts behind it belong to people who pick a
    // password they can remember at eight in the morning.
    //
    // What is counted is FAILURES, and only failures. The first version counted
    // arrivals, which quietly made this a cap on signing in: the whole office
    // leaves through one address, so ten people arriving on a Monday with a
    // fresh browser each were most of the allowance before anybody had typed
    // anything wrong. A successful sign-in is evidence that this is not an
    // attack, and it now clears the counter for that mailbox rather than
    // filling it.
    //
    // Two windows, because they answer different questions:
    //
    //   by address  — one machine working through a list. The office shares an
    //                 address, so this has to be loose enough for a bad morning
    //                 at a ten-person desk and is only meant to stop a script.
    //   by email    — a slow spray from many addresses aimed at ONE account,
    //                 which the address window never sees.
    //
    // A speed bump on a door, not a lock: the counters are per-process and lost
    // on every restart, and the rule that can actually drop a request lives at
    // Cloudflare in front of the tunnel. See lib/ratelimit.js.
    const ip = clientIp(req);
    if (overLimit("login-ip", ip, { windowMs: 10 * 60 * 1000, max: 60 }) ||
        overLimit("login-email", email, { windowMs: 30 * 60 * 1000, max: 10 })) {
      return NextResponse.json(
        { error: "Too many failed sign-in attempts. Wait a few minutes and try again." },
        { status: 429, headers: { "Retry-After": "600" } }
      );
    }

    // Called on the way out of every failed branch below. Named so the three
    // call sites read as what they are rather than as three copies of a line.
    const countFailure = () => {
      recordFailure("login-ip", ip, { windowMs: 10 * 60 * 1000 });
      recordFailure("login-email", email, { windowMs: 30 * 60 * 1000 });
    };

    const user = await prisma.user.findUnique({ where: { email } });

    // One message for "no such user" and "wrong password". Distinguishing them
    // tells an attacker which emails are real accounts, and tells a recruiter
    // nothing they can act on either way.
    const bad = NextResponse.json(
      { error: "Email or password is incorrect." },
      { status: 401 }
    );

    if (!user) {
      // Spend roughly the same time as a real check so the response time does
      // not reveal whether the account exists.
      await verifyPassword(password, "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva");
      countFailure();
      return bad;
    }
    if (!user.active) {
      return NextResponse.json(
        { error: "This account has been deactivated. Ask your manager." },
        { status: 403 }
      );
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      countFailure();
      return bad;
    }

    // Right. Forget the wrong guesses that came before it — the person was
    // simply trying to remember which password they use here.
    clearFailures("login-email", email);
    // The mailbox counter only. Not the address one: everyone here leaves
    // through the same office address, so clearing it on any success would let
    // one working account wipe the counter between guesses at another.

    const { token, expiresAt } = await createSession(user.id, {
      userAgent: req.headers.get("user-agent") || undefined,
      ip:
        req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        req.headers.get("x-real-ip") ||
        undefined,
    });

    await prisma.user
      .update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
      .catch(() => {});

    await prisma.auditLog
      .create({
        data: {
          userId: user.id,
          action: "login",
          entity: "User",
          entityId: user.id,
          summary: `${user.name} signed in`,
        },
      })
      .catch((e) => console.error("[login] audit write failed:", e?.message));

    const res = NextResponse.json({
      ok: true,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
    res.cookies.set(COOKIE, token, sessionCookieOptions(expiresAt));
    return res;
  } catch (e) {
    console.error("[POST /api/auth/login]", e?.message || e);
    return NextResponse.json(
      { error: "Could not sign you in. Try again." },
      { status: 500 }
    );
  }
}
