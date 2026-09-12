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
      return bad;
    }
    if (!user.active) {
      return NextResponse.json(
        { error: "This account has been deactivated. Ask your manager." },
        { status: 403 }
      );
    }
    if (!(await verifyPassword(password, user.passwordHash))) return bad;

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
