// lib/importCandidates.js — reads a Naukri or Monster export into candidates.
//
// This reads the EXCEL/CSV FILE THE PORTAL GIVES YOU when you tick candidates
// and press Download. That is the supported, paid-for way to get data out of
// both sites. There is no scraping here and there should never be: both
// portals' terms forbid it, and an account ban takes the desk's whole sourcing
// pipeline with it.
//
// Four things in these exports will bite, and each is handled rather than
// assumed away:
//
//   1. THE PHONE NUMBER IS THE IDENTITY, and Excel mangles it. A mobile column
//      that was ever formatted as a number arrives as 9.19876e+11, or as
//      919876543210, or as "+91 98765-43210", or with a leading apostrophe.
//      The first of those has LOST DIGITS and cannot be recovered — it is
//      flagged, never guessed.
//
//   2. NAUKRI'S SALARY IS ANNUAL, IN LAKHS. Ours is monthly take-home. "4.5
//      Lacs" is ₹4,50,000 a year, which is NOT ₹37,500 in hand — deductions
//      are real. So annual is stored as annual, the monthly figure is left for
//      a recruiter to confirm on the call, and the row says so.
//
//   3. Experience arrives as "3 Year(s) 6 Month(s)", or "3.6", or "3-6 yrs".
//      "3.6" is three years six months in the first spelling and three point
//      six years in the second. Ambiguous values are flagged.
//
//   4. The same person is in both exports, and already in the database. Rows
//      are matched on the normalised phone so an import updates rather than
//      duplicates — a duplicate candidate means two recruiters calling the
//      same person for the same job, which is how the desk loses a client.
//
// Nothing here touches the database. It returns rows and per-row problems for
// a preview screen. An import you cannot inspect first is an import nobody
// trusts.

// ── headers ─────────────────────────────────────────────────────────────────

function normHeader(h) {
  return String(h || "").toLowerCase().replace(/[\s._\-()/:]+/g, "").trim();
}

// Both portals, plus the spellings people use after editing the file by hand.
const HEADER_MAP = {
  name:        ["name", "candidatename", "fullname", "candidate"],
  phone:       ["mobile", "mobilenumber", "phone", "phoneno", "phonenumber", "contact", "contactno", "contactnumber", "mobileno"],
  altPhone:    ["alternatemobile", "altmobile", "alternatephone", "homephone", "landline", "telephone"],
  email:       ["email", "emailid", "emailaddress", "mail", "mailid"],
  location:    ["currentlocation", "location", "city", "presentlocation", "basedat"],
  prefLocation:["preferredlocation", "preflocation", "desiredlocation", "preferredlocations"],
  experience:  ["totalexperience", "experience", "totalexp", "exp", "workexperience", "totalworkexperience"],
  employer:    ["currentemployer", "employer", "currentcompany", "company", "presentemployer", "organisation", "organization"],
  designation: ["currentdesignation", "designation", "currentrole", "jobtitle", "title", "role"],
  salary:      ["annualsalary", "currentctc", "ctc", "salary", "currentsalary", "annualctc", "presentctc"],
  expected:    ["expectedctc", "expectedsalary", "expectedannualsalary", "expectedctcannual"],
  notice:      ["noticeperiod", "notice", "availabilitytojoin", "joiningtime"],
  skills:      ["keyskills", "skills", "keyskill", "skillset", "technicalskills"],
  education:   ["education", "ugcourse", "graduation", "qualification", "highestqualification", "degree"],
  headline:    ["resumeheadline", "headline", "profilesummary", "summary"],
  modified:    ["lastactive", "lastmodified", "resumemodified", "profilelastupdated", "lastupdated"],
};

const LOOKUP = (() => {
  const m = new Map();
  for (const [field, spellings] of Object.entries(HEADER_MAP)) {
    for (const s of spellings) if (!m.has(s)) m.set(s, field);
  }
  return m;
})();

