// scripts/seed-demo.mjs — a complete, obviously-fake recruitment story.
//
//   node scripts/seed-demo.mjs          (or: npm run demo:seed)
//
// WHY THIS EXISTS
// The app is live but nearly empty, so there is nothing to walk somebody
// through. This writes ONE self-contained demo client set — two companies, five
// openings, twenty candidates spread across every stage — so that every screen
// has something real-shaped on it: calls with outcomes, a callback that is
// already late, CVs sent and gone quiet, interviews tomorrow, a selection that
// has not joined yet, two joinings with revenue, and one dropped candidate in
// History.
//
// WHY IT IS SAFE TO RUN AGAINST THE LIVE DATABASE
//   1. Nothing here touches an existing client or requirement. Demo rows hang
//      off demo clients only, and demo clients are the two whose name begins
//      "DEMO ".
//   2. Every demo candidate's phone number is in a reserved block that cannot
//      be a real number — see DEMO_PHONE_PREFIX below. The @@unique([phone])
//      constraint therefore cannot be tripped by, or hijack, a real person.
//   3. It is idempotent. Run it ten times and you get the same twenty
//      candidates: clients and candidates are upserted on their unique keys,
//      and the call / submission / interview / placement rows belonging to demo
//      candidates are cleared and rewritten each run.
//   4. Everything happens inside ONE interactive transaction. A seeder that
//      dies halfway through a live database leaves a mess that somebody has to
//      unpick by hand; this one either lands completely or not at all.
//
// To remove it all again: node scripts/unseed-demo.mjs --yes

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ═══════════════════════════════════════════════════════════════════════════
// THE MARKERS — these three constants ARE the contract with unseed-demo.mjs.
// If you change one here, change it there. They are duplicated rather than
// shared because scripts/ has no module of its own and this pair should not
// grow a third file between them.
// ═══════════════════════════════════════════════════════════════════════════

// Client.name is @unique, so this prefix is the anchor everything else hangs
// off. It is also what a human sees: the client column on every requirement,
// submission, placement and invoice row reads "DEMO …".
const DEMO_CLIENT_PREFIX = "DEMO ";

// Candidate.name carries the same prefix, so a demo person is unmistakable on
// the call list, on an interview card and on a placement row.
const DEMO_NAME_PREFIX = "DEMO ";

// Candidate.source — the machine marker. The real values are
// naukri | referral | walk-in | database | linkedin | whatsapp, so this one
// can never be a real recruiter's entry.
const DEMO_SOURCE = "demo-seed";

// ── THE RESERVED PHONE BLOCK ────────────────────────────────────────────────
//
// Candidate.phone is @@unique. A demo number that collided with a real one
// would either crash the seeder or, worse, quietly overwrite a real person's
// record. So the demo block is chosen to be OUTSIDE the Indian numbering plan
// entirely:
//
//   • Indian mobile numbers are ten digits beginning 6, 7, 8 or 9.
//   • Landlines are dialled with a trunk prefix 0 followed by an STD code
//     whose first digit is 1–8 (011 Delhi, 022 Mumbai, 044 Chennai, 080…).
//   • "00" is the international access prefix. No Indian subscriber number,
//     mobile or fixed, begins 00.
//
// So 009000xxxx is not a number anybody can have. It is also unreachable
// through the app's own create path: POST /api/candidates normalises with
// .replace(/[^\d+]/g,"").slice(-10), which keeps the LAST ten digits — a typed
// number can only end up with a leading 00 if somebody deliberately typed one.
//
// It stays ten digits so the phone column, search and the WhatsApp helper all
// behave normally on screen.
const DEMO_PHONE_PREFIX = "009000"; // → 0090000001 … 0090000099

// Email domain. ".invalid" is reserved by RFC 2606 and can never resolve, so
// no mail addressed to a demo candidate can reach a real inbox.
const DEMO_EMAIL_DOMAIN = "demo.invalid";

const DEMO_NOTE =
  "DEMO DATA — created by scripts/seed-demo.mjs. Remove with: node scripts/unseed-demo.mjs --yes";

// ═══════════════════════════════════════════════════════════════════════════
// DATES
// ═══════════════════════════════════════════════════════════════════════════
//
// Everything is relative to the moment the script runs, so the demo is never
// stale: "an interview tomorrow" is tomorrow whenever Mohan is shown it.
// Times are IST wall-clock, matching lib/day.js, because this desk works in
// India and the server runs UTC.

const IST_OFFSET_MIN = 330;

/** The IST working day an instant falls in, as a UTC-midnight Date. */
function istDay(at = new Date()) {
  const ist = new Date(new Date(at).getTime() + IST_OFFSET_MIN * 60000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

const TODAY = istDay();

/** An instant: `days` from today (negative = past), at hh:mm IST. */
function ist(days, hh = 10, mm = 0) {
  return new Date(TODAY.getTime() + days * 86400000 + (hh * 60 + mm - IST_OFFSET_MIN) * 60000);
}

// The placements screen and the MTD report default to the current IST month.
// A "selected 20 days ago" that lands in August would simply not appear, so
// anything money-related is clamped into this month.
const MONTH_START = (() => {
  const first = new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth(), 1));
  return new Date(first.getTime() + (9 * 60 - IST_OFFSET_MIN) * 60000); // 1st, 09:00 IST
})();

function notBefore(d, floor) {
  return d.getTime() < floor.getTime() ? new Date(floor.getTime()) : d;
}

// ═══════════════════════════════════════════════════════════════════════════
// FEES
// ═══════════════════════════════════════════════════════════════════════════
//
// Deliberately re-stated here rather than imported from lib/fees.js: that file
// is a .js in a package with no "type": "module", so plain node cannot import
// it — only the Next bundler can. The arithmetic is copied exactly (multiply
// first, divide once, round once) and must stay in step with lib/fees.js.

