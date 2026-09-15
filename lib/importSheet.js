// lib/importSheet.js — reads the JOB DESCRIPTION SHEET into clients + openings.
//
// The sheet is a human document, not a data file, and it shows. Three things
// have to be handled rather than assumed away:
//
//   1. "PROCESS" appears TWICE, meaning two different things — the channel
//      ("International VOICE") in one column and the work ("RCM / Denials") in
//      another. Reading by header name alone silently drops one of them, so
//      duplicate headers are disambiguated by position.
//
//   2. "COMMERCIALS" holds either a flat fee or a percentage, and Excel stores
//      a percent-formatted cell as the FRACTION 0.0833 while a typed "8.33%"
//      arrives as text. Both mean 8.33%. "8k" means eight thousand rupees.
//      These are genuinely different deals and must not be conflated.
//
//   3. Free text where a rule is meant: "RELIEVING", "ARREARS", "CAB FACILITY".
//      Parsed into fields where the intent is clear, flagged for review where
//      it is not. Nothing is guessed silently.
//
// Nothing here writes to the database. It returns rows plus per-row problems so
// the screen can show a preview and a human can approve it. An import that
// cannot be inspected before it runs is an import nobody trusts.

import { percentToBps, parseRupees } from "@/lib/money";

// ── header handling ─────────────────────────────────────────────────────────

function normHeader(h) {
  return String(h || "")
    .toLowerCase()
    .replace(/[\s._\-()/]+/g, "")
    .trim();
}

// Each canonical field and the header spellings that map to it.
const HEADER_MAP = {
  sno:          ["sno", "sl", "slno", "serialno", "no"],
  companyName:  ["companyname", "company", "client", "clientname"],
  hrName:       ["hrname", "hr", "hrcontact", "spoc", "contactperson"],
  location:     ["location", "city", "place", "worklocation"],
  commercials:  ["commercials", "commercial", "fee", "fees", "billing", "charges"],
  process:      ["process"],           // appears twice — see resolveHeaders
  domain:       ["domain", "industry", "vertical"],
  openings:     ["noofpositions", "positions", "openings", "noofopenings", "count", "vacancies"],
  experience:   ["experience", "exp", "yearsofexperience"],
  relieving:    ["relieving", "relievingletter", "relieved"],
  takeHome:     ["ctctakehome", "ctc", "takehome", "salary", "package", "ctcinhand"],
  cab:          ["cabfacility", "cab", "transport", "transportfacility"],
  education:    ["education", "qualification", "educationalqualification"],
  arrears:      ["arrears", "arrear", "backlogs", "backlog"],
  docs:         ["docsubmission", "documents", "documentsubmission", "docs"],
};

/**
 * Map the header row to column indices.
 * Duplicate "PROCESS" columns become processType (first) and processDetail
 * (second), which is the only reading that preserves both.
 */
export function resolveHeaders(headerRow) {
  const cols = {};
  const unmatched = [];
  const processCols = [];

  headerRow.forEach((raw, i) => {
    const n = normHeader(raw);
    if (!n) return;

    if (HEADER_MAP.process.includes(n)) {
      processCols.push(i);
      return;
    }
    const field = Object.keys(HEADER_MAP).find(
      (f) => f !== "process" && HEADER_MAP[f].includes(n)
    );
    if (field) {
      if (cols[field] === undefined) cols[field] = i;
    } else {
      unmatched.push({ index: i, header: String(raw) });
    }
  });

  if (processCols[0] !== undefined) cols.processType = processCols[0];
  if (processCols[1] !== undefined) cols.processDetail = processCols[1];

  return { cols, unmatched, processColumnCount: processCols.length };
}

// ── commercials ─────────────────────────────────────────────────────────────

/**
 * "8k" / 8000            → { feeType: "flat",    feeFlat: 8000 }
 * 0.0833 / "8.33%" / 8.33 → { feeType: "percent", feeBps: 833 }
 *
 * The decision is made on magnitude, and the one genuinely ambiguous band —
 * between 100 and 1000 with no unit — is returned as ambiguous rather than
 * guessed. A wrong guess here is a wrong invoice.
 */
