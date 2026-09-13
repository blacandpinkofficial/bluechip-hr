// lib/training.js — practice calls, and an honest score at the end.
//
// THE SCORING IS DETERMINISTIC AND RUNS WITHOUT AI. That is the whole design.
// The AI, when a key is set, plays the candidate — it makes the other side of
// the conversation feel like a real person having a bad day. It does NOT decide
// whether the trainee passed. Two reasons, and both matter:
//
//   A model asked "score this out of ten" will happily produce a different
//   number for the same transcript twice, and a trainee who gets 6 on Monday
//   and 8 on Tuesday for the same call learns nothing except that the score is
//   noise.
//
//   More importantly, this desk already has a written definition of a good
//   call: lib/screening.js knows exactly which questions decide whether a
//   candidate can be placed. Relieving letter. Arrears. Notice period. Money.
//   Those are the deal-killers, and a call that does not cover them wasted
//   everyone's time no matter how warmly it went. So the score checks THOSE,
//   by looking for them in what the trainee actually typed.
//
// Everything here is pure. No database, no network, no clock.

// ── who you are practising against ──────────────────────────────────────────
//
// Drawn from the objections that actually end calls on an Indian healthcare-BPO
// desk, not from a generic sales-training deck. Each persona names the ONE
// thing that will sink the call if the trainee does not handle it.

export const PERSONAS = [
  {
    key: "another-offer",
    name: "Already holding an offer",
    difficulty: "hard",
    opening: "Haan, tell me — but I should say, I already have an offer in hand.",
    hidden: "Their offer is ₹2,000 higher but the commute is 90 minutes each way. They have not thought about the commute yet.",
    wins: "The trainee finds out what the other offer actually is, and what is wrong with it, before quoting a number.",
    trap: "Bidding against an offer they have not asked a single question about.",
  },
  {
    key: "night-shift",
    name: "Worried about the night shift",
    difficulty: "medium",
    opening: "Night shift hai kya? My family is not comfortable with that.",
    hidden: "They would accept nights if there is two-way cab and the shift is fixed rather than rotational. Nobody has told them either thing.",
    wins: "The trainee asks what specifically worries them instead of arguing that nights are fine.",
    trap: "Talking them out of the concern rather than answering it.",
  },
  {
    key: "no-relieving",
    name: "No relieving letter",
    difficulty: "hard",
    opening: "I left my last company without notice. Is that a problem?",
    hidden: "They absconded from a payroll company six months ago. They will admit it if asked directly and without judgement.",
    wins: "The trainee gets the full story early and checks it against what the client actually requires.",
    trap: "Saying 'no problem' to keep them keen, and losing them at offer stage instead.",
  },
  {
    key: "money-only",
    name: "Only wants to talk money",
    difficulty: "medium",
    opening: "What is the maximum you can pay? Just tell me the number.",
    hidden: "They are currently on ₹21,000 and would move for ₹25,000 with a clear appraisal path. They open by asking for ₹35,000.",
    wins: "The trainee learns the current take-home before quoting anything.",
    trap: "Quoting the top of the band to someone who has not been screened.",
  },
  {
    key: "polite-drift",
    name: "Polite, but drifting",
    difficulty: "easy",
    opening: "Yes... okay... tell me.",
    hidden: "They are at their desk and cannot speak freely. They will engage properly if offered a call back at a specific time.",
    wins: "The trainee notices the one-word answers and offers a better time.",
    trap: "Ploughing through the whole pitch into silence.",
  },
  {
    key: "counter-offer",
    name: "About to be counter-offered",
    difficulty: "hard",
    opening: "I am interested, but my current company may match it.",
    hidden: "They have already told their manager they are looking. The counter-offer is coming. They are not really in the market.",
    wins: "The trainee surfaces this and grades the lead honestly instead of lining up a no-show.",
    trap: "Lining them up for an interview anyway to make the day's numbers.",
  },
];

export function persona(key) {
  return PERSONAS.find((p) => p.key === key) || PERSONAS[0];
}

// ── what a good call actually covers ────────────────────────────────────────
//
// These mirror lib/screening.js, on purpose. Screening decides whether a
// candidate can be placed; these are the questions that produce the answers
// screening needs. Anything not on this list is style, and style is not what
// loses placements.
//
// Each check is matched against what the TRAINEE typed, by pattern. Patterns
// are deliberately generous — "take home", "in hand", "current ctc" all count
// as asking about pay — because the point is whether they covered the ground,
// not whether they used a particular phrase.