/** Map a header row to column indexes. First spelling wins on a duplicate. */
export function resolveCandidateHeaders(headerRow = []) {
  const cols = {};
  const unmatched = [];
  headerRow.forEach((raw, i) => {
    const key = normHeader(raw);
    if (!key) return;
    const field = LOOKUP.get(key);
    if (field && cols[field] === undefined) cols[field] = i;
    else if (!field) unmatched.push(String(raw));
  });
  return { cols, unmatched };
}

// ── the phone number ────────────────────────────────────────────────────────

/**
 * An Indian mobile as ten digits, or a reason it could not be read.
 *
 * Returns { phone, problem }. phone is null whenever the value cannot be
 * trusted. The scientific-notation case is the important one: 9.19876e+11 has
 * only six significant digits left in the file. The rest of the number is not
 * "hard to parse", it is GONE, and inventing the missing digits would put a
 * wrong number in the database that looks perfectly valid.
 */
export function normalisePhone(raw) {
  if (raw == null || raw === "") return { phone: null, problem: "No phone number." };

  const asString = String(raw).trim();

  if (/e\+?\d+/i.test(asString)) {
    return {
      phone: null,
      problem:
        `"${asString}" is a phone number Excel turned into a number and rounded. ` +
        `The missing digits are not recoverable — re-export with the mobile column formatted as Text.`,
    };
  }

  // Strip the lot: +, spaces, hyphens, brackets, the leading apostrophe Excel
  // adds, and the "91-" people type by hand.
  let digits = asString.replace(/[^\d]/g, "");

  if (digits.startsWith("0091")) digits = digits.slice(4);
  else if (digits.startsWith("91") && digits.length > 10) digits = digits.slice(2);
  else if (digits.startsWith("0") && digits.length === 11) digits = digits.slice(1);

  if (digits.length !== 10) {
    return { phone: null, problem: `"${asString}" is not a ten-digit mobile number.` };
  }
  // Indian mobiles start 6–9. A number starting 1–5 is a landline typed into
  // the mobile column, or a typo, and WhatsApp will never reach it.
  if (!/^[6-9]/.test(digits)) {
    return { phone: null, problem: `"${asString}" does not look like a mobile — Indian mobiles start with 6, 7, 8 or 9.` };
  }
  return { phone: digits, problem: null };
}

// ── experience ──────────────────────────────────────────────────────────────

/**
 * Total experience in months.
 *
 * "3 Year(s) 6 Month(s)" → 42. "18 months" → 18. "3 yrs" → 36.
 * A bare "3.6" is ambiguous — three years six months on Naukri, three point six
 * years elsewhere — so it is read the Naukri way and FLAGGED, because a
 * six-month difference decides whether someone clears a client's minimum.
 */
export function parseTotalExperience(raw) {
  if (raw == null || raw === "") return { months: null, problem: null };
  const s = String(raw).toLowerCase().trim();

  if (/^(fresher|fresh|nil|na|none|0)$/.test(s)) return { months: 0, problem: null };

  const yearMatch = s.match(/(\d+(?:\.\d+)?)\s*(?:y|yr|yrs|year|years)/);
  const monthMatch = s.match(/(\d+(?:\.\d+)?)\s*(?:m|mo|mon|month|months)/);

  if (yearMatch || monthMatch) {
    const y = yearMatch ? parseFloat(yearMatch[1]) : 0;
    const m = monthMatch ? parseFloat(monthMatch[1]) : 0;
    return { months: Math.round(y * 12 + m), problem: null };
  }

  const bare = s.match(/^(\d+)(?:\.(\d+))?$/);
  if (bare) {
    const years = parseInt(bare[1], 10);
    if (bare[2] === undefined) return { months: years * 12, problem: null };
    const frac = parseInt(bare[2], 10);
    if (frac <= 11) {
      return {
        months: years * 12 + frac,
        problem: `Read "${raw}" as ${years} years ${frac} months. If it meant ${years}.${bare[2]} years, correct it.`,
      };
    }
    return { months: Math.round(parseFloat(s) * 12), problem: `Read "${raw}" as ${parseFloat(s)} years.` };
  }

  return { months: null, problem: `Could not read "${raw}" as an amount of experience.` };
}

