// PATCH /api/users/[id] — change a role, deactivate, or reset a password.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability, hashPassword, ROLES } from "@/lib/auth";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function generatePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  return Array.from(crypto.randomBytes(14)).map((b) => alphabet[b % alphabet.length]).join("");
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

export async function PATCH(req, { params }) {
  const gate = await requireCapability("user.write");
  if (!gate.ok) return gate.response;

  try {
    const id = params?.id;
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) return NextResponse.json({ error: "No such account." }, { status: 404 });

    const b = await req.json().catch(() => ({}));
    const data = {};
    let newPassword = null;

    if (b.name !== undefined && String(b.name).trim()) data.name = String(b.name).trim();
    if (b.phone !== undefined) data.phone = String(b.phone || "").replace(/[^\d+]/g, "") || null;

    // The two payroll dates. Both clearable by sending null — a date entered by
    // mistake must be removable, or the only way back is the database.
    for (const key of ["joinedOn", "leftOn"]) {
      if (b[key] === undefined) continue;
      const d = parseDay(b[key]);
      if (d === undefined) {
        return NextResponse.json(
          { error: `${key === "joinedOn" ? "Joining" : "Leaving"} date must be a date, like 2026-09-15, or empty.` },
          { status: 400 }
        );
      }
      data[key] = d;
    }

    // A last day before the first is not a typo worth guessing at — it silently
    // pays somebody nothing for every month, so it is refused here.
    const nextJoined = data.joinedOn !== undefined ? data.joinedOn : target.joinedOn;
    const nextLeft = data.leftOn !== undefined ? data.leftOn : target.leftOn;
    if (nextJoined && nextLeft && nextLeft < nextJoined) {
      return NextResponse.json(
        { error: "The leaving date is before the joining date." },
        { status: 400 }
      );
    }

    if (b.role !== undefined) {
      if (!ROLES.includes(b.role)) {
        return NextResponse.json({ error: `Role must be one of: ${ROLES.join(", ")}` }, { status: 400 });
      }
      // You cannot demote yourself. Otherwise the only owner clicks "manager"
      // to see what a manager sees, and nobody can set it back.
      if (id === gate.user.id && b.role !== target.role) {
        return NextResponse.json(
          { error: "You cannot change your own role. Ask another owner." },
          { status: 400 }
        );
      }
      data.role = b.role;
    }

    if (b.active !== undefined) {
      if (id === gate.user.id && !b.active) {
        return NextResponse.json({ error: "You cannot deactivate your own account." }, { status: 400 });
      }
      data.active = !!b.active;
    }

    // Losing the last owner locks everyone out of user management, invoicing
    // and commercials permanently — there is no recovery from inside the app.
    if ((data.role && target.role === "owner" && data.role !== "owner") ||
        (data.active === false && target.role === "owner")) {
      const owners = await prisma.user.count({ where: { role: "owner", active: true } });
      if (owners <= 1) {
        return NextResponse.json(
          { error: "This is the only active owner. Make someone else an owner first." },
          { status: 400 }
        );
      }
    }

    if (b.resetPassword) {
      newPassword = generatePassword();
      data.passwordHash = await hashPassword(newPassword);
      // Every session of theirs dies, so a reset actually locks out whoever
      // prompted it rather than leaving them signed in on another device.
      await prisma.session.deleteMany({ where: { userId: id } });
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
    }

    // Deactivating signs them out immediately, not at session expiry.
    if (data.active === false) {
      await prisma.session.deleteMany({ where: { userId: id } });
    }

    const updated = await prisma.user.update({
      where: { id },
      data,
      select: { id: true, name: true, email: true, role: true, active: true },
    });

    await prisma.auditLog
      .create({
        data: {
          userId: gate.user.id, action: "update", entity: "User", entityId: id,
          summary: newPassword ? `Reset password for ${target.name}`
            : data.active === false ? `Deactivated ${target.name}`
            : data.role ? `${target.name}: ${target.role} → ${data.role}`
            : `Updated ${target.name}`,
        },
      })
      .catch((e) => console.error("[user patch] audit write failed:", e?.message));

    return NextResponse.json({ user: updated, ...(newPassword ? { password: newPassword } : {}) });
  } catch (e) {
    console.error("[PATCH /api/users/[id]]", e?.message || e);
    return NextResponse.json({ error: "Could not save the change." }, { status: 500 });
  }
}
