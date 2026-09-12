// lib/social.js — ready-to-paste LinkedIn posts and search strings.
//
// WHAT THIS DOES NOT DO, deliberately: it does not post to LinkedIn for you,
// and it does not search LinkedIn for you. Automated posting from a personal
// account and automated scraping of profiles both breach LinkedIn's terms —
// the scraping question has been through the American courts and the account
// bans are real. Losing the company LinkedIn account would cost this desk more
// than the typing it saves.
//
// So: this writes the post, and you press Post. It writes the search string,
// and you paste it into LinkedIn's own search box. The judgement is automated;
// the account stays yours.
//
// The one rule that shapes every post below: THE FIRST LINE IS THE WHOLE POST.
// LinkedIn shows about 140 characters on a phone before "…see more", and most
// people never tap it. A post that opens "We are pleased to announce that we
// are hiring for multiple positions" has spent its only line saying nothing.

const MAX_HOOK = 140;

function inr(n) {
  if (!n) return null;
  return `₹${Number(n).toLocaleString("en-IN")}`;
}

function years(months) {
  if (months == null) return null;
  if (months < 12) return `${months} month${months === 1 ? "" : "s"}`;
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (!m) return `${y} year${y === 1 ? "" : "s"}`;
  return `${y}.${Math.round((m / 12) * 10)} years`;
}

/**
 * "15 AR Callers", not "15 AR Caller".
 *
 * A job title is not a word you can safely add an "s" to. "AR Caller" becomes
 * "AR Callers" and reads correctly; "Senior AR Caller — International Voice
 * Process" becomes gibberish. So a title is pluralised only when it is short
 * and plain, and anything else falls back to a phrasing that needs no plural
 * at all. Getting this wrong is small, but it is the sort of small that makes a
 * hiring post look like it was written by a machine — which is exactly the
 * thing that stops people replying to it.
 */
export function pluralDesignation(designation, count) {
  const d = String(designation || "").trim();
  if (!d || !count || count < 2) return { phrase: d, pluralised: false };

  const tooComplex = /[—–\-/(),&]|\bprocess\b|\bvoice\b/i.test(d) || d.split(/\s+/).length > 3;
  if (tooComplex) return { phrase: d, pluralised: false };

  const words = d.split(/\s+/);
  const last = words[words.length - 1];
  if (!/^[A-Za-z]+$/.test(last)) return { phrase: d, pluralised: false };

  let plural;
  if (/(s|x|z|ch|sh)$/i.test(last)) plural = `${last}es`;
  else if (/[^aeiou]y$/i.test(last)) plural = `${last.slice(0, -1)}ies`;
  else plural = `${last}s`;

  words[words.length - 1] = plural;
  return { phrase: words.join(" "), pluralised: true };
}

function expLine(req) {
  const lo = years(req.expMinMonths);
  const hi = years(req.expMaxMonths);
  if (lo && hi) return `${lo} – ${hi}`;
  if (lo) return `${lo}+`;
  if (hi) return `up to ${hi}`;
  return null;
}

function payLine(req) {
  const lo = inr(req.takeHomeMin);
  const hi = inr(req.takeHomeMax);
  if (lo && hi) return `${lo} – ${hi} take-home per month`;
  if (hi) return `up to ${hi} take-home per month`;
  if (lo) return `from ${lo} take-home per month`;
  return null;
}

/**
 * Whether the client's name may appear in a public post.
 *
 * Almost always no. Most clients treat the fact that they are hiring as
 * commercial information — a competitor learns their attrition, and their own
 * staff learn it from LinkedIn before their manager tells them. Naming a client
 * without asking is how an agency loses the account, so the default is the
 * industry's own euphemism and the honest reason for it.
 */
export function clientLabel(requirement) {
  const client = requirement?.client;
  if (requirement?.publishOnline && client?.name) return client.name;
  if (client?.city) return `a leading healthcare BPO in ${client.city}`;
  return "a leading healthcare BPO";
}

/**
 * The post itself.
 *
 * style:
 *   "hiring"  — the standard opening post
 *   "urgent"  — an immediate-joiner push, for a requirement closing this week
 *   "walkin"  — a walk-in or drive, where the date and address are the point
 *
 * Returns { text, hook, hookLength, hookFits, hashtags, warnings }.
 * warnings are shown beside the Copy button, not silently swallowed: a post
 * missing its pay range will get fewer replies, and the recruiter should know
 * that before they publish, not after.
 */