// ── salary ──────────────────────────────────────────────────────────────────

/**
 * Annual CTC in rupees.
 *
 * Handles "4.5 Lacs", "4,50,000", "450000 PA", "4.5 LPA", "45000" (monthly,
 * flagged) and the empty "Not disclosed" both portals emit.
 *
 * Returns { annual, monthlyHint, problem }. monthlyHint is annual/12 — a
 * STARTING POINT for the call, not take-home. Take-home is lower and the gap
 * is not a fixed percentage, so it is never computed here.
 */
export function parseAnnualCtc(raw) {
  if (raw == null || raw === "") return { annual: null, monthlyHint: null, problem: null };
  const s = String(raw).toLowerCase().trim();

  if (/not\s*disclosed|confidential|as per|negotiable|^na$|^-+$/.test(s)) {
    return { annual: null, monthlyHint: null, problem: null };
  }

  const num = parseFloat(s.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(num) || num <= 0) {
    return { annual: null, monthlyHint: null, problem: `Could not read "${raw}" as a salary.` };
  }

  let annual;
  if (/lac|lakh|lpa/.test(s)) {
    annual = Math.round(num * 100000);
  } else if (/cr|crore/.test(s)) {
    annual = Math.round(num * 10000000);
  } else if (num < 100) {
    // "4.5" with no unit, on a portal whose column is in lakhs.
    annual = Math.round(num * 100000);
  } else if (num < 100000) {
    // Between ₹100 and ₹1,00,000 with no unit. Almost always a MONTHLY figure
    // someone typed into an annual column. Treated as monthly and flagged,
    // because reading ₹45,000 a month as ₹45,000 a year makes a good candidate
    // look unaffordable and they never get called.
    return {
      annual: Math.round(num * 12),
      monthlyHint: Math.round(num),
      problem: `"${raw}" looks like a monthly figure — read as ₹${Math.round(num).toLocaleString("en-IN")} per month. Confirm on the call.`,
    };
  } else {
    annual = Math.round(num);
  }

  return { annual, monthlyHint: Math.round(annual / 12), problem: null };
}

/** Notice period in days. "Immediate" → 0. "2 Months" → 60. */
export function parseNotice(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).toLowerCase().trim();
  if (/immediate|available now|serving|any ?time|^0$/.test(s)) return 0;
  const n = parseFloat(s.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n)) return null;
  if (/month/.test(s)) return Math.round(n * 30);
  if (/week/.test(s)) return Math.round(n * 7);
  if (/day/.test(s)) return Math.round(n);
  // A bare number: 1, 2, 3 means months on both portals; 15, 30, 60, 90 means days.
  return n <= 6 ? Math.round(n * 30) : Math.round(n);
}

/** Which portal a file came from, guessed from its headers. */
export function detectSource(headerRow = []) {
  const joined = headerRow.map(normHeader).join("|");
  if (/resumeheadline|keyskills|lastactive/.test(joined)) return "naukri";
  if (/monster|profilesummary|jobtitle/.test(joined)) return "monster";
  return "portal";
}

// ── the whole file ──────────────────────────────────────────────────────────

function cell(row, idx) {
  if (idx === undefined || idx === null) return "";
  const v = row[idx];
  return v == null ? "" : typeof v === "string" ? v.trim() : v;
}

/**
 * aoa — array of arrays from SheetJS with { header: 1, raw: true }.
 *
 * Returns { source, cols, unmatched, rows, summary }. Rows without a usable
 * phone are kept with `usable: false` so the screen can show what was rejected
 * and why — a silent drop of 40 rows out of 200 is the import bug nobody
 * catches until the month's numbers are already wrong.
 */
