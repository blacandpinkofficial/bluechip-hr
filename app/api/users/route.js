// /api/users — who can sign in, and as what.
//
// Three roles and no more. Every extra role is a new set of "can they see the
// desk's revenue?" questions, and in a placement agency that is THE question.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability, hashPassword, ROLES, allCapabilities, can } from "@/lib/auth";
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
      // Payroll pro-rates a part month from these. Null means "was here all
      // along", which is every existing account until somebody sets one.
      joinedOn: true, leftOn: true,
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
    // user.read reaches further than user.write — a team leader can open this
    // screen but may not change anything on it. Said here so the page can show
    // the dates without offering an input that would only ever be refused.
    canWrite: can(gate.user.role, "user.write"),
  });
}

// "2026-09-15" → a Date at midnight UTC, or null. Deliberately strict and
// deliberately UTC: these two columns are @db.Date, and parsing "2026-09-15"
// in the server's local zone puts an IST date on the previous UTC day, which
// costs a joiner one day of pay in their first month. Anything that is not
// exactly a yyyy-mm-dd day is rejected rather than guessed at.
function parseDay(v) {
  if (v === null || v === "") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v).trim());
  if (!m) return undefined; // undefined = "not a date", caller turns it into a 400
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return Number.isNaN(d.getTime()) ? undefined : d;
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

    // Asked for at the one moment it is known for certain — the day the
    // account is made is usually the day they started. Optional, because
    // sometimes it is not.
    const joinedOn = parseDay(b.joinedOn ?? null);
    if (joinedOn === undefined) {
      return NextResponse.json({ error: "Joining date must be a date, like 2026-09-15." }, { status: 400 });
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
        joinedOn,
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