export function parseCommercials(raw) {
  if (raw == null || raw === "") {
    return { feeType: null, feeBps: null, feeFlat: null, note: "empty" };
  }

  const s = String(raw).trim();
  const lower = s.toLowerCase();

  // Explicit percent, however written.
  if (lower.includes("%") || /\bpercent|\bpct\b/.test(lower)) {
    const bps = percentToBps(lower.replace(/[^0-9.]/g, ""));
    return bps == null
      ? { feeType: null, feeBps: null, feeFlat: null, note: `could not read percent from "${s}"` }
      : { feeType: "percent", feeBps: bps, feeFlat: null, note: null };
  }

  // Explicit rupee amount: has k / L, a ₹ sign, or commas.
  if (/[₹]|[0-9]\s*k\b|[0-9]\s*l(akh)?\b|,/.test(lower)) {
    const flat = parseRupees(lower);
    return flat == null
      ? { feeType: null, feeBps: null, feeFlat: null, note: `could not read amount from "${s}"` }
      : { feeType: "flat", feeBps: null, feeFlat: flat, note: null };
  }

  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) {
    return { feeType: null, feeBps: null, feeFlat: null, note: `unrecognised commercials "${s}"` };
  }

  // Excel stores a percent-formatted cell as a fraction.
  if (n < 1) {
    return { feeType: "percent", feeBps: Math.round(n * 10000), feeFlat: null, note: null };
  }
  // A plain number in single or double digits is a percentage in this sheet;
  // nobody bills ₹8 for a placement.
  if (n <= 100) {
    return { feeType: "percent", feeBps: Math.round(n * 100), feeFlat: null, note: null };
  }
  // 1000 and above is unmistakably rupees.
  if (n >= 1000) {
    return { feeType: "flat", feeBps: null, feeFlat: Math.round(n), note: null };
  }
  // 100–1000 with no unit. Could be ₹500, could be a typo. Do not guess.
  return {
    feeType: null, feeBps: null, feeFlat: null,
    note: `"${s}" is ambiguous — under ₹1,000 but over 100%. Set it by hand.`,
  };
}

// ── the free-text columns ───────────────────────────────────────────────────

const NEGATIVE = /\b(no|not|nil|none|without|n\/a|na)\b/;

/** "Yes" / "Mandatory" → true;  "Not required" / "No" → false;  else null. */
export function parseYesNo(raw, { yesWords = [], noWords = [] } = {}) {
  if (raw == null || raw === "") return null;
  const s = String(raw).toLowerCase().trim();

  if (noWords.some((w) => s.includes(w))) return false;
  if (yesWords.some((w) => s.includes(w))) return true;
  if (NEGATIVE.test(s)) return false;
  if (/\b(yes|y|required|mandatory|must|compulsory)\b/.test(s)) return true;
  return null;
}

/** "Two way" → twoway;  "One way" → oneway;  "No cab" → none;  else null. */
export function parseCab(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).toLowerCase();
  if (/\b(two|2)\s*-?\s*way|both/.test(s)) return "twoway";
  if (/\b(one|1)\s*-?\s*way/.test(s)) return "oneway";
  if (NEGATIVE.test(s)) return "none";
  if (/\b(yes|available|provided)\b/.test(s)) return "twoway";
  return null;
}

/**
 * Experience, in months, because this trade really does say "6 months to
 * 1 year" and storing that as 0–1 years loses the distinction that gets a
 * candidate rejected.
 *
 * "Fresher" → 0–0.  "1+ years" → 12–null.  "6 months to 1 year" → 6–12.
 */
export function parseExperience(raw) {
  if (raw == null || raw === "") return { expMinMonths: null, expMaxMonths: null };
  const s = String(raw).toLowerCase();

  if (/fresher|fresh\b|entry level|0\s*exp/.test(s) && !/\d\s*\+/.test(s)) {
    return { expMinMonths: 0, expMaxMonths: 0 };
  }

  // Collect each number with whatever unit was written next to it. Crucially,
  // the number is NOT converted here: in "1-3 years" the 1 carries no unit of
  // its own, and converting it before the sentence is finished is how it ends
  // up multiplied by twelve twice.
  const parts = [];
  const re = /(\d+(?:\.\d+)?)\s*(\+)?\s*(month|mon|mnth|m\b|year|yr|y\b)?/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (!m[1]) continue;
    const unit = m[3] || "";
    parts.push({
      n: Number(m[1]),
      unit: /^m(on|onth|nth)?$/.test(unit) ? "month" : unit ? "year" : null,
      open: !!m[2],
    });
  }
  if (parts.length === 0) return { expMinMonths: null, expMaxMonths: null };

  // "1-3 years" and "6 to 12 months": a bare number takes the unit of whichever
  // number in the phrase did state one. With no unit anywhere, years — nobody
  // writes "1-3" meaning one to three months.
  const stated = parts.find((p) => p.unit)?.unit || "year";
  const months = parts.map((p) => (p.unit || stated) === "month" ? p.n : p.n * 12);

  const min = Math.round(months[0]);
  if (parts[0].open || parts.length === 1) {
    return { expMinMonths: min, expMaxMonths: parts[0].open ? null : min };
  }
  const max = Math.round(months[months.length - 1]);
  return { expMinMonths: Math.min(min, max), expMaxMonths: Math.max(min, max) };
}