export function linkedInPost(requirement, { style = "hiring", contactName, contactPhone, contactEmail, walkIn } = {}) {
  const r = requirement || {};
  const warnings = [];

  const role = r.designation || "Openings";
  const place = r.location || "";
  const who = clientLabel(r);
  const exp = expLine(r);
  const pay = payLine(r);
  const openings = r.openings && r.openings > 1 ? r.openings : null;

  if (!pay) warnings.push("No pay range on this requirement. Posts without a salary get markedly fewer replies — people assume it is low.");
  if (!place) warnings.push("No location. A hiring post with no city reads as a scam.");
  if (!contactPhone && !contactEmail) warnings.push("No way for anyone to reply. Add a phone number or an email.");

  // ── the hook ──────────────────────────────────────────────────────────────
  let hook;
  if (style === "urgent") {
    hook = `Immediate joiners — ${role}${place ? `, ${place}` : ""}${pay ? `. ${pay.replace(" take-home per month", "/month in hand")}` : ""}.`;
  } else if (style === "walkin") {
    const when = walkIn?.when ? ` on ${walkIn.when}` : "";
    hook = `Walk-in for ${role}${place ? ` in ${place}` : ""}${when}.`;
  } else if (openings) {
    const { phrase, pluralised } = pluralDesignation(role, openings);
    // When the title cannot be pluralised cleanly, "openings for" carries the
    // count instead, so the sentence stays correct either way.
    hook = pluralised
      ? `Hiring ${openings} ${phrase}${place ? ` in ${place}` : ""}${exp ? ` — ${exp} experience` : ""}.`
      : `${openings} openings for ${phrase}${place ? ` in ${place}` : ""}${exp ? ` — ${exp} experience` : ""}.`;
  } else {
    hook = `Hiring ${role}${place ? ` in ${place}` : ""}${exp ? ` — ${exp} experience` : ""}.`;
  }

  // ── the body ──────────────────────────────────────────────────────────────
  const bullets = [];
  if (r.processType) bullets.push(`Process: ${r.processType}${r.processDetail ? ` — ${r.processDetail}` : ""}`);
  else if (r.processDetail) bullets.push(`Process: ${r.processDetail}`);
  if (exp) bullets.push(`Experience: ${exp}`);
  if (pay) bullets.push(`Salary: ${pay}`);
  if (place) bullets.push(`Location: ${place}`);
  if (r.shift) bullets.push(`Shift: ${r.shift}`);
  // cabFacility is a string on the requirement — "none" | "oneway" | "twoway" —
  // not a flag. Read as a boolean it is truthy even when it says "none", which
  // would promise a cab that does not exist in a public post.
  if (r.cabFacility === "twoway") bullets.push("Two-way cab provided");
  else if (r.cabFacility === "oneway") bullets.push("One-way cab provided");
  if (r.relievingRequired) bullets.push("Relieving letter required");
  if (openings) bullets.push(`Positions: ${openings}`);

  const reply = [];
  if (contactPhone) reply.push(`WhatsApp or call ${contactPhone}`);
  if (contactEmail) reply.push(`email your CV to ${contactEmail}`);
  const replyLine = reply.length
    ? `Interested? ${reply.join(", or ")}${contactName ? ` — ${contactName}` : ""}.`
    : "Interested? Send me a message.";

  const walkInBlock =
    style === "walkin" && walkIn
      ? [
          "",
          walkIn.when ? `When: ${walkIn.when}` : null,
          walkIn.where ? `Where: ${walkIn.where}` : null,
          walkIn.bring ? `Bring: ${walkIn.bring}` : "Bring: updated CV, one ID proof, one passport photo",
        ].filter(Boolean)
      : [];

  const hashtags = buildHashtags(r, place);

  const text = [
    hook,
    "",
    `We are hiring for ${who}.`,
    "",
    ...bullets.map((b) => `• ${b}`),
    ...walkInBlock,
    "",
    replyLine,
    "",
    // Referrals outperform every other channel on a post like this, and asking
    // costs one line. Most posts forget to ask.
    "Know someone who fits? Please tag or share — it genuinely helps them.",
    "",
    hashtags.join(" "),
  ].join("\n");

  return {
    text,
    hook,
    hookLength: hook.length,
    hookFits: hook.length <= MAX_HOOK,
    hashtags,
    warnings: hook.length > MAX_HOOK
      ? [...warnings, `The first line is ${hook.length} characters. LinkedIn cuts it at about ${MAX_HOOK} on a phone — shorten the designation or drop the city from the first line.`]
      : warnings,
  };
}

/**
 * Hashtags, capped at eight.
 *
 * Eight is not arbitrary: past roughly ten, LinkedIn's own guidance and every
 * measured test agree that reach falls rather than rises, and a wall of tags
 * makes a real vacancy look like spam. Three specific tags beat fifteen broad
 * ones.
 */