export function parsePortalExport(aoa, { defaultSource } = {}) {
  const grid = (aoa || []).filter(
    (r) => Array.isArray(r) && r.some((c) => c != null && String(c).trim() !== "")
  );
  if (grid.length === 0) {
    return { source: defaultSource || "portal", cols: {}, unmatched: [], rows: [], summary: emptySummary() };
  }

  let headerIdx = 0;
  let resolved = resolveCandidateHeaders(grid[0]);
  for (let i = 0; i < Math.min(grid.length, 8); i++) {
    const r = resolveCandidateHeaders(grid[i]);
    if (Object.keys(r.cols).length >= 3) { headerIdx = i; resolved = r; break; }
  }
  const { cols, unmatched } = resolved;
  const source = defaultSource || detectSource(grid[headerIdx]);

  const rows = [];
  const seen = new Map(); // phone → first row number, to catch dupes inside the file

  for (let i = headerIdx + 1; i < grid.length; i++) {
    const raw = grid[i];
    const problems = [];

    const name = String(cell(raw, cols.name) || "").trim();
    const { phone, problem: phoneProblem } = normalisePhone(cell(raw, cols.phone));
    if (phoneProblem) problems.push(phoneProblem);

    // No name and no phone is a blank or a footer, not a candidate.
    if (!name && !phone) continue;
    if (!name) problems.push("No name.");

    if (phone) {
      if (seen.has(phone)) problems.push(`Same number as row ${seen.get(phone)} in this file.`);
      else seen.set(phone, i + 1);
    }

    const exp = parseTotalExperience(cell(raw, cols.experience));
    if (exp.problem) problems.push(exp.problem);

    const ctc = parseAnnualCtc(cell(raw, cols.salary));
    if (ctc.problem) problems.push(ctc.problem);

    const expected = parseAnnualCtc(cell(raw, cols.expected));
    if (expected.problem) problems.push(`Expected CTC: ${expected.problem}`);

    const altRaw = cell(raw, cols.altPhone);
    const alt = altRaw ? normalisePhone(altRaw) : { phone: null };

    const skills = String(cell(raw, cols.skills) || "").trim();
    const headline = String(cell(raw, cols.headline) || "").trim();

    rows.push({
      sourceRow: i + 1,
      usable: !!phone && !!name,
      problems,
      candidate: {
        name: name || null,
        phone,
        altPhone: alt.phone || null,
        email: String(cell(raw, cols.email) || "").trim().toLowerCase() || null,
        location: String(cell(raw, cols.location) || "").trim() || null,
        designation: String(cell(raw, cols.designation) || "").trim() || null,
        expMonths: exp.months,
        // Monthly take-home is left EMPTY on purpose. The portal gives annual
        // CTC; take-home is what this desk negotiates on, and a guess in that
        // field is a guess a recruiter will quote down the phone.
        currentCtc: null,
        expectedCtc: null,
        noticeDays: parseNotice(cell(raw, cols.notice)),
        skills: skills || null,
        education: String(cell(raw, cols.education) || "").trim() || null,
        source,
        stage: "new",
        // Everything the portal said that has no column of its own, kept as
        // the first note so it is not lost.
        status: [
          cell(raw, cols.employer) && `Currently at ${cell(raw, cols.employer)}`,
          ctc.annual && `Annual CTC ₹${ctc.annual.toLocaleString("en-IN")} (≈₹${ctc.monthlyHint.toLocaleString("en-IN")}/mo gross — confirm take-home)`,
          expected.annual && `Expecting ₹${expected.annual.toLocaleString("en-IN")} annual`,
          cell(raw, cols.prefLocation) && `Prefers ${cell(raw, cols.prefLocation)}`,
          headline,
        ].filter(Boolean).join(" · ") || null,
      },
      // Kept beside the row rather than inside it: useful on the preview
      // screen, not columns in the candidates table.
      extra: {
        annualCtc: ctc.annual,
        expectedAnnualCtc: expected.annual,
        employer: String(cell(raw, cols.employer) || "").trim() || null,
        prefLocation: String(cell(raw, cols.prefLocation) || "").trim() || null,
        lastActive: String(cell(raw, cols.modified) || "").trim() || null,
      },
    });
  }

  const usable = rows.filter((r) => r.usable).length;
  return {
    source,
    cols,
    unmatched,
    rows,
    summary: {
      total: rows.length,
      usable,
      rejected: rows.length - usable,
      withProblems: rows.filter((r) => r.problems.length).length,
      duplicatesInFile: rows.filter((r) => r.problems.some((p) => p.startsWith("Same number as row"))).length,
    },
  };
}