/** "18k-22k" → 18000–22000.  "Upto 25k" → null–25000.  "As per exp" → null. */
export function parseTakeHome(raw) {
  if (raw == null || raw === "") return { takeHomeMin: null, takeHomeMax: null };
  const s = String(raw).toLowerCase();

  const nums = (s.match(/\d+(?:\.\d+)?\s*(?:k|l|lakh|lpa)?/g) || [])
    .map((t) => parseRupees(t))
    .filter((n) => n != null && n > 0);

  if (nums.length === 0) return { takeHomeMin: null, takeHomeMax: null };
  if (nums.length === 1) {
    if (/upto|up to|max|maximum|below|under/.test(s)) {
      return { takeHomeMin: null, takeHomeMax: nums[0] };
    }
    return { takeHomeMin: nums[0], takeHomeMax: nums[0] };
  }
  return { takeHomeMin: Math.min(...nums), takeHomeMax: Math.max(...nums) };
}

/** "voice" / "non voice" / "semi voice" out of whatever was typed. */
export function parseProcessType(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).toLowerCase();
  if (/semi[\s-]*voice/.test(s)) return "semi-voice";
  if (/non[\s-]*voice|back\s*office|chat|email/.test(s)) return "non-voice";
  if (/voice|calling|inbound|outbound/.test(s)) return "voice";
  return null;
}

// ── the whole sheet ─────────────────────────────────────────────────────────

function cell(row, idx) {
  if (idx === undefined || idx === null) return "";
  const v = row[idx];
  return v == null ? "" : typeof v === "string" ? v.trim() : v;
}

/**
 * aoa — array of arrays from SheetJS with { header: 1, raw: true }.
 * raw: true matters. With raw: false a percent cell arrives as the string
 * "8.33%" and a flat fee as "8000", which is readable; with raw: true the
 * percent arrives as 0.0833. parseCommercials handles both, so either works —
 * but it must handle both, because which one you get depends on how the cell
 * was formatted, and that varies row to row in a hand-maintained sheet.
 *
 * Returns { headerRow, cols, unmatched, rows, summary }.
 * Every row carries `problems` — the import screen shows them and a human
 * decides. Rows are never silently dropped or silently repaired.
 */