function resolveFee(requirement, client) {
  const r = requirement || {};
  const c = client || {};
  if (r.feeType === "percent" && r.feeBps != null) return { feeType: "percent", feeBps: r.feeBps, feeFlat: null };
  if (r.feeType === "flat" && r.feeFlat != null) return { feeType: "flat", feeBps: null, feeFlat: r.feeFlat };
  if (c.feeType === "percent" && c.feeBps != null) return { feeType: "percent", feeBps: c.feeBps, feeFlat: null };
  if (c.feeType === "flat" && c.feeFlat != null) return { feeType: "flat", feeBps: null, feeFlat: c.feeFlat };
  return { feeType: null, feeBps: null, feeFlat: null };
}

function computeRevenue({ feeType, feeBps, feeFlat, ctcOfferedAnnual }) {
  if (feeType === "flat") return feeFlat == null ? null : Math.round(feeFlat);
  if (feeType === "percent") {
    if (feeBps == null || ctcOfferedAnnual == null) return null;
    return Math.round((Math.round(ctcOfferedAnnual) * Math.round(feeBps)) / 10000);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE STORY
// ═══════════════════════════════════════════════════════════════════════════

const CLIENTS = [
  {
    key: "ascend",
    name: `${DEMO_CLIENT_PREFIX}Ascend Health BPO`,
    hrName: "Priya Raghavan (demo contact)",
    hrPhone: "0090000101",
    hrEmail: `hr@ascend.${DEMO_EMAIL_DOMAIN}`,
    city: "Chennai",
    feeType: "percent",
    feeBps: 833, // 8.33% of annual CTC
    feeFlat: null,
    paymentDays: 30,
    gstin: "33DEMOGSTIN01Z5",
    state: "Tamil Nadu",
    address: "Demo address — Guindy Industrial Estate, Chennai 600032",
    active: true,
  },
  {
    key: "perungudi",
    name: `${DEMO_CLIENT_PREFIX}Perungudi Tech Services`,
    hrName: "Arun Kumar (demo contact)",
    hrPhone: "0090000102",
    hrEmail: `talent@perungudi.${DEMO_EMAIL_DOMAIN}`,
    city: "Chennai",
    feeType: "flat",
    feeBps: null,
    feeFlat: 15000, // rupees per joining
    paymentDays: 45,
    gstin: "33DEMOGSTIN02Z3",
    state: "Tamil Nadu",
    address: "Demo address — Perungudi, OMR, Chennai 600096",
    active: true,
  },
];

// designation is unique within a client here — that pair is how a requirement
// is found again on a re-run, since Requirement has no unique constraint.
const REQUIREMENTS = [
  {
    key: "ar",
    client: "ascend",
    designation: "AR Caller — Denials",
    domain: "RCM / Denials",
    processType: "voice",
    processDetail: "US healthcare AR follow-up, denials management",
    location: "Guindy, Chennai",
    openings: 12,
    expMinMonths: 6,
    expMaxMonths: 36,
    takeHomeMin: 18000,
    takeHomeMax: 28000,
    shift: "night",
    feeType: null, // falls back to the client's 8.33%
    feeBps: null,
    feeFlat: null,
    relievingRequired: false,
    arrearsAllowed: true,
    educationMin: "Any graduate",
    docsRequired: "Aadhaar, PAN, last 3 payslips",
    cabFacility: "twoway",
    status: "open",
    priority: "high",
    publishOnline: true,
    openedDaysAgo: 28,
  },
  {
    key: "coding",
    client: "ascend",
    designation: "Medical Coding Executive",
    domain: "RCM / Coding",
    processType: "non-voice",
    processDetail: "IP DRG and E/M coding, CPC certified preferred",
    location: "Ambattur, Chennai",
    openings: 5,
    expMinMonths: 12,
    expMaxMonths: 48,
    takeHomeMin: 22000,
    takeHomeMax: 35000,
    shift: "day",
    feeType: null,
    feeBps: null,
    feeFlat: null,
    relievingRequired: true,
    arrearsAllowed: false,
    educationMin: "Any life-science graduate",
    docsRequired: "Relieving letter, CPC certificate, Aadhaar",
    cabFacility: "oneway",
    status: "open",
    priority: "normal",
    publishOnline: true,
    openedDaysAgo: 19,
  },
  {
    key: "tl",
    client: "ascend",
    designation: "Team Lead — AR Calling",
    domain: "RCM / Denials",
    processType: "voice",
    processDetail: "Leading a team of 15 AR callers",
    location: "Guindy, Chennai",
    openings: 1,
    expMinMonths: 36,
    expMaxMonths: 72,
    takeHomeMin: 40000,
    takeHomeMax: 55000,
    shift: "night",
    feeType: null,
    feeBps: null,
    feeFlat: null,
    relievingRequired: true,
    arrearsAllowed: false,
    educationMin: "Any graduate",
    docsRequired: "Relieving letter, last 3 payslips",
    cabFacility: "twoway",
    // On hold, so the requirements screen shows more than one status.
    status: "hold",
    priority: "low",
    publishOnline: false,
    openedDaysAgo: 40,
  },
  {
    key: "itsup",
    client: "perungudi",
    designation: "IT Support Engineer (L1)",
    domain: "Infrastructure support",
    processType: "semi-voice",
    processDetail: "L1 desktop and O365 support, ticket-based",
    location: "OMR, Chennai",
    openings: 4,
    expMinMonths: 12,
    expMaxMonths: 36,
    takeHomeMin: 25000,
    takeHomeMax: 40000,
    shift: "rotational",
    // A one-off rate for this opening, overriding the client's flat fee — so
    // the demo shows fee resolution taking the requirement's terms first.
    feeType: "percent",
    feeBps: 1000, // 10% of annual CTC
    feeFlat: null,
    relievingRequired: false,
    arrearsAllowed: true,
    educationMin: "Any degree / diploma",
    docsRequired: "Aadhaar, PAN",
    cabFacility: "none",
    status: "open",
    priority: "high",
    publishOnline: true,
    openedDaysAgo: 15,
  },
  {
    key: "sales",
    client: "perungudi",
    designation: "Field Sales Executive",
    domain: "B2B SME sales",
    processType: null, // field work is neither voice nor non-voice
    processDetail: "Field sales — SME accounts across Chennai",
    location: "Perungudi, Chennai",
    openings: 6,
    expMinMonths: 0,
    expMaxMonths: 24,
    takeHomeMin: 16000,
    takeHomeMax: 24000,
    shift: "day",
    feeType: null, // falls back to the client's ₹15,000 flat
    feeBps: null,
    feeFlat: null,
    relievingRequired: false,
    arrearsAllowed: true,
    educationMin: "12th pass or above",
    docsRequired: "Aadhaar, two-wheeler licence",
    cabFacility: "none",
    status: "open",
    priority: "normal",
    publishOnline: true,
    openedDaysAgo: 9,
  },
];

// Candidates. `calls` drives callCount, lastContactedAt and nextFollowUpAt —
// they are never written by hand, because a demo whose counters disagree with
// its own call log argues against the app instead of for it.
//
// n → phone DEMO_PHONE_PREFIX + n, zero-padded to four.
const CANDIDATES = [
  // ── new: on the list, barely touched ──────────────────────────────────────
  {
    n: 1, name: "Karthik Ravi", req: "ar", stage: "new",
    designation: "AR Caller", location: "Guindy, Chennai", expMonths: 14,
    currentCtc: 19000, expectedCtc: 25000, noticeDays: 30,
    skills: "AR calling, denials, EPIC", education: "B.Com",
    hasRelieving: true, hasArrears: false, rating: null,
    status: "Applied through the careers page",
    calls: [],
  },
  {
    n: 2, name: "Divya Sundaram", req: "coding", stage: "new",
    designation: "Medical Coder", location: "Ambattur, Chennai", expMonths: 26,
    currentCtc: 24000, expectedCtc: 32000, noticeDays: 60,
    skills: "CPC, IP DRG, E/M coding", education: "B.Sc Biochemistry",
    hasRelieving: true, hasArrears: false, rating: null,
    status: "CPC certified — worth a call today",
    calls: [{ d: -1, hh: 11, mm: 15, outcome: "no-answer", notes: "Rang out. Try after 6pm." }],
  },
  {
    n: 3, name: "Mohammed Irfan", req: "itsup", stage: "new",
    designation: "Desktop Support", location: "OMR, Chennai", expMonths: 20,
    currentCtc: 26000, expectedCtc: 34000, noticeDays: 30,
    skills: "Windows 11, O365, AD, ticketing", education: "B.E CSE",
    hasRelieving: true, hasArrears: true, rating: null,
    status: null,
    calls: [
      { d: -3, hh: 15, mm: 0, outcome: "busy", notes: "Engaged twice." },
      { d: 0, hh: 10, mm: 30, outcome: "no-answer", notes: null },
    ],
  },

  // ── contacted: spoken to, with the callbacks that come out of that ────────
  {
    n: 4, name: "Lavanya Prakash", req: "ar", stage: "contacted",
    designation: "Senior AR Caller", location: "Velachery, Chennai", expMonths: 31,
    currentCtc: 26000, expectedCtc: 33000, noticeDays: 30,
    skills: "AR calling, denials, appeals", education: "B.A English",
    hasRelieving: true, hasArrears: false, rating: 4,
    status: "Interested. Asked to be called back — now overdue.",
    // The last call promised a callback that is already two days past. This is
    // the row that makes the follow-up queue worth looking at.
    calls: [
      { d: -9, hh: 12, mm: 0, outcome: "connected", notes: "Open to a night shift, wants ₹33k." },
      { d: -5, hh: 18, mm: 30, outcome: "callback", notes: "In a meeting — call back Wednesday.", followUpIn: 3 },
    ],
    followUpOverdueDays: 2, // last call's followUpAt is forced to 2 days ago
  },
  {
    n: 5, name: "Suresh Balan", req: "sales", stage: "contacted",
    designation: "Sales Executive", location: "Perungudi, Chennai", expMonths: 18,
    currentCtc: 17000, expectedCtc: 22000, noticeDays: 15,
    skills: "B2B sales, field, two-wheeler", education: "B.B.A",
    hasRelieving: false, hasArrears: true, rating: 3,
    status: "Wants to discuss the incentive structure tomorrow",
    calls: [
      { d: -4, hh: 11, mm: 0, outcome: "connected", notes: "Has his own two-wheeler. Keen." },
      { d: 0, hh: 9, mm: 30, outcome: "callback", notes: "Call him tomorrow morning about the incentive structure.", followUpIn: 1 },
    ],
  },
  {
    n: 6, name: "Anitha Selvam", req: "coding", stage: "contacted",
    designation: "Medical Coder", location: "Anna Nagar, Chennai", expMonths: 40,
    currentCtc: 30000, expectedCtc: 38000, noticeDays: 60,
    skills: "CPC, surgery coding, audits", education: "B.Sc Nursing",
    hasRelieving: true, hasArrears: false, rating: 4,
    status: "Sending an updated CV",
    calls: [{ d: 0, hh: 11, mm: 15, outcome: "connected", notes: "Will send the updated CV by Friday." }],
  },
  {
    n: 7, name: "Gokul Nathan", req: "itsup", stage: "contacted",
    designation: "IT Support Engineer", location: "Tambaram, Chennai", expMonths: 22,
    currentCtc: 28000, expectedCtc: 36000, noticeDays: 30,
    skills: "L1 support, O365, hardware", education: "B.Sc Computer Science",
    hasRelieving: true, hasArrears: false, rating: 3,
    status: "Worried about the rotational shift",
    calls: [
      { d: -6, hh: 10, mm: 0, outcome: "connected", notes: "Interested but unsure about rotational shifts." },
      { d: -2, hh: 16, mm: 20, outcome: "no-answer", notes: "No answer on the follow-up." },
    ],
  },

  // ── shortlisted: CV with the client, waiting on them ──────────────────────
  {
    n: 8, name: "Ramya Krishnan", req: "ar", stage: "shortlisted",
    designation: "AR Caller", location: "Guindy, Chennai", expMonths: 24,
    currentCtc: 21000, expectedCtc: 27000, noticeDays: 30,
    skills: "AR calling, denials, Athena", education: "B.Com",
    hasRelieving: true, hasArrears: false, rating: 4,
    status: "CV sent — waiting for the client",
    calls: [{ d: -7, hh: 11, mm: 30, outcome: "connected", notes: "Screened and cleared. CV going across." }],
    submission: { d: -6, method: "email", status: "sent" },
  },
  {
    n: 9, name: "Vignesh Murugan", req: "ar", stage: "shortlisted",
    designation: "AR Caller", location: "Chromepet, Chennai", expMonths: 11,
    currentCtc: 18000, expectedCtc: 24000, noticeDays: 15,
    skills: "AR calling, denials", education: "B.B.A",
    hasRelieving: true, hasArrears: true, rating: 3,
    status: "Client acknowledged receipt",
    calls: [{ d: -8, hh: 12, mm: 15, outcome: "connected", notes: "Arrears cleared. Good communication." }],
    submission: { d: -7, method: "email", status: "acknowledged", respondedIn: 2, response: "Received, under review." },
  },
  {
    n: 10, name: "Sneha Rajan", req: "itsup", stage: "shortlisted",
    designation: "Service Desk Analyst", location: "OMR, Chennai", expMonths: 30,
    currentCtc: 31000, expectedCtc: 39000, noticeDays: 30,
    skills: "ITIL, O365, Intune, ticketing", education: "B.Tech IT",
    hasRelieving: true, hasArrears: false, rating: 5,
    status: "Client has shortlisted — slot being fixed",
    calls: [
      { d: -10, hh: 10, mm: 45, outcome: "connected", notes: "Strong profile. Available to attend any day." },
      { d: -3, hh: 15, mm: 30, outcome: "connected", notes: "Confirmed still available." },
    ],
    submission: { d: -9, method: "portal", status: "shortlisted", respondedIn: 4, response: "Shortlisted — please share availability." },
  },
  {
    n: 11, name: "Prasanth Kumar", req: "coding", stage: "shortlisted",
    designation: "Medical Coder", location: "Ambattur, Chennai", expMonths: 16,
    currentCtc: 23000, expectedCtc: 30000, noticeDays: 30,
    skills: "E/M coding, CPC-A", education: "B.Sc Microbiology",
    hasRelieving: true, hasArrears: false, rating: 3,
    // Twelve days of silence. This is the row the submissions screen exists for.
    status: "No response from the client for 12 days",
    calls: [{ d: -14, hh: 13, mm: 0, outcome: "connected", notes: "Screened. CPC-A, not yet certified." }],
    submission: { d: -12, method: "email", status: "no-response" },
  },

  // ── lined-up: interviews in the next few days ─────────────────────────────
  {
    n: 12, name: "Deepa Venkatesh", req: "ar", stage: "lined-up",
    designation: "AR Caller", location: "Guindy, Chennai", expMonths: 28,
    currentCtc: 23000, expectedCtc: 29000, noticeDays: 30,
    skills: "AR calling, denials, appeals", education: "B.Com",
    hasRelieving: true, hasArrears: false, rating: 4,
    status: "Telephonic round tomorrow, 11am",
    calls: [
      { d: -11, hh: 11, mm: 0, outcome: "connected", notes: "Screened and cleared." },
      { d: 0, hh: 9, mm: 45, outcome: "connected", notes: "Interview slot confirmed for tomorrow, 11am." },
    ],
    submission: { d: -10, method: "email", status: "interview-scheduled", respondedIn: 3, response: "Please line up for a telephonic round." },
    interview: { d: 1, hh: 11, mm: 0, mode: "telephonic", round: 1, interviewer: "Priya Raghavan (demo)", outcome: "pending", attended: null },
  },
  {
    n: 13, name: "Ajith Narayanan", req: "itsup", stage: "lined-up",
    designation: "Desktop Support Engineer", location: "Sholinganallur, Chennai", expMonths: 19,
    currentCtc: 27000, expectedCtc: 35000, noticeDays: 30,
    skills: "Windows, AD, VPN, remote support", education: "B.E ECE",
    hasRelieving: true, hasArrears: false, rating: 4,
    status: "Direct interview at the OMR office on Thursday",
    calls: [{ d: -6, hh: 12, mm: 30, outcome: "connected", notes: "Happy to attend in person." }],
    submission: { d: -5, method: "email", status: "interview-scheduled", respondedIn: 2, response: "Send him across Thursday 2pm." },
    interview: { d: 2, hh: 14, mm: 0, mode: "direct", round: 1, interviewer: "Arun Kumar (demo)", outcome: "pending", attended: null, location: "OMR, Chennai" },
  },
  {
    n: 14, name: "Bhuvana Shankar", req: "sales", stage: "lined-up",
    designation: "Sales Executive", location: "Perungudi, Chennai", expMonths: 8,
    currentCtc: 15000, expectedCtc: 20000, noticeDays: 7,
    skills: "Field sales, cold calling", education: "B.Com",
    hasRelieving: false, hasArrears: true, rating: 3,
    status: "Video round on Friday",
    calls: [{ d: -3, hh: 10, mm: 15, outcome: "connected", notes: "Fresher-ish, but very willing. Lined up." }],
    submission: { d: -3, method: "whatsapp", status: "interview-scheduled", respondedIn: 1, response: "Video call Friday 4pm." },
    interview: { d: 4, hh: 16, mm: 0, mode: "video", round: 1, interviewer: "Arun Kumar (demo)", outcome: "pending", attended: null },
  },

  // ── interviewed: attended, outcome recorded ───────────────────────────────
  {
    n: 15, name: "Nandhini Raj", req: "coding", stage: "interviewed",
    designation: "Medical Coder", location: "Ambattur, Chennai", expMonths: 34,
    currentCtc: 28000, expectedCtc: 36000, noticeDays: 60,
    skills: "CPC, IP DRG", education: "B.Sc Zoology",
    hasRelieving: true, hasArrears: false, rating: 4,
    status: "On hold — client comparing two profiles",
    calls: [
      { d: -16, hh: 11, mm: 0, outcome: "connected", notes: "Screened." },
      { d: -4, hh: 18, mm: 0, outcome: "connected", notes: "Attended. Waiting for the client's call." },
    ],
    submission: { d: -15, method: "email", status: "interview-scheduled", respondedIn: 3, response: "Line up for Tuesday." },
    interview: { d: -5, hh: 11, mm: 0, mode: "direct", round: 1, interviewer: "Priya Raghavan (demo)", attended: true, outcome: "on-hold", feedback: "Good coding accuracy. Client comparing against one other profile.", location: "Ambattur, Chennai" },
  },
  {
    n: 16, name: "Hari Prasad", req: "ar", stage: "interviewed",
    designation: "AR Caller", location: "Pallavaram, Chennai", expMonths: 9,
    currentCtc: 17000, expectedCtc: 24000, noticeDays: 15,
    skills: "AR calling", education: "B.A Economics",
    hasRelieving: false, hasArrears: true, rating: 2,
    status: "Rejected — communication not at the level the client wants",
    calls: [{ d: -13, hh: 15, mm: 45, outcome: "connected", notes: "Borderline on communication, but worth a shot." }],
    submission: { d: -12, method: "email", status: "interview-scheduled", respondedIn: 2, response: "Telephonic Monday." },
    interview: { d: -8, hh: 12, mm: 0, mode: "telephonic", round: 1, interviewer: "Priya Raghavan (demo)", attended: true, outcome: "rejected", feedback: "Communication below the bar for a US voice process." },
  },

  // ── selected: offered, not joined — revenue is not real yet ───────────────
  {
    n: 17, name: "Sathish Kannan", req: "ar", stage: "selected",
    designation: "Senior AR Caller", location: "Guindy, Chennai", expMonths: 33,
    currentCtc: 24000, expectedCtc: 30000, noticeDays: 30,
    skills: "AR calling, denials, appeals, EPIC", education: "B.Com",
    hasRelieving: true, hasArrears: false, rating: 5,
    status: "Selected — offer out, joining date not confirmed",
    calls: [
      { d: -18, hh: 10, mm: 30, outcome: "connected", notes: "Screened. Strong." },
      { d: -6, hh: 19, mm: 0, outcome: "connected", notes: "Selected. Serving 30 days' notice." },
    ],
    submission: { d: -17, method: "email", status: "interview-scheduled", respondedIn: 2, response: "Line up for two rounds." },
    interview: { d: -9, hh: 11, mm: 30, mode: "direct", round: 2, interviewer: "Priya Raghavan (demo)", attended: true, outcome: "selected", feedback: "Selected. Offer at ₹3.12L annual.", location: "Guindy, Chennai" },
    placement: {
      selectedDaysAgo: 6,
      joinedDaysAgo: null, // not joined — revenue not yet real
      ctcOfferedAnnual: 312000,
      takeHomeMonthly: 26000,
      employeeId: null,
      invoiceStatus: "pending",
    },
  },

  // ── joined: the money side ────────────────────────────────────────────────
  {
    n: 18, name: "Kavitha Mohan", req: "itsup", stage: "joined",
    designation: "IT Support Engineer", location: "OMR, Chennai", expMonths: 29,
    currentCtc: 30000, expectedCtc: 38000, noticeDays: 30,
    skills: "L1/L2 support, O365, Intune, ITIL", education: "B.Tech IT",
    hasRelieving: true, hasArrears: false, rating: 5,
    status: "Joined — invoice raised",
    calls: [
      { d: -22, hh: 11, mm: 0, outcome: "connected", notes: "Screened. Excellent fit." },
      { d: -8, hh: 17, mm: 0, outcome: "connected", notes: "Joined on Monday. Settled in well." },
    ],
    submission: { d: -21, method: "email", status: "interview-scheduled", respondedIn: 1, response: "Line up immediately." },
    interview: { d: -16, hh: 15, mm: 0, mode: "video", round: 1, interviewer: "Arun Kumar (demo)", attended: true, outcome: "selected", feedback: "Selected on the spot." },
    placement: {
      selectedDaysAgo: 15,
      joinedDaysAgo: 8,
      ctcOfferedAnnual: 420000, // 10% requirement override → ₹42,000
      takeHomeMonthly: 35000,
      employeeId: "DEMO-EMP-1041",
      invoiceStatus: "raised",
      invoiceNo: "DEMO/NOT-A-REAL-INVOICE/001",
      invoicedDaysAgo: 5,
    },
  },
  {
    n: 19, name: "Manoj Pandian", req: "sales", stage: "joined",
    designation: "Field Sales Executive", location: "Perungudi, Chennai", expMonths: 21,
    currentCtc: 18000, expectedCtc: 23000, noticeDays: 15,
    skills: "B2B field sales, SME accounts", education: "B.B.A",
    hasRelieving: true, hasArrears: false, rating: 4,
    status: "Joined — invoice paid",
    calls: [
      { d: -25, hh: 12, mm: 0, outcome: "connected", notes: "Screened. Has his own vehicle." },
      { d: -12, hh: 18, mm: 30, outcome: "connected", notes: "Joined. Client happy." },
    ],
    submission: { d: -24, method: "in-person", status: "interview-scheduled", respondedIn: 1, response: "Walk-in Saturday." },
    interview: { d: -20, hh: 10, mm: 0, mode: "direct", round: 1, interviewer: "Arun Kumar (demo)", attended: true, outcome: "selected", feedback: "Selected at the walk-in.", location: "Perungudi, Chennai" },
    placement: {
      selectedDaysAgo: 19,
      joinedDaysAgo: 12,
      ctcOfferedAnnual: 264000, // client flat fee → ₹15,000
      takeHomeMonthly: 22000,
      employeeId: "DEMO-EMP-2207",
      invoiceStatus: "paid",
      invoiceNo: "DEMO/NOT-A-REAL-INVOICE/002",
      invoicedDaysAgo: 9,
      paidDaysAgo: 2,
    },
  },

  // ── dropped: so History is not empty ─────────────────────────────────────
  {
    n: 20, name: "Vijay Anand", req: "coding", stage: "dropped",
    designation: "Medical Coder", location: "Porur, Chennai", expMonths: 13,
    currentCtc: 22000, expectedCtc: 32000, noticeDays: 90,
    skills: "E/M coding", education: "B.Sc Biotechnology",
    hasRelieving: false, hasArrears: true, rating: 1,
    status: "Not interested — counter-offered by his current employer",
    archived: true, // dropped candidates leave the working list, per the calls API
    calls: [
      { d: -17, hh: 14, mm: 0, outcome: "connected", notes: "Interested, but 90 days' notice." },
      { d: -10, hh: 16, mm: 0, outcome: "wrong-number", notes: "Alternate number was wrong." },
      { d: -7, hh: 11, mm: 0, outcome: "not-interested", notes: "Counter-offered. Out for now." },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function demoPhone(n) {
  return DEMO_PHONE_PREFIX + String(n).padStart(4, "0");
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "");
}

/**
 * The three denormalised caches on Candidate, derived from the call list —
 * exactly as POST /api/candidates/[id]/calls derives them:
 *   callCount        one per logged call
 *   lastContactedAt  the most recent call
 *   nextFollowUpAt   the followUpAt of the most recent call, and null if that
 *                    call did not promise one (clearing is the half that
 *                    matters; without it a made callback sits "due" forever)
 */
function derivedFromCalls(calls) {
  if (!calls.length) return { callCount: 0, lastContactedAt: null, nextFollowUpAt: null };
  const sorted = [...calls].sort((a, b) => a.calledAt - b.calledAt);
  const last = sorted[sorted.length - 1];
  return {
    callCount: sorted.length,
    lastContactedAt: last.calledAt,
    nextFollowUpAt: last.followUpAt || null,
  };
}

function buildCalls(spec) {
  // A few calls are dated today, so the dashboard's "Calls today" tile is not
  // a zero. Today's times are pulled back to just-now if the script happens to
  // run before the hour written below: a call logged in the future is the one
  // detail that would make the whole demo look fake.
  const ceiling = new Date(Date.now() - 60000);
  const out = (spec.calls || []).map((c) => {
    let calledAt = ist(c.d, c.hh, c.mm);
    if (calledAt > ceiling) calledAt = new Date(ceiling.getTime());
    let followUpAt = null;
    if (c.followUpIn != null) followUpAt = ist(c.d + c.followUpIn, 10, 0);
    return { calledAt, outcome: c.outcome, notes: c.notes || null, followUpAt };
  });
  // One candidate is deliberately overdue, so the follow-up queue has teeth.
  if (spec.followUpOverdueDays != null && out.length) {
    out[out.length - 1].followUpAt = ist(-spec.followUpOverdueDays, 10, 0);
  }
  return out;
}

function rupees(n) {
  return `₹${Number(n || 0).toLocaleString("en-IN")}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// RUN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  // ── Who the demo is attributed to. Looked up, never hard-coded: an id from
  // another database is an id that silently belongs to nobody here.
  const user =
    (await prisma.user.findFirst({ where: { active: true, role: "owner" }, orderBy: { createdAt: "asc" } })) ||
    (await prisma.user.findFirst({ where: { active: true }, orderBy: { createdAt: "asc" } }));

  if (!user) {
    console.error("");
    console.error("  No user account exists yet, and every demo call, submission and");
    console.error("  placement has to belong to somebody real.");
    console.error("");
    console.error('  Create the owner account first:  npm run seed:owner -- "Name" email@example.com');
    console.error("");
    process.exit(1);
  }

  // Spread the work across the desk if there is a desk, so the reports screen
  // shows more than one name. Falls back to the one account when that is all
  // there is.
  const desk = await prisma.user.findMany({
    where: { active: true },
    orderBy: { createdAt: "asc" },
    take: 4,
    select: { id: true, name: true },
  });
  const recruiters = desk.length ? desk : [user];
  const pick = (i) => recruiters[i % recruiters.length].id;

  const settings = await prisma.setting.findUnique({ where: { id: "singleton" } }).catch(() => null);
  const replacementDays = settings?.replacementDays ?? 90;

  // ── Pre-flight: refuse to touch a demo placement that somebody has invoiced.
  // InvoiceLine.placementId is an optional relation, so deleting the placement
  // would silently null it out and quietly change a real invoice.
  const existingDemoClients = await prisma.client.findMany({
    where: { name: { startsWith: DEMO_CLIENT_PREFIX } },
    select: { id: true, name: true },
  });
  const existingDemoCandidates = await prisma.candidate.findMany({
    where: { phone: { startsWith: DEMO_PHONE_PREFIX } },
    select: { id: true, name: true, phone: true, source: true },
  });

  // Nothing should ever sit in the reserved phone block except our own rows.
  const intruder = existingDemoCandidates.find(
    (c) => c.source !== DEMO_SOURCE && !c.name.startsWith(DEMO_NAME_PREFIX)
  );
  if (intruder) {
    console.error("");
    console.error(`  A candidate already occupies the reserved demo phone block: ${intruder.phone} (${intruder.name}).`);
    console.error("  That number cannot belong to a real person, but this script will not");
    console.error("  overwrite a row it did not create. Check it by hand first.");
    console.error("");
    process.exit(1);
  }

  const existingCandidateIds = existingDemoCandidates.map((c) => c.id);
  if (existingCandidateIds.length) {
    const invoiced = await prisma.invoiceLine.count({
      where: { placement: { candidateId: { in: existingCandidateIds } } },
    });
    if (invoiced > 0) {
      console.error("");
      console.error(`  ${invoiced} invoice line(s) point at a demo placement.`);
      console.error("  Re-seeding would rewrite those placements and damage a real invoice.");
      console.error("  Cancel or delete the invoice first, then run this again.");
      console.error("");
      process.exit(1);
    }
  }

  const summary = {
    clients: 0, requirements: 0, candidates: 0,
    calls: 0, submissions: 0, interviews: 0, placements: 0,
    removedStale: 0,
  };

  // Everything below lands together or not at all. A half-run seeder in a live
  // database is somebody's afternoon.
  await prisma.$transaction(
    async (tx) => {
      // ── 1. Clear the previous run's child rows, scoped strictly to demo
      // candidates. This is what makes a second run produce the same twenty
      // candidates instead of a second set of calls on each of them.
      if (existingCandidateIds.length) {
        // Reminders are generated nightly from this data and hold no foreign
        // key of their own, so they would otherwise survive as pointers to
        // rows that no longer exist. Collect the ids before deleting.
        const [oldPlacements, oldSubmissions, oldInterviews] = await Promise.all([
          tx.placement.findMany({ where: { candidateId: { in: existingCandidateIds } }, select: { id: true } }),
          tx.submission.findMany({ where: { candidateId: { in: existingCandidateIds } }, select: { id: true } }),
          tx.interview.findMany({ where: { candidateId: { in: existingCandidateIds } }, select: { id: true } }),
        ]);
        const refIds = [
          ...existingCandidateIds,
          ...oldPlacements.map((r) => r.id),
          ...oldSubmissions.map((r) => r.id),
          ...oldInterviews.map((r) => r.id),
        ];

        await tx.placement.deleteMany({ where: { candidateId: { in: existingCandidateIds } } });
        await tx.submission.deleteMany({ where: { candidateId: { in: existingCandidateIds } } });
        await tx.interview.deleteMany({ where: { candidateId: { in: existingCandidateIds } } });
        await tx.candidateCall.deleteMany({ where: { candidateId: { in: existingCandidateIds } } });
        await tx.reminder.deleteMany({ where: { refId: { in: refIds } } });

        // A demo candidate from an older version of this file that the story no
        // longer contains.
        const keep = new Set(CANDIDATES.map((c) => demoPhone(c.n)));
        const stale = existingDemoCandidates.filter((c) => !keep.has(c.phone)).map((c) => c.id);
        if (stale.length) {
          const r = await tx.candidate.deleteMany({ where: { id: { in: stale } } });
          summary.removedStale = r.count;
        }
      }

      // ── 2. Clients
      const clientIds = {};
      for (const c of CLIENTS) {
        const { key, ...data } = c;
        const row = await tx.client.upsert({
          where: { name: data.name },
          update: data,
          create: data,
        });
        clientIds[key] = row.id;
        summary.clients += 1;
      }

      // ── 3. Requirements. No unique constraint exists, so (clientId,
      // designation) is the natural key — unique within this file by design.
      const reqs = {};
      for (const r of REQUIREMENTS) {
        const clientId = clientIds[r.client];
        const data = {
          clientId,
          designation: r.designation,
          domain: r.domain,
          processType: r.processType,
          processDetail: r.processDetail,
          location: r.location,
          openings: r.openings,
          expMinMonths: r.expMinMonths,
          expMaxMonths: r.expMaxMonths,
          takeHomeMin: r.takeHomeMin,
          takeHomeMax: r.takeHomeMax,
          shift: r.shift,
          feeType: r.feeType,
          feeBps: r.feeBps,
          feeFlat: r.feeFlat,
          relievingRequired: r.relievingRequired,
          arrearsAllowed: r.arrearsAllowed,
          educationMin: r.educationMin,
          docsRequired: r.docsRequired,
          cabFacility: r.cabFacility,
          notes: DEMO_NOTE,
          createdById: user.id,
          publishOnline: r.publishOnline,
          status: r.status,
          priority: r.priority,
          openedAt: ist(-r.openedDaysAgo, 10, 0),
          closedAt: null,
        };

        const found = await tx.requirement.findFirst({
          where: { clientId, designation: r.designation },
          select: { id: true },
        });
        const row = found
          ? await tx.requirement.update({ where: { id: found.id }, data })
          : await tx.requirement.create({ data });

        reqs[r.key] = { id: row.id, clientId, ...r };
        summary.requirements += 1;
      }

      // ── 4. Candidates, and everything that hangs off them
      let i = 0;
      for (const spec of CANDIDATES) {
        const req = reqs[spec.req];
        const clientRow = CLIENTS.find((c) => c.key === req.client);
        const ownerId = pick(i);
        const phone = demoPhone(spec.n);
        const calls = buildCalls(spec);
        const derived = derivedFromCalls(calls);

        const data = {
          name: `${DEMO_NAME_PREFIX}${spec.name}`,
          phone,
          email: `${slug(spec.name)}@${DEMO_EMAIL_DOMAIN}`,
          altPhone: null,
          designation: spec.designation,
          location: spec.location,
          expMonths: spec.expMonths,
          currentCtc: spec.currentCtc,
          expectedCtc: spec.expectedCtc,
          noticeDays: spec.noticeDays,
          source: DEMO_SOURCE,
          skills: spec.skills,
          hasRelieving: spec.hasRelieving,
          hasArrears: spec.hasArrears,
          education: spec.education,
          stage: spec.stage,
          status: spec.status,
          rating: spec.rating,
          requirementId: req.id,
          ownerId,
          resumeKey: null,
          resumeText: null,
          lastContactedAt: derived.lastContactedAt,
          nextFollowUpAt: derived.nextFollowUpAt,
          callCount: derived.callCount,
          archived: spec.archived === true,
        };

        const cand = await tx.candidate.upsert({
          where: { phone },
          update: data,
          create: data,
        });
        summary.candidates += 1;

        if (calls.length) {
          await tx.candidateCall.createMany({
            data: calls.map((c) => ({
              candidateId: cand.id,
              userId: ownerId,
              calledAt: c.calledAt,
              outcome: c.outcome,
              notes: c.notes,
              followUpAt: c.followUpAt,
            })),
          });
          summary.calls += calls.length;
        }

        if (spec.submission) {
          const s = spec.submission;
          const sentAt = ist(s.d, 17, 0);
          await tx.submission.create({
            data: {
              candidateId: cand.id,
              requirementId: req.id,
              clientId: req.clientId,
              sentById: ownerId,
              sentAt,
              method: s.method,
              toEmail: clientRow.hrEmail,
              subject: `[DEMO] CV — ${spec.name} for ${req.designation}`,
              status: s.status,
              respondedAt: s.respondedIn != null ? ist(s.d + s.respondedIn, 12, 0) : null,
              response: s.response || null,
            },
          });
          summary.submissions += 1;
        }

        if (spec.interview) {
          const v = spec.interview;
          await tx.interview.create({
            data: {
              candidateId: cand.id,
              requirementId: req.id,
              scheduledAt: ist(v.d, v.hh, v.mm),
              mode: v.mode,
              location: v.location || null,
              round: v.round,
              interviewer: v.interviewer,
              attended: v.attended === undefined ? null : v.attended,
              outcome: v.outcome || null,
              feedback: v.feedback || null,
              createdById: ownerId,
            },
          });
          summary.interviews += 1;
        }

        if (spec.placement) {
          const p = spec.placement;
          // Terms frozen at selection, exactly as POST /api/placements does:
          // the requirement's own rate first, the client's house rate second.
          const fee = resolveFee(req, clientRow);
          const revenue = computeRevenue({ ...fee, ctcOfferedAnnual: p.ctcOfferedAnnual });
          if (fee.feeType == null || revenue == null) {
            throw new Error(
              `Demo requirement "${req.designation}" has no commercials — the demo placement would bill nothing. Fix the fee in scripts/seed-demo.mjs.`
            );
          }

          const selectedOn = notBefore(ist(-p.selectedDaysAgo, 12, 0), MONTH_START);
          let joinedOn = p.joinedDaysAgo == null ? null : ist(-p.joinedDaysAgo, 10, 0);
          if (joinedOn && joinedOn < selectedOn) joinedOn = new Date(selectedOn.getTime());

          await tx.placement.create({
            data: {
              candidateId: cand.id,
              requirementId: req.id,
              clientId: req.clientId,
              recruiterId: ownerId,
              selectedOn,
              joinedOn,
              employeeId: p.employeeId || null,
              ctcOfferedAnnual: p.ctcOfferedAnnual,
              takeHomeMonthly: p.takeHomeMonthly,
              designation: req.designation,
              location: req.location,
              feeType: fee.feeType,
              feeBps: fee.feeBps,
              feeFlat: fee.feeFlat,
              revenue,
              invoiceStatus: p.invoiceStatus,
              // A string on the placement, not a row in Invoice: the real
              // invoice numbers are gapless within a financial year and a demo
              // must not consume one.
              invoiceNo: p.invoiceNo || null,
              invoicedOn: p.invoicedDaysAgo != null ? ist(-p.invoicedDaysAgo, 11, 0) : null,
              paidOn: p.paidDaysAgo != null ? ist(-p.paidDaysAgo, 11, 0) : null,
              replacementUntil: joinedOn
                ? new Date(joinedOn.getTime() + replacementDays * 86400000)
                : null,
              droppedOn: null,
              dropReason: null,
            },
          });
          summary.placements += 1;
        }

        i += 1;
      }
    },
    { maxWait: 15000, timeout: 120000 }
  );

  // ── What just happened
  const byStage = CANDIDATES.reduce((m, c) => ((m[c.stage] = (m[c.stage] || 0) + 1), m), {});
  const money = CANDIDATES.filter((c) => c.placement);

  console.log("");
  console.log("  Demo data seeded");
  console.log("  ────────────────");
  console.log(`  Attributed to   ${user.name} <${user.email}>`);
  if (recruiters.length > 1) console.log(`  Spread across   ${recruiters.map((r) => r.name).join(", ")}`);
  console.log("");
  console.log(`  Clients         ${summary.clients}   (names begin "${DEMO_CLIENT_PREFIX}")`);
  console.log(`  Requirements    ${summary.requirements}`);
  console.log(`  Candidates      ${summary.candidates}  (phones ${demoPhone(1)}–${demoPhone(CANDIDATES.length)})`);
  console.log(`  Calls logged    ${summary.calls}`);
  console.log(`  Submissions     ${summary.submissions}`);
  console.log(`  Interviews      ${summary.interviews}`);
  console.log(`  Placements      ${summary.placements}`);
  if (summary.removedStale) console.log(`  Stale removed   ${summary.removedStale}`);
  console.log("");
  console.log("  By stage        " + Object.entries(byStage).map(([k, v]) => `${k} ${v}`).join(" · "));
  console.log("");
  for (const c of money) {
    const req = REQUIREMENTS.find((r) => r.key === c.req);
    const cl = CLIENTS.find((x) => x.key === req.client);
    const fee = resolveFee(req, cl);
    console.log(
      `  ${c.placement.joinedDaysAgo == null ? "selected" : "joined  "}  ${DEMO_NAME_PREFIX}${c.name} — ${req.designation} — fee ${rupees(
        computeRevenue({ ...fee, ctcOfferedAnnual: c.placement.ctcOfferedAnnual })
      )}${c.placement.joinedDaysAgo == null ? "  (not billable until they join)" : ""}`
    );
  }
  console.log("");
  console.log("  Everything above is marked DEMO and can be removed with:");
  console.log("      node scripts/unseed-demo.mjs          (shows what it would delete)");
  console.log("      node scripts/unseed-demo.mjs --yes    (actually deletes it)");
  console.log("");
}

try {
  await main();
} catch (e) {
  console.error("");
  console.error("  Seeding failed — nothing was written.");
  console.error(`  ${e?.message || e}`);
  console.error("");
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
