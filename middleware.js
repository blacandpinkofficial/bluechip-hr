// middleware.js — the outer gate.
//
// This runs on the edge runtime, which cannot reach Prisma, so it only checks
// that a session cookie is PRESENT. Whether that cookie is valid is decided in
// lib/auth.js on the server, on every request that matters.
//
// So this is a redirect for convenience, never a security boundary. Every API
// handler still calls requireCapability() for itself. Two layers, and only the
// inner one is load-bearing.

import { NextResponse } from "next/server";

// Everything a signed-out visitor may reach. The careers page and its two
// endpoints are here deliberately; they enforce their own rules (the page can
// be switched off, and the apply route is rate limited) rather than relying on
// a session that a candidate will never have.
// /api/cron is here because the nightly job authenticates with a shared secret
// header, not a session cookie. Without this entry the edge middleware 401s the
// timer before the handler runs, and the timer's log says "401" — which reads
// as a wrong secret, not a routing rule. The handler checks the secret itself,
// in constant time; this line only gets the request as far as the handler.
// /careers is the public shopfront served at careers.blacandpink.com (and later
// careers.bluechiphr.com). It is the same app behind the same tunnel, so the
// only thing separating "the careers site" from "the office system" is this
// list and the capability check inside every other handler. It is listed as a
// prefix so /careers, /careers/jobs and /careers/jobs/<id> all pass; nothing
// under /careers reads a session.
const PUBLIC = [
  "/login",
  "/api/auth/login",
  "/api/health",
  "/jobs",
  "/careers",
  "/api/public",
  "/api/cron",
];

export function middleware(req) {
  const { pathname } = req.nextUrl;

  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  const hasCookie = req.cookies.has("bc_session");
  if (!hasCookie) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|ico|webp)$).*)"],
};
