// lib/auth.js — sessions, passwords and who may do what.
//
// Four roles:
//
//   owner        sees money. Placements, revenue, client commercials, invoices.
//   manager      runs the desk. Everything except editing commercials.
//   team_leader  runs a team. Gives requirements out, watches the whole desk's
//                WORK — but never the desk's money.
//   recruiter    their own work. Candidates, calls, interviews, their own numbers.
//
// A recruiter must not be able to read the whole desk's revenue — in a
// placement agency that is the one number people leave over. So the permission
// check below is not decoration; it is the reason the roles exist.
//
// team_leader is the line between WORK and MONEY, and that line is the whole
// point of the role. A team leader holds report.desk (they must see what their
// callers are doing) but NOT revenue.read, client.fees, invoice.write or
// payroll.read. Adding a team leader to any money capability collapses the
// distinction, and there is then no reason for the role to exist at all.

import crypto from "crypto";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";

export const COOKIE = "bc_session";
const SESSION_DAYS = 14;

// Roles and their on-screen names live in lib/roles.js, which imports nothing,
// so the nav and the team screen can read them without pulling prisma into the
// browser bundle. Re-exported here because this is where server code already
// looks for them.
export { ROLES, ROLE_LABELS } from "@/lib/roles";

// Capability → the roles that hold it. Listed positively: a capability a role
// is not named in, it does not have. Adding a role never silently grants
// anything.
const GRANTS = {
  "client.read":        ["owner", "manager", "team_leader", "recruiter"],
  "client.write":       ["owner", "manager", "team_leader"],
  "client.fees":        ["owner"],              // commercials are owner-only
  "requirement.read":   ["owner", "manager", "team_leader", "recruiter"],
  "requirement.write":  ["owner", "manager", "team_leader"],
  "candidate.read":     ["owner", "manager", "team_leader", "recruiter"],
  "candidate.write":    ["owner", "manager", "team_leader", "recruiter"],
  "candidate.delete":   ["owner", "manager", "team_leader"],
  "interview.read":     ["owner", "manager", "team_leader", "recruiter"],
  "interview.write":    ["owner", "manager", "team_leader", "recruiter"],
  "placement.read":     ["owner", "manager", "team_leader"],
  "placement.write":    ["owner", "manager", "team_leader"],
  "revenue.read":       ["owner", "manager"],   // desk-wide money — NOT the TL
  "revenue.own":        ["owner", "manager", "team_leader", "recruiter"],
  "invoice.write":      ["owner"],
  "report.desk":        ["owner", "manager", "team_leader"],
  "report.own":         ["owner", "manager", "team_leader", "recruiter"],
  "user.read":          ["owner", "manager", "team_leader"],
  "user.write":         ["owner"],

  // Knowledge holds scanned client agreements alongside handover notes, and an
  // agreement has the fee in it. Same holders as revenue.read, and for the same
  // reason: this is the money line, and the team leader sits on the work side
  // of it. See lib/documents.js.
  "document.confidential": ["owner", "manager"],

  // Two import capabilities, not one. The requirements sheet creates clients
  // and openings and is a desk-level act; a candidate list is just the day's
  // calling, and is exactly what a telecaller is handed each morning.
  // Collapsing these into one key means either telecallers cannot load their
  // own list, or they can bulk-create clients. Neither is what anyone wants.
  "import.run":         ["owner", "manager", "team_leader"],
  "import.candidates":  ["owner", "manager", "team_leader", "recruiter"],
  "export.run":         ["owner", "manager", "team_leader"],

  // Attendance. Everyone marks their own; only a manager or team leader sees or
  // corrects everyone else's. A recruiter who can edit the attendance sheet can
  // edit their own pay, which is the whole reason these are two capabilities
  // and not one. A team leader running a shift has the same power over their
  // own row that a manager does — that is accepted, not overlooked.
  "attendance.own":     ["owner", "manager", "team_leader", "recruiter"],
  "attendance.desk":    ["owner", "manager", "team_leader"],
  "attendance.edit":    ["owner", "manager", "team_leader"],

  // Pay. A person may always see their OWN payslip — withholding it is both
  // unkind and, for a payslip, wrong. Nobody but the owner sets a salary, and
  // a team leader does not see what their team is paid.
  "payroll.own":        ["owner", "manager", "team_leader", "recruiter"],
  "payroll.read":       ["owner", "manager"],
  "payroll.write":      ["owner"],
  "salary.write":       ["owner"],

  // Everyone practises. Only a manager or team leader reads someone else's
  // transcript — a training tool people think is being watched is a training
  // tool they use once. The score board is visible to all; the words are not.
  "training.use":       ["owner", "manager", "team_leader", "recruiter"],
  "training.review":    ["owner", "manager", "team_leader"],

  "chat.use":           ["owner", "manager", "team_leader", "recruiter"],
  "social.use":         ["owner", "manager", "team_leader", "recruiter"],
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
 * Recruiters see their own work; owners, managers and team leaders see the
 * desk. Returns a Prisma where-fragment to spread into a query.
 */
export function ownScope(user, field = "ownerId") {
  if (can(user.role, "report.desk")) return {};
  return { [field]: user.id };
}
