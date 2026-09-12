// GET /api/health — what the deploy script polls before it deletes the backup.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true, db: "up", at: new Date().toISOString() });
  } catch (e) {
    // A 503 here is the signal that rolls the deploy back. Returning 200 with
    // a sad message would let a broken build replace a working one.
    return NextResponse.json(
      { ok: false, db: "down", error: e?.message || "unreachable" },
      { status: 503 }
    );
  }
}
