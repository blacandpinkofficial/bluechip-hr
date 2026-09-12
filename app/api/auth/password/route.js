// POST /api/auth/password — change your own password.
//
// Anyone signed in can change theirs, and must know the current one to do it:
// a borrowed unlocked laptop should not be enough to lock the owner out of
// their own account.
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { getSession, verifyPassword, hashPassword, COOKIE } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  try {
    const b = await req.json().catch(() => ({}));
    const current = String(b.currentPassword || "");
    const next = String(b.newPassword || "");

    if (next.length < 8) {
      return NextResponse.json(
        { error: "Choose a password of at least 8 characters." },
        { status: 400 }
      );
    }
    if (next === current) {
      return NextResponse.json({ error: "That is your current password." }, { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { id: session.user.id } });
    if (!user || !(await verifyPassword(current, user.passwordHash))) {
      return NextResponse.json({ error: "Your current password is not right." }, { status: 403 });
    }

    const keep = cookies().get(COOKIE)?.value;
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(next) },
      }),
      // Sign out everywhere except here. If the reason for changing it is that
      // someone else has it, leaving their session alive defeats the exercise.
      prisma.session.deleteMany({
        where: { userId: user.id, ...(keep ? { NOT: { token: keep } } : {}) },
      }),
    ]);

    await prisma.auditLog
      .create({
        data: { userId: user.id, action: "update", entity: "User", entityId: user.id,
                summary: `${user.name} changed their password` },
      })
      .catch((e) => console.error("[password] audit write failed:", e?.message));

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[POST /api/auth/password]", e?.message || e);
    return NextResponse.json({ error: "Could not change your password." }, { status: 500 });
  }
}