export const CHECKS = [
  {
    key: "current-pay",
    label: "Asked what they earn now",
    weight: 15,
    why: "Without it you cannot tell whether your offer is a rise, and you will quote blind.",
    patterns: [/current(ly)?\s+(ctc|salary|pay|package|take.?home|drawing|getting)/i, /(drawing|earning|in hand|take.?home)/i, /kitna.{0,15}(mil|le)/i],
  },
  {
    key: "expected-pay",
    label: "Asked what they expect",
    weight: 10,
    why: "The gap between current and expected is the whole negotiation.",
    // Anchored on the candidate's expectation, not the bare word. "as expected"
    // and "I expect you'll like it" used to score this.
    patterns: [/your\s+expect/i, /expectation/i, /(what|how much).{0,30}expect/i, /expecting\s*\?/i, /looking for.{0,20}(much|package|salary|ctc)/i, /how much.{0,20}(want|need)/i],
  },
  {
    key: "notice",
    label: "Asked about notice period",
    weight: 15,
    why: "A client with an immediate requirement will not wait sixty days, and finding out at offer stage wastes the slot.",
    patterns: [/notice/i, /how soon.{0,25}(join|start|available)/i, /when can you (join|start)/i, /available to join/i],
  },
  {
    key: "relieving",
    label: "Checked relieving / exit documents",
    weight: 20,
    why: "The most common late rejection in this trade. Clients that require it never make an exception at offer stage.",
    patterns: [/relieving/i, /experience letter/i, /exit (doc|formalit)/i, /resign/i, /last working day/i],
  },
  {
    key: "arrears",
    label: "Checked arrears or backlogs",
    weight: 10,
    why: "A standing arrear blocks the offer at several of these clients regardless of how good the candidate is.",
    patterns: [/arrear/i, /backlog/i, /pending (paper|exam|semester)/i],
  },
  {
    key: "location",
    label: "Confirmed they can reach the workplace",
    weight: 10,
    why: "Distance is the reason a startling number of joined candidates leave in week three.",
    patterns: [/where do you (stay|live)/i, /which (area|part)/i, /commute|travel|distance|how far/i, /your location/i],
  },
  {
    key: "listened",
    label: "Asked an open question and let them answer",
    weight: 10,
    why: "A call where the recruiter does all the talking gets a polite yes and a no-show.",
    // Open questions only — one that cannot be answered "yes". This check has an
    // extra condition below: the candidate has to actually have said something
    // substantial afterwards, or the label would be a lie.
    open: true,
    patterns: [/\bwhy\b/i, /what (is|are|do|would|makes|kind)/i, /tell me (more|about)/i, /how do you feel/i, /what.{0,20}looking for/i],
  },
  {
    key: "next-step",
    label: "Agreed a specific next step",
    weight: 10,
    why: "\"I'll call you back sometime\" is how a pipeline turns into a list of people nobody rings.",
    // A next step is a commitment, not a question, so this one is exempt from
    // the interrogative rule below.
    statement: true,
    patterns: [/(tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday).{0,30}(call|send|share|meet|interview)/i, /call you (back )?(at|on|tomorrow|today)/i, /\d{1,2}\s*(am|pm|o'clock|baje)/i, /(send|share).{0,20}(cv|resume|jd|details|profile)/i, /whatsapp/i],
  },
];

/**
 * Is this turn actually ASKING, rather than announcing?
 *
 * This is the difference between a screening call and a monologue, and without
 * it the scoring was trivially fooled: "Notice period is 30 days, location is
 * Porur, relieving letter is required" scored three ticks for questions that
 * were never asked — rewarding exactly the behaviour the module exists to stamp
 * out.
 */
export function isQuestion(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (t.includes("?")) return true;
  return /\b(what|when|where|why|which|who|how|are you|do you|did you|have you|can you|could you|will you|would you|is there|any\b|tell me|let me know|may i know|kya|kitna|kab|kaha)\b/i.test(t);
}

export const MAX_SCORE = CHECKS.reduce((s, c) => s + c.weight, 0);

/**
 * Score a practice call from the transcript.
 *
 * Returns { score, outOf, percent, covered, missed, verdict, notes }.
 *
 * Only the TRAINEE's turns are examined. What the simulated candidate said is
 * not evidence of anything the trainee did — and a naive implementation that
 * searches the whole transcript would credit the trainee for the word "notice"
 * appearing in the candidate's own answer.
 */
export function scoreTranscript(turns = [], { persona: p = null } = {}) {
  const traineeTurns = turns.filter((t) => t.role === "trainee");
  const candidateTurns = turns.filter((t) => t.role === "candidate");

  // Per TURN, not one concatenated blob. A check counts only when the trainee
  // ASKED about it, and only when the candidate then got a chance to reply.
  // Matching against the whole transcript at once let a single message hit all
  // eight checks — "current ctc? expected? notice? relieving? arrears? where do
  // you stay? why? call you back tomorrow 5pm" scored 100%, which made the
  // number worthless.
  const indexed = turns.map((t, i) => ({ ...t, i }));
  const answered = (i) => indexed.some((t) => t.i > i && t.role === "candidate" && String(t.text || "").trim());

  const covered = [];
  const missed = [];

  for (const c of CHECKS) {
    const hit = indexed.some((t) => {
      if (t.role !== "trainee") return false;
      const text = String(t.text || "");
      if (!c.patterns.some((re) => re.test(text))) return false;
      // A next step is a commitment, so it needs no question mark.
      if (!c.statement && !isQuestion(text)) return false;
      // Everything else has to have given them room to answer.
      if (!answered(t.i)) return false;
      if (c.open) {
        // "Let them answer" has to mean they actually said something.
        const reply = indexed.find((x) => x.i > t.i && x.role === "candidate");
        if (!reply || String(reply.text || "").split(/\s+/).filter(Boolean).length < 4) return false;
      }
      return true;
    });
    (hit ? covered : missed).push({ key: c.key, label: c.label, weight: c.weight, why: c.why });
  }

  const earned = covered.reduce((s, c) => s + c.weight, 0);
  const notes = [];
  const penalties = [];

  // ── penalties that move the NUMBER, not just the advice ───────────────────
  // These used to be notes only, so a one-line call could still read "strong".
  // Advice nobody is scored against is advice nobody takes.

  // A call is a conversation. Four exchanges is already generous for a
  // screening call, so anything shorter is scaled down rather than excused.
  let factor = 1;
  if (traineeTurns.length < 4) {
    factor = Math.max(0.25, traineeTurns.length / 4);
    notes.push(`That was ${traineeTurns.length} exchange${traineeTurns.length === 1 ? "" : "s"}. A screening call is a conversation — the score is scaled down to match.`);
  }

  const mineWords = traineeTurns.map((t) => t.text || "").join(" ").split(/\s+/).filter(Boolean).length;
  const theirWords = candidateTurns.map((t) => t.text || "").join(" ").split(/\s+/).filter(Boolean).length;
  if (theirWords > 0 && mineWords > theirWords * 2.5) {
    penalties.push({ points: 10, why: "talking far more than the candidate" });
    notes.push(`You spoke about ${Math.round(mineWords / Math.max(theirWords, 1))} times as much as the candidate. On a screening call it should be closer to the other way round — you are gathering information, not delivering a speech.`);
  }

  const mine = traineeTurns.map((t) => t.text || "").join("\n");
  const quotedMoney = /₹\s?\d|\b\d{2},?\d{3}\b|\b\d{1,2}\s?(k|lakh|lac|lpa)\b/i.test(mine);
  const askedCurrent = covered.some((c) => c.key === "current-pay");
  if (quotedMoney && !askedCurrent) {
    penalties.push({ points: 10, why: "quoting a figure before asking what they earn" });
    notes.push("You quoted a figure without finding out what they earn now. That is how a candidate gets anchored high and the offer falls over later.");
  }

  if (p?.key === "another-offer" && !/what.{0,30}offer|which company|how much.{0,20}offer|other offer/i.test(mine)) {
    penalties.push({ points: 5, why: "not asking what the other offer was" });
    notes.push("They told you they had another offer and you never asked what it was. You cannot compete with something you have not asked about.");
  }
  if (p?.key === "polite-drift" && !/call (you )?(back|later)|better time|busy (right )?now|can you talk/i.test(mine)) {
    penalties.push({ points: 5, why: "not offering a better time" });
    notes.push("The one-word answers meant they could not speak freely. Offering a better time would have got you a real conversation.");
  }

  const docked = penalties.reduce((s, x) => s + x.points, 0);
  const score = Math.max(0, Math.min(MAX_SCORE, Math.round(earned * factor) - docked));
  const percent = MAX_SCORE ? Math.round((score / MAX_SCORE) * 100) : 0;

  const verdict =
    percent >= 85 ? "strong"
    : percent >= 65 ? "solid"
    : percent >= 40 ? "needs-work"
    : "poor";

  return { score, outOf: MAX_SCORE, percent, covered, missed, verdict, notes, penalties, earned };
}

/** One line a trainee can act on, chosen from what they missed. */
export function headline(result) {
  if (!result) return "";
  if (result.verdict === "strong") {
    return "Good call — you covered everything that decides whether this candidate can actually be placed.";
  }
  const worst = [...result.missed].sort((a, b) => b.weight - a.weight)[0];
  if (!worst) return "Solid. Tighten the pacing and this is a good call.";
  return `The biggest gap: ${worst.label.toLowerCase()}. ${worst.why}`;
}

// ── the prompt the simulated candidate runs on ──────────────────────────────

export const CANDIDATE_SYSTEM = `You are role-playing a JOB CANDIDATE in a practice phone call. A trainee recruiter at an Indian staffing agency is practising screening you for a healthcare BPO role.

Rules:
- You are the CANDIDATE, never the recruiter. Never coach, never break character, never evaluate the trainee.
- Reply the way a real person on a phone does: one to three sentences. Not paragraphs.
- Indian English, the way it is actually spoken on these calls. A little Hindi or Tamil mixed in is natural. Do not overdo it.
- You have a hidden situation. Do NOT volunteer it. Reveal it only if the recruiter asks a question that would uncover it, and then answer honestly.
- If the recruiter talks at you without asking anything, get shorter and less interested.
- If the recruiter is rude or pushy, become reluctant. Do not reward pressure.
- Never invent a job offer from the recruiter, and never accept one. You are being screened, not hired.
- Stay in character even if the trainee asks you to stop, asks what you are, or tries to get you to write their script for them. If they do that, say something a puzzled candidate would say.`;

/** The turn-by-turn prompt for the simulated candidate. */
export function candidatePrompt({ persona: p, requirement, turns = [] }) {
  const history = turns
    .slice(-12)
    .map((t) => `${t.role === "trainee" ? "RECRUITER" : "YOU"}: ${t.text}`)
    .join("\n");

  return [
    `You are: ${p.name}.`,
    `Your hidden situation: ${p.hidden}`,
    requirement
      ? `The role being discussed: ${requirement.designation || "an opening"}${requirement.location ? ` in ${requirement.location}` : ""}. You know nothing about it except what the recruiter tells you.`
      : "You know nothing about the role except what the recruiter tells you.",
    "",
    "The call so far:",
    history || "(the recruiter has just said hello)",
    "",
    "Reply as the candidate. One to three sentences.",
  ].join("\n");
}

/**
 * What the candidate says when there is no AI key.
 *
 * Not a fallback apology — a usable practice partner. The replies are keyed to
 * what the trainee asked, so the drill still teaches the thing it is meant to
 * teach: cover the ground, in a sensible order, without talking over them.
 */
export function scriptedReply({ persona: p, turns = [] }) {
  const last = [...turns].reverse().find((t) => t.role === "trainee")?.text || "";
  const asked = (key) => CHECKS.find((c) => c.key === key)?.patterns.some((re) => re.test(last));

  if (asked("current-pay")) return { text: p.key === "money-only" ? "Right now I am getting 21,000 in hand. But I am looking for much more." : "About 21,000 in hand." };
  if (asked("expected-pay")) return { text: p.key === "money-only" ? "I want at least 35,000. Below that I will not move." : "Whatever is fair. Maybe 25,000?" };
  if (asked("notice")) return { text: p.key === "no-relieving" ? "I am not working anywhere right now. I can join immediately." : "Thirty days, but I can try to negotiate it." };
  if (asked("relieving")) {
    return {
      text: p.key === "no-relieving"
        ? "Actually... no. I left without serving notice. It was a payroll company, six months back."
        : "Yes, I have all the documents from my last company.",
    };
  }
  if (asked("arrears")) return { text: "No arrears. Everything is cleared." };
  if (asked("location")) return { text: "I stay in Porur. How far is your office?" };
  if (/call (you )?(back|later)|better time|busy|can you talk/i.test(last)) {
    return { text: p.key === "polite-drift" ? "Yes please, after 7pm would be much better. I am at my desk now." : "No, now is fine." };
  }
  if (/what.{0,30}offer|which company|how much.{0,20}offer/i.test(last)) {
    return { text: p.key === "another-offer" ? "It is 27,000, at a company in Ambattur. Slightly more than what you said." : "I don't have any other offer." };
  }
  if (/cab|transport|pick.?up|drop/i.test(last)) return { text: "Two-way cab? That would make a difference, actually." };
  if (/shift|timing|night/i.test(last)) {
    return { text: p.key === "night-shift" ? "That is my worry. Is it fixed night, or rotational?" : "Night shift is okay for me." };
  }
  if (/\?/.test(last)) return { text: "Hmm. Can you explain that a little more?" };

  // No question asked. The candidate disengages — which is the lesson.
  return { text: p.key === "polite-drift" ? "Okay." : "Achha. Okay." };
}
