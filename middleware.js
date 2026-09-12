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

const PUBLIC = ["/login", "/api/auth/login", "/api/health"];

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