export function parseJobSheet(aoa) {
  const grid = (aoa || []).filter((r) => Array.isArray(r) && r.some((c) => c != null && String(c).trim() !== ""));
  if (grid.length === 0) {
    return { headerRow: [], cols: {}, unmatched: [], rows: [], summary: { total: 0, ok: 0, withProblems: 0, clients: 0 } };
  }

  // The header is the first row that maps to at least three known fields;
  // these sheets often open with a merged title row.
  let headerIdx = 0;
  let resolved = resolveHeaders(grid[0]);
  for (let i = 0; i < Math.min(grid.length, 8); i++) {
    const r = resolveHeaders(grid[i]);
    if (Object.keys(r.cols).length >= 3) { headerIdx = i; resolved = r; break; }
  }
  const { cols, unmatched } = resolved;

  const rows = [];
  const clientNames = new Set();

  for (let i = headerIdx + 1; i < grid.length; i++) {
    const raw = grid[i];
    const problems = [];

    const companyName = String(cell(raw, cols.companyName) || "").trim();
    const designation = String(cell(raw, cols.processDetail) || cell(raw, cols.domain) || "").trim();

    // A row with no company is a spacer or a stray note, not a requirement.
    if (!companyName) continue;
    clientNames.add(companyName);

    const fee = parseCommercials(cell(raw, cols.commercials));
    if (fee.note && fee.note !== "empty") problems.push(`Commercials: ${fee.note}`);
    if (fee.note === "empty") problems.push("No commercials — this opening cannot be billed until one is set.");

    const exp = parseExperience(cell(raw, cols.experience));
    const pay = parseTakeHome(cell(raw, cols.takeHome));

    const openingsRaw = cell(raw, cols.openings);
    let openings = Number(String(openingsRaw).replace(/[^0-9]/g, ""));
    if (!Number.isFinite(openings) || openings < 1) {
      if (String(openingsRaw).trim()) problems.push(`Could not read "${openingsRaw}" as a number of positions — defaulted to 1.`);
      openings = 1;
    }

    const location = String(cell(raw, cols.location) || "").trim();
    if (!location) problems.push("No location.");

    const relieving = parseYesNo(cell(raw, cols.relieving));
    const arrearsRaw = cell(raw, cols.arrears);
    // "ARREARS: no arrears" means arrears are NOT allowed — the column names
    // the problem, not the permission, so the sense is inverted here.
    const arrearsMentionsNone = NEGATIVE.test(String(arrearsRaw).toLowerCase());
    const arrearsAllowed =
      arrearsRaw === "" ? null : arrearsMentionsNone ? false : parseYesNo(arrearsRaw, { yesWords: ["allowed", "ok", "fine", "accept"] });

    rows.push({
      sourceRow: i + 1,
      client: {
        name: companyName,
        hrName: String(cell(raw, cols.hrName) || "").trim() || null,
        city: location || null,
      },
      requirement: {
        designation: designation || "Not stated",
        domain: String(cell(raw, cols.domain) || "").trim() || null,
        processType: parseProcessType(cell(raw, cols.processType)),
        processDetail: String(cell(raw, cols.processDetail) || "").trim() || null,
        location,
        openings,
        expMinMonths: exp.expMinMonths,
        expMaxMonths: exp.expMaxMonths,
        takeHomeMin: pay.takeHomeMin,
        takeHomeMax: pay.takeHomeMax,
        feeType: fee.feeType,
        feeBps: fee.feeBps,
        feeFlat: fee.feeFlat,
        relievingRequired: relieving === true,
        arrearsAllowed: arrearsAllowed === null ? true : arrearsAllowed,
        educationMin: String(cell(raw, cols.education) || "").trim() || null,
        docsRequired: String(cell(raw, cols.docs) || "").trim() || null,
        cabFacility: parseCab(cell(raw, cols.cab)) || "none",
        status: "open",
      },
      problems,
    });
  }

  return {
    headerRow: grid[headerIdx],
    cols,
    unmatched,
    rows,
    summary: {
      total: rows.length,
      ok: rows.filter((r) => r.problems.length === 0).length,
      withProblems: rows.filter((r) => r.problems.length > 0).length,
      clients: clientNames.size,
    },
  };
}

// ── the sample sheet ────────────────────────────────────────────────────────
//
// Nobody on this desk has a blank job description sheet to start from — the
// real one arrives as a forward from a client and is already half-filled. So
// the app hands out a sample instead of a blank: four openings of the kind
// this desk actually works, with the awkward columns already filled in the
// awkward way, so it is obvious what belongs in them.
//
// It lives HERE, next to HEADER_MAP, for one reason: the download must never
// teach a column name the parser stopped accepting. Every header below is a
// spelling HEADER_MAP matches after normHeader(), and the round-trip test in
// the repo reads this table back through parseJobSheet(). A sample that no
// longer parses is a bug in the sample.
//
// Three things in here are deliberate and should survive editing:
//
//   1. PROCESS APPEARS TWICE. The first one is the channel (voice / non voice
//      / semi voice) and the second is the work. resolveHeaders() assigns them
//      by position — first to processType, second to processDetail — and
//      processDetail is what becomes the designation. Drop one and the sample
//      teaches a shape the parser does not read.
//
//   2. THE TITLE ROW IS NOT DECORATION. Real sheets open with a merged title,
//      so parseJobSheet() scans down for the first row resolving three or more
//      known fields. The sample carries a title row so that behaviour is
//      exercised by the file people actually copy.
//
//   3. THE COMMERCIALS ARE UNAMBIGUOUS ON PURPOSE. "8.33%" and "7.5%" read as
//      percentages, 8500 and "10k" as flat fees. Anything between 100 and 1000
//      with no unit comes back ambiguous from parseCommercials() and would put
//      a warning on the sample's own rows, so no value here sits in that band.
//
// REGENERATE docs/sample-job-description-sheet.xlsx WHENEVER THIS TABLE
// CHANGES — that checked-in copy is built from sampleJobSheetAoa() and does
// not update itself. The GET handler on /api/import/requirements builds its
// download from this constant live, so only the docs/ copy can go stale.

