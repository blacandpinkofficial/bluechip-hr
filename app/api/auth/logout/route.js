// POST /api/auth/logout
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { COOKIE, destroySession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const token = cookies().get(COOKIE)?.value;
  await destroySession(token);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE, "", { path: "/", expires: new Date(0) });
  return res;
}
