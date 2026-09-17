// lib/roles.js — what a role is CALLED, in one place.
//
// This file is deliberately inert: no prisma, no bcrypt, no next/headers, no
// imports at all. That is the whole point. Role names are needed by the nav,
// the team screen, the daily sheet and four other client components, and
// lib/auth.js cannot be imported into any of them — it drags the database
// client into the browser bundle and the build fails. So the names live here
// and lib/auth.js re-exports them, rather than each screen keeping its own
// copy.
//
// It kept its own copy three times over, which is how Reports ended up
// printing the raw stored value while the header two inches above it printed
// the pretty one, and how Pay setup printed "Team_leader". A label duplicated
// is a label that will disagree with itself; the only question is when.
//
// WHAT THEY ARE CALLED: "Recruiter". The desk said "telecaller" for years and
// the app said it back to them, on their own Team page, next to Owner and
// Manager. Ram's words: they feel a little respect. The job is the same job —
// what changed is that the screen no longer names them after the equipment.
//
// "Telecaller" survives in exactly one place on purpose: lib/social.js matches
// it when reading a CLIENT's job description, because that is the word clients
// write in their openings and a job ad has to be findable by the word the
// candidate typed. That is somebody else's vocabulary for somebody else's
// vacancy, not what we call our own people.
//
// The stored value stays `recruiter` — it is what is in the database and in
// every capability check, and a display name must never mean a data migration.
// To rename the job on screen again, change ONE line below; every screen reads
// from here, including the prose that used to spell it out by hand.

/** Stored role values, most privileged last. Mirrored by ROLES in lib/auth.js. */
export const ROLES = ["owner", "manager", "team_leader", "recruiter"];

/** Stored value → what a human sees. */
export const ROLE_LABELS = {
  owner: "Owner",
  manager: "Manager",
  team_leader: "Team Leader",
  recruiter: "Recruiter",
};

/** One line on what the role can see. Shown under the role picker. */
export const ROLE_BLURB = {
  owner: "Everything, including commercials, revenue and invoices.",
  manager: "The whole desk, except setting client rates and invoicing.",
  team_leader:
    "Runs a team. Gives out openings, watches every caller's work, reviews practice calls — but sees no revenue, no client rates and no one else's pay.",
  recruiter: "Their own candidates, calls and interviews, and their own numbers only.",
};

/** Badge colours. Written out in full — Tailwind cannot see a built-up name. */
export const ROLE_TONE = {
  owner: "bg-chip-100 text-chip-800 border-chip-300",
  manager: "bg-sky-100 text-sky-800 border-sky-300",
  team_leader: "bg-amber-100 text-amber-800 border-amber-300",
  recruiter: "bg-slate-100 text-slate-700 border-slate-300",
};

const FALLBACK_TONE = "bg-slate-100 text-slate-700 border-slate-300";

/**
 * The name to print. An unknown role falls back to its raw stored value rather
 * than to a blank — a screen that says "team_leader" is confusing, but one that
 * says nothing at all where a role should be looks like a loading bug.
 */
export function roleName(role) {
  return ROLE_LABELS[role] || role || "—";
}

export function roleTone(role) {
  return ROLE_TONE[role] || FALLBACK_TONE;
}

export function roleBlurb(role) {
  return ROLE_BLURB[role] || "";
}

/**
 * For <select>. Least privileged first, because that is the one being created
 * nearly every time and it should be the default the cursor lands on.
 */
export const ROLE_OPTIONS = ["recruiter", "team_leader", "manager", "owner"].map((value) => ({
  value,
  label: ROLE_LABELS[value],
}));