function emptySummary() {
  return { total: 0, usable: 0, rejected: 0, withProblems: 0, duplicatesInFile: 0 };
}

// ── the sample telecallers copy ─────────────────────────────────────────────

/**
 * The blank sheet a telecaller is told to fill in when they have a list on
 * paper, a WhatsApp forward, or an export whose columns nobody recognises.
 *
 * Every header here is a spelling HEADER_MAP already accepts, so a file built
 * from this cannot arrive with "columns not used" against the fields that
 * matter. Row one is the header; the three rows under it are there to show the
 * FORMAT of each column — particularly the mobile, which is text, ten digits,
 * no +91 and no spaces, because that is the column Excel destroys.
 *
 * GET /api/import/candidates builds the .xlsx from this table, so the
 * downloadable template and the parser can never drift apart. The copy checked
 * in at docs/sample-candidate-import.xlsx is generated from these same values —
 * regenerate it if this table changes.
 */
export const SAMPLE_CANDIDATE_TEMPLATE = {
  filename: "sample-candidate-import.xlsx",
  sheetName: "Candidates",
  headers: [
    "Name",
    "Mobile",
    "Alternate Mobile",
    "Email",
    "Current Location",
    "Preferred Location",
    "Total Experience",
    "Current Employer",
    "Current Designation",
    "Annual Salary",
    "Expected CTC",
    "Notice Period",
    // "Skills" and "Summary" rather than Naukri's "Key Skills" and "Resume
    // Headline": both spellings are accepted, but the portal's two are what
    // detectSource() uses to recognise a Naukri export, and a sheet somebody
    // typed by hand should not arrive stamped as one.
    "Skills",
    "Education",
    "Summary",
  ],
  rows: [
    [
      "Priya Ramesh",
      "9840123456",
      "9962104477",
      "priya.ramesh@example.com",
      "Chennai",
      "Chennai, Bengaluru",
      "2 Year(s) 6 Month(s)",
      "Sutherland Global Services",
      "Customer Support Executive",
      "2.4 Lacs",
      "3 Lacs",
      "30 Days",
      "International voice, CRM, MS Excel",
      "B.Com",
      "Voice process associate, US shift, 2.5 years",
    ],
    [
      "Karthik Subramanian",
      "9791234567",
      "8056781234",
      "karthik.s@example.com",
      "Tambaram, Chennai",
      "Chennai",
      "4 Year(s) 2 Month(s)",
      "Infosys BPM",
      "IT Helpdesk Analyst L1",
      "3.6 Lacs",
      "4.5 Lacs",
      "2 Months",
      "Active Directory, Ticketing, Windows 10, Remote support",
      "B.E Computer Science",
      "L1 service desk, ITIL basics, night shift experience",
    ],
    [
      "Divya Anand",
      "7305678901",
      "",
      "divya.anand@example.com",
      "Porur, Chennai",
      "Chennai",
      "Fresher",
      "",
      "",
      "Not disclosed",
      "1.8 Lacs",
      "Immediate",
      "Tamil, English, Basic computers",
      "B.A English",
      "Fresher looking for domestic voice or backend process",
    ],
  ],
};

/** The template as an array-of-arrays, ready for SheetJS. */
export function sampleTemplateAoa() {
  return [SAMPLE_CANDIDATE_TEMPLATE.headers, ...SAMPLE_CANDIDATE_TEMPLATE.rows];
}
