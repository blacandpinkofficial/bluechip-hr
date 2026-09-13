// lib/auth.js — sessions, passwords and who may do what.
//
// Three roles, and that is deliberately all:
//
//   owner      sees money. Placements, revenue, client commercials, invoices.
//   manager    runs the desk. Everything except editing commercials.
//   recruiter  their own work. Candidates, calls, interviews, their own numbers.
//
// A recruiter must not be able to read the whole desk's revenue — in a
// placement agency that is the one number people leave over. So the permission
// check below is not decoration; it is the reason the roles exist.

import crypto from "crypto";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";

export const COOKIE = "bc_session";
const SESSION_DAYS = 14;

export const ROLES = ["owner", "manager", "recruiter"];

// Capability → the roles that hold it. Listed positively: a capability a role
// is not named in, it does not have. Adding a role never silently grants
// anything.
const GRANTS = {
  "client.read":        ["owner", "manager", "recruiter"],
  "client.write":       ["owner", "manager"],
  "client.fees":        ["owner"],              // commercials are owner-only
  "requirement.read":   ["owner", "manager", "recruiter"],
  "requirement.write":  ["owner", "manager"],
  "candidate.read":     ["owner", "manager", "recruiter"],
  "candidate.write":    ["owner", "manager", "recruiter"],
  "candidate.delete":   ["owner", "manager"],
  "interview.read":     ["owner", "manager", "recruiter"],
  "interview.write":    ["owner", "manager", "recruiter"],
  "placement.read":     ["owner", "manager"],
  "placement.write":    ["owner", "manager"],
  "revenue.read":       ["owner", "manager"],   // desk-wide money
  "revenue.own":        ["owner", "manager", "recruiter"], // a recruiter's own
  "invoice.write":      ["owner"],
  "report.desk":        ["owner", "manager"],
  "report.own":         ["owner", "manager", "recruiter"],
  "user.read":          ["owner", "manager"],
  "user.write":         ["owner"],
  "import.run":         ["owner", "manager"],
  "export.run":         ["owner", "manager"],

  // Attendance. Everyone marks their own; only a manager sees or corrects
  // everyone else's. A recruiter who can edit the attendance sheet can edit
  // their own pay, which is the whole reason these are two capabilities and
  // not one.
  "attendance.own":     ["owner", "manager", "recruiter"],
  "attendance.desk":    ["owner", "manager"],
  "attendance.edit":    ["owner", "manager"],

  // Pay. A person may always see their OWN payslip — withholding it is both
  // unkind and, for a payslip, wrong. Nobody but the owner sets a salary.
  "payroll.own":        ["owner", "manager", "recruiter"],
  "payroll.read":       ["owner", "manager"],
  "payroll.write":      ["owner"],
  "salary.write":       ["owner"],

  // Everyone practises. Only a manager reads someone else's transcript — a
  // training tool people think is being watched is a training tool they use
  // once. The score board is visible to all; the words are not.
  "training.use":       ["owner", "manager", "recruiter"],
  "training.review":    ["owner", "manager"],

  "chat.use":           ["owner", "manager", "recruiter"],
  "social.use":         ["owner", "manager", "recruiter"],
};

/** Does this role hold this capability? Unknown capability → false, loudly. */
export function can(role, capability) {
  const holders = GRANTS[capability];
  if (!holders) {
    console.error(`[auth] unknown capability "${capability}" — denying`);
    return false;
  }
  return holders.includes(role);
}

export function allCapabilities(role) {
  return Object.keys(GRANTS).filter((k) => GRANTS[k].includes(role));
}

// ── passwords ───────────────────────────────────────────────────────────────

export async function hashPassword(plain) {
  if (typeof plain !== "string" || plain.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain, hash) {
  if (!plain || !hash) return false;
  return bcrypt.compare(plain, hash);
}

// ── sessions ────────────────────────────────────────────────────────────────

function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export async function createSession(userId, { userAgent, ip } = {}) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000);
  await prisma.session.create({
    data: { userId, token, expiresAt, userAgent: userAgent || null, ip: ip || null },
  });
  return { token, expiresAt };
}

export function sessionCookieOptions(expiresAt) {
  return {
    httpOnly: true,
    sameSite: "lax",
    // Default secure, but overridable: serving over plain HTTP with secure
    // cookies produces a login page that accepts the password and then bounces
    // straight back to itself, with nothing in the logs to explain it.
    secure: process.env.COOKIE_SECURE !== "false",
    path: "/",
    expires: expiresAt,
  };
}

/**
 * The signed-in user, or null. Expired sessions are deleted on sight so the
 * table does not grow forever without a cron job to trim it.
 */
export async function getSession() {
  const token = cookies().get(COOKIE)?.value;
  if (!token) return null;

  const row = await prisma.session
    .findUnique({
      where: { token },
      include: {
        user: {
          select: { id: true, name: true, email: true, role: true, active: true },
        },
      },
    })
    .catch(() => null);

  if (!row) return null;
  if (row.expiresAt < new Date()) {
    await prisma.session.delete({ where: { id: row.id } }).catch(() => {});
    return null;
  }
  if (!row.user || !row.user.active) return null;

  return { user: row.user, sessionId: row.id, expiresAt: row.expiresAt };
}

export async function destroySession(token) {
  if (!token) return;
  await prisma.session.deleteMany({ where: { token } }).catch(() => {});
}

// ── route guards ────────────────────────────────────────────────────────────

/**
 * Use at the top of every API handler:
 *
 *   const gate = await requireCapability("placement.read");
 *   if (!gate.ok) return gate.response;
 *   const { user } = gate;
 *
 * Returning the response rather than throwing keeps the handler's control flow
 * visible — a thrown guard is easy to forget to catch and ends up as a 500 that
 * looks like a bug instead of a 403 that looks like a rule.
 */
export async function requireCapability(capability) {
  const session = await getSession();
  if (!session) {
    return {
      ok: false,
      response: Response.json({ error: "Not signed in" }, { status: 401 }),
    };
  }
  if (!can(session.user.role, capability)) {
    return {
      ok: false,
      response: Response.json(
        { error: "You don't have access to this." },
        { status: 403 }
      ),
    };
  }
  return { ok: true, user: session.user, sessionId: session.sessionId };
}

/**
 * Recruiters see their own work; owners and managers see the desk.
 * Returns a Prisma where-fragment to spread into a query.
 */
export function ownScope(user, field = "ownerId") {
  if (can(user.role, "report.desk")) return {};
  return { [field]: user.id };
}
