// lib/callScript.js — what to say on this call, to this person, about this role.
//
// Built deterministically from the requirement and the candidate. No AI needed:
// this always works, on every call, with no key configured and no network. AI
// can rewrite it afterwards (see lib/ai.js), but the fallback is not a
// degraded version — it is the version, and the one a recruiter gets at 9am
// when an API is down.
//
// ON PERSUASION. Ram asked for "how to lure the candidate". What is built here
// is the honest version of that, and it is also the version that works: every
// line points at something true about the role — the actual pay, the actual
// shift, the actual growth path — and every objection response is an answer,
// not a deflection. A candidate talked into a job they were misled about quits
// inside the replacement window, the fee is clawed back, and the client stops
// calling. Accuracy is not the ethical constraint on this script; it is the
// commercial one.

function money(n) {
  if (n == null) return null;
  return n >= 1000 ? `₹${Math.round(n / 1000)},000` : `₹${n}`;
}

function payPhrase(r) {
  const lo = money(r.takeHomeMin), hi = money(r.takeHomeMax);
  if (lo && hi) return lo === hi ? `${lo} in hand` : `${lo} to ${hi} in hand`;
  if (hi) return `up to ${hi} in hand`;
  if (lo) return `from ${lo} in hand`;
  return null;
}

function years(m) {
  if (m == null) return null;
  if (m === 0) return "fresher";
  if (m < 12) return `${m} month${m === 1 ? "" : "s"}`;
  const y = Math.round(m / 12);
  return `${y} year${y === 1 ? "" : "s"}`;
}

// ── the opening ─────────────────────────────────────────────────────────────

export function opener({ candidate = {}, requirement = {}, recruiter = {}, company = "Blue Chip HR" }) {
  const name = candidate.name?.split(" ")[0] || "there";
  const me = recruiter.name?.split(" ")[0] || "calling";
  const role = requirement.designation || "an opening";
  const loc = requirement.location ? ` in ${requirement.location}` : "";

  return [
    `"Hi ${name}, this is ${me} from ${company}. Do you have two minutes?"`,
    `"I'm calling about a ${role} position${loc}. Are you open to a change right now?"`,
  ];
}

// ── the pitch, strongest true thing first ───────────────────────────────────

/**
 * Ordered by what actually moves this particular candidate, not by what sounds
 * best in general. A candidate earning ₹18k hears the money first; one already
 * on ₹28k hears the growth. Leading with the wrong one wastes the only thirty
 * seconds of attention the call gets.
 */
export function pitch({ candidate = {}, requirement = {} }) {
  const points = [];
  const pay = payPhrase(requirement);

  const raise =
    candidate.currentCtc && requirement.takeHomeMax
      ? Math.round(((requirement.takeHomeMax - candidate.currentCtc) / candidate.currentCtc) * 100)
      : null;

  if (pay && raise != null && raise >= 15) {
    points.push({
      key: "money",
      weight: 100 + raise,
      line: `Pay is ${pay} — that's around ${raise}% above what you're on now.`,
    });
  } else if (pay) {
    points.push({ key: "money", weight: 60, line: `Pay is ${pay}.` });
  }

  if (requirement.clientName) {
    points.push({
      key: "client",
      weight: 55,
      line: `It's with ${requirement.clientName}${requirement.location ? `, at their ${requirement.location} office` : ""}.`,
    });
  }
  if (requirement.cabFacility && requirement.cabFacility !== "none") {
    points.push({
      key: "cab",
      weight: requirement.shift && /night|us/i.test(requirement.shift) ? 80 : 45,
      line: `Cab is provided ${requirement.cabFacility === "twoway" ? "both ways" : "one way"} — no travel cost or safety worry.`,
    });
  }
  if (requirement.expMinMonths === 0) {
    points.push({ key: "fresher", weight: 70, line: `They take freshers, so no experience barrier.` });
  }
  if (requirement.openings > 1) {
    points.push({
      key: "volume",
      weight: 30,
      line: `There are ${requirement.openings} openings, so they're hiring in numbers and moving fast.`,
    });
  }
  if (requirement.domain) {
    points.push({ key: "domain", weight: 35, line: `The work is ${requirement.domain}.` });
  }

  return points.sort((a, b) => b.weight - a.weight).map((p) => p.line);
}

