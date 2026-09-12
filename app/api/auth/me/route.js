// GET /api/auth/me — who am I, and what am I allowed to do?
//
// The capability list is returned with the user so the UI can hide controls the
// server would refuse anyway. Hiding is a courtesy; the server check is the
// rule. Never let a client-side capability list be the only thing standing
// between a recruiter and the desk's revenue.
import { NextResponse } from "next/server";
import { getSession, allCapabilities } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ user: null }, { status: 401 });
  return NextResponse.json({
    user: session.user,
    capabilities: allCapabilities(session.user.role),
  });
}
