// lib/screening.js — does this candidate actually qualify for this opening?
//
// This is the piece the spreadsheet could not do, and the reason candidates get
// rejected in week two for something knowable in minute one. RELIEVING,
// ARREARS, EDUCATION, EXPERIENCE and take-home expectation all sit in the job
// description sheet as prose in a cell. Nobody filters on prose. So a recruiter
// spends four calls, a line-up and an interview slot on someone the client was
// always going to refuse.
//
// Here those become a comparison, run on the call screen while the candidate is
// still on the phone.
//
// Two severities, and the distinction matters:
//
//   blocker  the client will refuse. Do not line this person up for THIS role.
//   warning  worth raising on the call — it may be negotiable, or it may just
//            be a gap in what we know.
//
// Unknown is never a blocker. A missing answer means "ask", not "reject" — a
// screen that rejects on absent data teaches recruiters to type anything into
// the field to make the warning go away.

const UNKNOWN = "Not asked yet";

/** Years-and-months, for a message a person reads aloud. "18" → "1 yr 6 mo" */
export function describeMonths(m) {
  if (m == null) return null;
  if (m === 0) return "fresher";
  if (m < 12) return `${m} mo`;
  const y = Math.floor(m / 12);
  const r = m % 12;
  return r ? `${y} yr ${r} mo` : `${y} yr`;
}

/**
 * screen(candidate, requirement) → { blockers, warnings, unknowns, verdict }
 *
 * verdict is the single word the screen shows, worst-first:
 *
 *   blocked  the client will refuse; don't line them up for this role
 *   ask      something needed is not known yet
 *   check    known, and something is off — raise it on the call
 *   clear    nothing against them
 *
 * "check" exists because a candidate with two warnings reporting "clear" is a
 * lie the recruiter acts on. Every entry carries { field, label, detail } so
 * the UI can group them and show what to ask next.
 */
export function screen(candidate = {}, requirement = {}) {
  const blockers = [];
  const warnings = [];
  const unknowns = [];

  const add = (list, field, label, detail) => list.push({ field, label, detail });

  // ── Relieving letter ──────────────────────────────────────────────────────
  // The most common late rejection in this trade. A client that requires a
  // relieving letter will not make an exception at offer stage.
  if (requirement.relievingRequired) {
    if (candidate.hasRelieving === false) {
      add(blockers, "relieving", "No relieving letter",
        "This client requires one. Do not line up for this role.");
    } else if (candidate.hasRelieving == null) {
      add(unknowns, "relieving", "Relieving letter?", UNKNOWN);
    }
  }

  // ── Arrears / backlogs ────────────────────────────────────────────────────
  // Note the inversion: the sheet column names the problem ("No arrears"),
  // not the permission. arrearsAllowed === false is the strict case.
  if (requirement.arrearsAllowed === false) {
    if (candidate.hasArrears === true) {
      add(blockers, "arrears", "Has arrears",
        "This client does not accept arrears.");
    } else if (candidate.hasArrears == null) {
      add(unknowns, "arrears", "Any arrears or backlogs?", UNKNOWN);
    }
  }

  // ── Education ─────────────────────────────────────────────────────────────
  // Free text on both sides, so this can only ever be a prompt, never a
  // judgement. Saying "check this" is honest; pretending to parse
  // "Any graduate except B.E/B.Tech" is not.
  if (requirement.educationMin) {
    if (!candidate.education) {
      add(unknowns, "education", "Qualification?",
        `Client asks for: ${requirement.educationMin}`);
    } else {
      add(warnings, "education", "Check qualification",
        `Client asks for "${requirement.educationMin}" · candidate has "${candidate.education}"`);
    }
  }

  // ── Experience ────────────────────────────────────────────────────────────
  const exp = candidate.expMonths;
  if (exp == null) {
    if (requirement.expMinMonths != null || requirement.expMaxMonths != null) {
      add(unknowns, "experience", "Total experience?", UNKNOWN);
    }
  } else {
    if (requirement.expMinMonths != null && exp < requirement.expMinMonths) {
      const short = requirement.expMinMonths - exp;
      // Just under is a conversation; well under is a refusal.
      add(short <= 3 ? warnings : blockers, "experience",
        `${describeMonths(short)} short on experience`,
        `Role needs ${describeMonths(requirement.expMinMonths)}, candidate has ${describeMonths(exp)}.`);
    } else if (requirement.expMaxMonths != null && exp > requirement.expMaxMonths) {
      add(warnings, "experience", "More experience than the role expects",
        `Role tops out at ${describeMonths(requirement.expMaxMonths)}, candidate has ${describeMonths(exp)}. Expect a salary mismatch.`);
    }
  }

  // ── Money ─────────────────────────────────────────────────────────────────
  // Compared on monthly take-home, because that is the number said on the call.
  const want = candidate.expectedCtc;
  const ceiling = requirement.takeHomeMax;
  if (want != null && ceiling != null && want > ceiling) {
    const over = Math.round(((want - ceiling) / ceiling) * 100);
    add(over >= 25 ? blockers : warnings, "money",
      `Expecting ${over}% above the ceiling`,
      `Role pays up to ₹${ceiling.toLocaleString("en-IN")}; candidate wants ₹${want.toLocaleString("en-IN")}.`);
  }

  // ── Notice period ─────────────────────────────────────────────────────────
  if (candidate.noticeDays == null) {
    add(unknowns, "notice", "Notice period?", UNKNOWN);
  } else if (candidate.noticeDays >= 60) {
    add(warnings, "notice", `${candidate.noticeDays}-day notice`,
      "Long notice — confirm the client will wait before lining up.");
  }

  // ── Location ──────────────────────────────────────────────────────────────
  if (candidate.location && requirement.location) {
    const a = candidate.location.trim().toLowerCase();
    const b = requirement.location.trim().toLowerCase();
    if (a && b && !a.includes(b) && !b.includes(a)) {
      add(warnings, "location", "Different city",
        `Role is in ${requirement.location}; candidate is in ${candidate.location}. Ask about relocation.`);
    }
  }

  return {
    blockers,
    warnings,
    unknowns,
    verdict: blockers.length ? "blocked"
           : unknowns.length ? "ask"
           : warnings.length ? "check"
           : "clear",
  };
}

/**
 * The questions still worth asking, in the order a recruiter would ask them.
 * Drives the prompt list on the call screen, so nobody has to remember the
 * order or notice the gap themselves.
 */
export function nextQuestions(candidate = {}, requirement = {}) {
  return screen(candidate, requirement).unknowns.map((u) => u.label);
}

export default screen;