// ── career growth: what this job leads to ───────────────────────────────────

// The real ladder in Indian healthcare BPO / AR calling. These are the titles
// people actually get promoted into, with the timelines the industry actually
// runs on — not aspirational nonsense a candidate will discover is untrue.
const LADDERS = [
  {
    match: /ar call|ar-call|accounts receivable|rcm|denial|medical billing/i,
    steps: [
      { title: "AR Caller", months: 0, note: "Where you'd start" },
      { title: "Senior AR Caller", months: 12, note: "Usually after a year of clean quality scores" },
      { title: "Subject Matter Expert / QA", months: 24, note: "You start training and auditing others" },
      { title: "Team Lead", months: 36, note: "A team of 12–15, and your first people-management role" },
      { title: "Assistant Manager / Process Lead", months: 60, note: "Client-facing, owning process metrics" },
    ],
    also: "RCM experience travels — denial management, credentialing, payment posting and coding are all open to you once you have two years.",
  },
  {
    match: /voice|customer (support|service)|bpo|call cent/i,
    steps: [
      { title: "Customer Support Executive", months: 0, note: "Where you'd start" },
      { title: "Senior Executive", months: 12, note: "Harder queues, better incentives" },
      { title: "Quality Analyst / SME", months: 24, note: "Auditing calls rather than taking them" },
      { title: "Team Lead", months: 36, note: "First people-management role" },
      { title: "Operations Manager", months: 72, note: "Multiple teams, client ownership" },
    ],
    also: "Voice experience is the usual route into quality, training and workforce management.",
  },
  {
    match: /recruit|talent|hr|sourcing/i,
    steps: [
      { title: "Recruiter", months: 0, note: "Where you'd start" },
      { title: "Senior Recruiter", months: 18, note: "Own client relationships, not just requirements" },
      { title: "Team Lead / Account Manager", months: 36, note: "A desk and the people on it" },
      { title: "Delivery Manager", months: 60, note: "Multiple accounts and their numbers" },
    ],
    also: "Recruitment experience moves easily between agency and in-house HR.",
  },
];

const GENERIC_LADDER = {
  steps: [
    { title: "Executive", months: 0, note: "Where you'd start" },
    { title: "Senior Executive", months: 12, note: "With consistent performance" },
    { title: "Team Lead", months: 36, note: "First people-management role" },
    { title: "Manager", months: 72, note: "Owning a function" },
  ],
  also: null,
};

/**
 * What this role leads to, for this candidate, starting from their experience.
 *
 * Anchored on the candidate's existing experience rather than always starting
 * at zero: telling someone with three years that they could be a Team Lead in
 * three more is both wrong and insulting, and they will know it.
 */
export function careerPath({ candidate = {}, requirement = {} } = {}) {
  const text = `${requirement.designation || ""} ${requirement.domain || ""} ${requirement.processDetail || ""}`;
  const ladder = LADDERS.find((l) => l.match.test(text)) || GENERIC_LADDER;
  const have = candidate.expMonths || 0;

  const steps = ladder.steps.map((s) => {
    const fromNow = Math.max(0, s.months - have);
    return {
      title: s.title,
      note: s.note,
      inMonths: fromNow,
      when:
        fromNow === 0
          ? have >= s.months && s.months > 0
            ? "You'd likely qualify now"
            : "Starting point"
          : fromNow < 12
          ? `about ${fromNow} months away`
          : `about ${Math.round(fromNow / 12)} year${Math.round(fromNow / 12) === 1 ? "" : "s"} away`,
    };
  });

  return { steps, note: ladder.also };
}

// ── objections ──────────────────────────────────────────────────────────────

/**
 * Answers, not deflections. Each one concedes what is true before it makes its
 * case, because a candidate who hears their concern dismissed stops listening —
 * and because on half of these the honest answer is that the role is wrong for
 * them, which is worth finding out in minute two rather than week three.
 */