function buildHashtags(r, place) {
  const tags = ["#hiring"];
  const d = String(r.designation || "").toLowerCase();

  if (/ar\s*call|accounts receivable/.test(d)) tags.push("#arcaller", "#rcm");
  else if (/denial/.test(d)) tags.push("#denialmanagement", "#rcm");
  else if (/coder|coding/.test(d)) tags.push("#medicalcoding", "#rcm");
  else if (/tele\s*caller|telecalling/.test(d)) tags.push("#telecaller");
  else if (/recruit/.test(d)) tags.push("#recruitment");
  if (/rcm|revenue cycle|healthcare/.test(String(r.domain || "").toLowerCase()) && !tags.includes("#rcm")) tags.push("#rcm");

  if (place) {
    const city = place.split(/[,/]/)[0].trim().toLowerCase().replace(/\s+/g, "");
    if (city) tags.push(`#${city}jobs`);
  }
  if (r.processType === "voice") tags.push("#voiceprocess");
  if (r.processType === "non-voice") tags.push("#nonvoice");
  tags.push("#jobopening");

  return [...new Set(tags)].slice(0, 8);
}

/**
 * A boolean search string to PASTE INTO LINKEDIN'S OWN SEARCH BOX.
 *
 * Nothing is fetched. This is the string a good sourcer would type, written
 * from the requirement so nobody has to remember the syntax under pressure.
 *
 * Two things people get wrong and this gets right: LinkedIn's operators must be
 * CAPITALISED (a lowercase "or" is searched as the word "or"), and a
 * multi-word phrase must be quoted or it is read as two separate words.
 */
export function booleanSearch(requirement, { includeCurrentEmployers = [], excludeEmployers = [] } = {}) {
  const r = requirement || {};
  const titles = titleVariants(r.designation);
  const parts = [];

  if (titles.length) parts.push(`(${titles.map(quote).join(" OR ")})`);

  const skills = String(r.skills || r.processDetail || "")
    .split(/[,;/]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2)
    .slice(0, 4);
  if (skills.length) parts.push(`(${skills.map(quote).join(" OR ")})`);

  if (r.location) {
    const cities = String(r.location).split(/[,/]/).map((c) => c.trim()).filter(Boolean).slice(0, 3);
    if (cities.length) parts.push(`(${cities.map(quote).join(" OR ")})`);
  }

  if (includeCurrentEmployers.length) {
    parts.push(`(${includeCurrentEmployers.slice(0, 6).map(quote).join(" OR ")})`);
  }
  for (const e of excludeEmployers.slice(0, 6)) parts.push(`NOT ${quote(e)}`);

  const query = parts.join(" AND ");

  return {
    query,
    // The same idea as a plain-Google site: search, which finds public profiles
    // LinkedIn's own filters hide behind a paid seat.
    googleQuery: query ? `site:linkedin.com/in ${query.replace(/\bAND\b/g, "").replace(/\s+/g, " ").trim()}` : "",
    notes: [
      "Paste this into LinkedIn's search box, then switch the results tab to People.",
      "OR, AND and NOT must stay in capitals — in lowercase LinkedIn searches for the words themselves.",
      "If it returns almost nothing, drop the last bracket and widen from there. Over-specified is the usual mistake.",
    ],
  };
}

function quote(s) {
  const t = String(s).trim();
  return /\s/.test(t) ? `"${t}"` : t;
}

/** The other names the same job goes by, so a search does not miss two-thirds of them. */
function titleVariants(designation) {
  const d = String(designation || "").trim();
  if (!d) return [];
  const l = d.toLowerCase();
  const out = new Set([d]);

  if (/ar\s*call/.test(l)) {
    out.add("AR Caller");
    out.add("Accounts Receivable");
    out.add("AR Analyst");
    out.add("AR Executive");
  }
  if (/denial/.test(l)) { out.add("Denial Management"); out.add("Denials Specialist"); }
  if (/coder|coding/.test(l)) { out.add("Medical Coder"); out.add("Medical Coding"); }
  if (/team\s*lead|^tl$/.test(l)) { out.add("Team Lead"); out.add("Team Leader"); }
  if (/recruit/.test(l)) { out.add("Recruiter"); out.add("Talent Acquisition"); }
  if (/tele\s*caller/.test(l)) { out.add("Telecaller"); out.add("Tele Caller"); out.add("Customer Support"); }

  return [...out].slice(0, 6);
}

/**
 * A short post for a candidate-facing WhatsApp status or a Telegram group —
 * the same opening, cut to fit where nobody scrolls.
 */
export function shortPost(requirement, { contactPhone } = {}) {
  const r = requirement || {};
  const pay = payLine(r);
  return [
    `${r.designation || "Opening"}${r.location ? ` – ${r.location}` : ""}`,
    expLine(r) ? `Exp: ${expLine(r)}` : null,
    pay ? `Salary: ${pay}` : null,
    contactPhone ? `Call/WhatsApp: ${contactPhone}` : null,
  ].filter(Boolean).join("\n");
}