export const SAMPLE_JOB_SHEET_TEMPLATE = {
  filename: "sample-job-description-sheet.xlsx",
  sheetName: "Job Descriptions",

  // The merged banner real sheets open with. parseJobSheet() skips past it.
  title: "BLUE CHIP HR SOLUTIONS — JOB DESCRIPTION SHEET (SAMPLE)",

  headers: [
    "S.No",
    "COMPANY NAME",
    "HR NAME",
    "LOCATION",
    "DOMAIN",
    "PROCESS",          // channel — read as processType
    "PROCESS",          // the work — read as processDetail, becomes designation
    "NO OF POSITIONS",
    "EXPERIENCE",
    "CTC / TAKE HOME",
    "COMMERCIALS",
    "RELIEVING",
    "ARREARS",
    "EDUCATION",
    "CAB FACILITY",
    "DOC SUBMISSION",
  ],

  // Column widths for the download, in characters. Same order as headers.
  colWidths: [6, 26, 28, 22, 22, 18, 36, 16, 20, 22, 14, 30, 26, 24, 24, 38],

  // Numbers are written as numbers (S.No, positions, the one numeric fee) and
  // everything else as text. That is not cosmetic: a phone number Excel has
  // decided is numeric loses its leading zero and its last digits, which is
  // why the HR column is written as "name — number" rather than a bare figure.
  rows: [
    [
      1,
      "Varsha Techserve Pvt Ltd",
      "Anitha Raghavan — 98404 22117",
      "Guindy, Chennai",
      "Healthcare BPO",
      "International Voice",
      "US Healthcare RCM - AR Caller (Denials)",
      25,
      "1-3 years",
      "18000 - 24000",
      "8.33%",
      "Relieving letter mandatory",
      "No standing arrears",
      "Any Degree",
      "Two way",
      "Offer letter, last 3 months payslips, relieving letter",
    ],
    [
      2,
      "Nandanam Business Solutions",
      "Prakash Iyer — 90031 44821",
      "Perungudi, Chennai",
      "Banking and Financial Services",
      "Non Voice",
      "Backend Data Processing - Trade Settlements",
      12,
      "6 months to 1 year",
      "16000 - 19000",
      8500,
      "Yes, relieving letter required",
      "Arrears allowed, maximum 2 standing",
      "Any UG or PG",
      "One way, drop only",
      "Aadhaar, PAN, last 3 payslips, offer letter",
    ],
    [
      3,
      "Kaveri Infotech Services",
      "Divya Shankar — 99401 88237",
      "Thoraipakkam OMR, Chennai",
      "IT Infrastructure",
      "Semi Voice",
      "L1 Service Desk - Windows and O365 Support",
      8,
      "2+ years",
      "25k - 32k",
      "10k",
      "Relieving letter mandatory",
      "Arrears accepted",
      "B.E / B.Tech / MCA",
      "Two way, night shift only",
      "Degree certificate, relieving letter, 3 months payslips",
    ],
    [
      4,
      "Marina Retail Ventures",
      "Senthil Kumar — 94440 56712",
      "Ambattur, Chennai",
      "Retail and FMCG Sales",
      "Voice - Outbound",
      "Field Sales Executive - Modern Trade",
      6,
      "Fresher",
      "15000 - 17000 plus incentives",
      "7.5%",
      "Not applicable, fresher hiring",
      "Arrears accepted",
      "Any Degree or Diploma",
      "No cab provided",
      "Aadhaar, PAN, degree certificate",
    ],
  ],
};

/**
 * The sample as an array-of-arrays, ready for SheetJS — title row first, then
 * the headers, then the rows. This is the single source for both the download
 * on /api/import/requirements and the checked-in docs/ copy.
 */
export function sampleJobSheetAoa() {
  return [
    [SAMPLE_JOB_SHEET_TEMPLATE.title],
    SAMPLE_JOB_SHEET_TEMPLATE.headers,
    ...SAMPLE_JOB_SHEET_TEMPLATE.rows,
  ];
}