export function objections({ candidate = {}, requirement = {} } = {}) {
  const out = [];
  const pay = payPhrase(requirement);

  out.push({
    says: "The salary is too low",
    answer: candidate.expectedCtc && requirement.takeHomeMax && candidate.expectedCtc > requirement.takeHomeMax
      ? `"You're asking ${money(candidate.expectedCtc)} and the band tops out at ${money(requirement.takeHomeMax)} — I won't pretend otherwise. What I can do is put your profile in front of them and let them decide, and tell you the moment something in your range opens up. Shall I do both?"`
      : `"The band is ${pay || "set by the client"}. Where they land inside it depends on your last drawn and how the interview goes — so it's worth getting you in front of them."`,
  });

  out.push({
    says: "I'll think about it / call me later",
    answer: `"Of course. Can I book a specific time rather than leave it open? If I call back Thursday at 11 and you've decided against it, just tell me then and I'll stop."`,
  });

  out.push({
    says: "The location is too far",
    answer: requirement.cabFacility && requirement.cabFacility !== "none"
      ? `"Cab is provided ${requirement.cabFacility === "twoway" ? "both ways" : "one way"}, so the commute costs you time but not money. Where are you travelling from?"`
      : `"How long would the commute be? If it's over an hour I'd rather find you something closer than have you leave in three months."`,
  });

  if (requirement.shift && /night|us|rotational/i.test(requirement.shift)) {
    out.push({
      says: "I don't want night shift",
      answer: `"Then this one isn't for you, and that's fine — night shift doesn't suit everyone and it's better to say so now. Shall I keep you on the list for day-shift roles?"`,
    });
  }

  if (requirement.relievingRequired) {
    out.push({
      says: "I don't have a relieving letter",
      answer: `"This client won't move without one — I'd be wasting your time to say otherwise. Some clients are flexible on it; let me look for those instead. Do you have your last three payslips and offer letter?"`,
    });
  }

  out.push({
    says: "I've just joined somewhere",
    answer: `"Understood — moving too soon hurts your own CV. Can I check back with you in six months? I'll make a note and you won't hear from me before then."`,
  });

  out.push({
    says: "Send me the details on WhatsApp",
    answer: `"Sending it now. One thing first so I send the right one — what notice period are you on?"`,
  });

  return out;
}

// ── the micro-checklist ─────────────────────────────────────────────────────

/**
 * What must come out of THIS call, in the order it should be asked, with the
 * already-answered items marked done.
 *
 * Ordered to protect the recruiter's time: the questions that can kill the
 * candidacy come first. There is no point establishing rapport for six minutes
 * and then discovering in minute seven that they have no relieving letter for a
 * client that demands one.
 */
export function checklist({ candidate = {}, requirement = {} } = {}) {
  const items = [];
  const add = (key, ask, why, done, critical = false) =>
    items.push({ key, ask, why, done: !!done, critical });

  if (requirement.relievingRequired) {
    add("relieving", "Do you have a relieving letter from your last employer?",
      "This client will not proceed without one.", candidate.hasRelieving != null, true);
  }
  if (requirement.arrearsAllowed === false) {
    add("arrears", "Any arrears or backlogs in your degree?",
      "This client does not accept arrears.", candidate.hasArrears != null, true);
  }
  add("experience", "How much total experience do you have?",
    "Decides whether they clear the client's bar at all.", candidate.expMonths != null,
    requirement.expMinMonths != null);
  add("current", "What are you drawing now, in hand?",
    "Without it you cannot judge whether the offer is a raise.", candidate.currentCtc != null);
  add("expected", "And what are you expecting?",
    "Finds the mismatch before an interview slot is spent on it.", candidate.expectedCtc != null);
  add("notice", "What's your notice period?",
    "Clients withdraw over long notice more often than over salary.", candidate.noticeDays != null);
  if (requirement.educationMin) {
    add("education", "What's your qualification?",
      `Client asks for: ${requirement.educationMin}`, !!candidate.education);
  }
  add("location", "Where are you based?",
    "A long commute is the most common three-month resignation.", !!candidate.location);
  add("interest", "Shall I line you up for an interview?",
    "Ask for the close. Most calls end without anyone asking.", false);

  const remaining = items.filter((i) => !i.done);
  return {
    items,
    remaining: remaining.length,
    // Where to start talking, right now.
    next: remaining[0] || null,
  };
}

/** Everything the call screen needs, in one call. */
export function buildScript(input) {
  return {
    opener: opener(input),
    pitch: pitch(input),
    checklist: checklist(input),
    objections: objections(input),
    career: careerPath(input),
    source: "built-in",
  };
}

export default buildScript;
