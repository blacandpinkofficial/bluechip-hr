// /api/users — who can sign in, and as what.
//
// Three roles and no more. Every extra role is a new set of "can they see the
// desk's revenue?" questions, and in a placement agency that is THE question.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability, hashPassword, ROLES, allCapabilities } from "@/lib/auth";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read aloud, or typed off a screenshot, at least once. No look-alike glyphs.
function generatePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  return Array.from(crypto.randomBytes(14)).map((b) => alphabet[b % alphabet.length]).join("");
}

export async function GET() {
  const gate = await requireCapability("user.read");
  if (!gate.ok) return gate.response;

  const users = await prisma.user.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }],
    select: {
      id: true, name: true, email: true, phone: true, role: true,
      active: true, lastLoginAt: true, createdAt: true,
      _count: { select: { candidates: true, calls: true, placements: true } },
    },
  });

  return NextResponse.json({
    users: users.map((u) => ({
      ...u,
      candidateCount: u._count.candidates,
      callCount: u._count.calls,
      placementCount: u._count.placements,
      _count: undefined,
    })),
    roles: ROLES.map((r) => ({ key: r, capabilities: allCapabilities(r) })),
    me: gate.user.id,
  });
}

export async function POST(req) {
  const gate = await requireCapability("user.write");
  if (!gate.ok) return gate.response;

  try {
    const b = await req.json().catch(() => ({}));
    const name = String(b.name || "").trim();
    const email = String(b.email || "").trim().toLowerCase();
    const role = String(b.role || "recruiter");

    if (!name) return NextResponse.json({ error: "Enter their name." }, { status: 400 });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return NextResponse.json({ error: "Enter a valid email address — it is their username." }, { status: 400 });
    }
    if (!ROLES.includes(role)) {
      return NextResponse.json({ error: `Role must be one of: ${ROLES.join(", ")}` }, { status: 400 });
    }

    const clash = await prisma.user.findUnique({ where: { email } });
    if (clash) {
      return NextResponse.json(
        { error: `${email} already has an account${clash.active ? "" : " (deactivated)"}.` },
        { status: 409 }
      );
    }

    // Generated, never chosen by the person creating the account. A default
    // password that someone forgets to change is how a database of every
    // candidate's phone number walks out of the building.
    const password = generatePassword();
    const user = await prisma.user.create({
      data: {
        name,
        email,
        phone: String(b.phone || "").replace(/[^\d+]/g, "") || null,
        role,
        passwordHash: await hashPassword(password),
        active: true,
      },
      select: { id: true, name: true, email: true, role: true, active: true },
    });

    await prisma.auditLog
      .create({
        data: {
          userId: gate.user.id, action: "create", entity: "User", entityId: user.id,
          summary: `Created ${role} account for ${name} (${email})`,
        },
      })
      .catch((e) => console.error("[users] audit write failed:", e?.message));

    // Returned exactly once and never stored in plain text anywhere.
    return NextResponse.json({ user, password }, { status: 201 });
  } catch (e) {
    console.error("[POST /api/users]", e?.message || e);
    return NextResponse.json({ error: "Could not create the account." }, { status: 500 });
  }
}
