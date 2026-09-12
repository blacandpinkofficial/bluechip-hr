// lib/whatsapp.js — the links that open a chat, and what to put in it.
//
// Recruiters live on WhatsApp. Two different links matter and they are not
// interchangeable:
//
//   wa.me/<number>           opens the phone app on a phone, and redirects to
//                            WhatsApp Web on a desktop — but through a
//                            redirect, and it asks first.
//   web.whatsapp.com/send    opens WhatsApp Web directly. On a desk machine
//                            with WhatsApp Web already signed in this is one
//                            click and no interstitial, which over a hundred
//                            messages a day is the whole difference.
//
// Both are offered. Which one a recruiter wants depends on whether they are at
// a desk or on a phone, and that is not something to guess for them.

const DEFAULT_CC = "91"; // India

/**
 * Normalise whatever is in the phone field to the digits WhatsApp needs:
 * country code plus number, no punctuation, no leading zero, no +.
 */
export function waNumber(phone, cc = DEFAULT_CC) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return null;
  // Already carries a country code.
  if (digits.length > 10) return digits.replace(/^0+/, "");
  if (digits.length === 10) return cc + digits;
  return null; // too short to be a mobile; a broken link is worse than none
}

export function waMeLink(phone, message, cc = DEFAULT_CC) {
  const n = waNumber(phone, cc);
  if (!n) return null;
  const q = message ? `?text=${encodeURIComponent(message)}` : "";
  return `https://wa.me/${n}${q}`;
}

export function waWebLink(phone, message, cc = DEFAULT_CC) {
  const n = waNumber(phone, cc);
  if (!n) return null;
  const q = message ? `&text=${encodeURIComponent(message)}` : "";
  return `https://web.whatsapp.com/send?phone=${n}${q}`;
}

export function telLink(phone) {
  const digits = String(phone || "").replace(/[^\d+]/g, "");
  return digits ? `tel:${digits}` : null;
}

function money(n) {
  if (n == null) return null;
  return n >= 1000 ? `₹${Math.round(n / 1000)}k` : `₹${n}`;
}

// Plural agreement, because this text is sent to candidates as written and
// "1 years – 3 years experience" is the kind of thing that makes an agency look
// careless in the one message a candidate actually reads.
function unit(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function expText(req) {
  const f = (m) => (m == null ? null : m < 12 ? unit(m, "month") : unit(Math.round(m / 12), "year"));
  if (req.expMinMonths === 0 && req.expMaxMonths === 0) return "Freshers welcome";
  const lo = f(req.expMinMonths), hi = f(req.expMaxMonths);
  if (lo && hi) return lo === hi ? `${lo} experience` : `${lo} – ${hi} experience`;
  if (lo) return `${lo}+ experience`;
  if (hi) return `Up to ${hi} experience`;
  return null;
}

/**
 * The message a recruiter sends after a call. Written to be sent as-is:
 * no placeholders left to fill, because a message with [NAME] still in it goes
 * out about once a week otherwise.
 */
export function jobMessage({ candidate = {}, requirement = {}, company = "Blue Chip HR" } = {}) {
  const lines = [];
  lines.push(`Hi ${candidate.name || "there"},`);
  lines.push("");
  lines.push(`Following up on our call — here are the details:`);
  lines.push("");
  lines.push(`*${requirement.designation || "Opening"}*`);
  if (requirement.clientName) lines.push(`Company: ${requirement.clientName}`);
  if (requirement.location) lines.push(`Location: ${requirement.location}`);

  const pay = [money(requirement.takeHomeMin), money(requirement.takeHomeMax)].filter(Boolean);
  if (pay.length === 2) lines.push(`Take home: ${pay[0]} – ${pay[1]} per month`);
  else if (pay.length === 1) lines.push(`Take home: up to ${pay[0]} per month`);

  const exp = expText(requirement);
  if (exp) lines.push(exp);
  if (requirement.processType) lines.push(`Process: ${requirement.processType}`);
  if (requirement.cabFacility && requirement.cabFacility !== "none") {
    lines.push(`Cab: ${requirement.cabFacility === "twoway" ? "two way" : "one way"}`);
  }

  // The knockouts, stated up front. This is the whole point: a candidate who
  // reads "relieving letter required" today does not get rejected for it in
  // week two, and does not waste a slot the desk could have given someone else.
  const musts = [];
  if (requirement.relievingRequired) musts.push("Relieving letter required");
  if (requirement.arrearsAllowed === false) musts.push("No arrears / backlogs");
  if (requirement.educationMin) musts.push(requirement.educationMin);
  if (musts.length) {
    lines.push("");
    lines.push(`*Please note:* ${musts.join(" · ")}`);
  }

  lines.push("");
  lines.push(`Please share your updated CV if this works for you.`);
  lines.push("");
  lines.push(company);
  return lines.join("\n");
}

/** Short nudge for a candidate who has gone quiet. */
export function followUpMessage({ candidate = {}, company = "Blue Chip HR" } = {}) {
  return [
    `Hi ${candidate.name || "there"},`,
    "",
    `Just checking in on the role we discussed — are you still looking for a change?`,
    "",
    `A quick yes or no helps; I'll stop following up if the timing isn't right.`,
    "",
    company,
  ].join("\n");
}

/** Interview confirmation, with the details a candidate actually needs. */
export function interviewMessage({ candidate = {}, interview = {}, requirement = {}, company = "Blue Chip HR" } = {}) {
  const when = interview.scheduledAt
    ? new Date(interview.scheduledAt).toLocaleString("en-IN", {
        weekday: "long", day: "numeric", month: "long",
        hour: "numeric", minute: "2-digit", hour12: true,
      })
    : "[date to be confirmed]";

  const lines = [
    `Hi ${candidate.name || "there"},`,
    "",
    `Your interview is confirmed.`,
    "",
    `*${requirement.designation || "Interview"}*${requirement.clientName ? ` — ${requirement.clientName}` : ""}`,
    `When: ${when}`,
    `Mode: ${interview.mode === "direct" ? "In person" : interview.mode === "video" ? "Video call" : "Telephonic"}`,
  ];
  if (interview.mode === "direct" && (interview.location || requirement.location)) {
    lines.push(`Where: ${interview.location || requirement.location}`);
  }
  if (requirement.docsRequired) {
    lines.push("");
    lines.push(`Please carry: ${requirement.docsRequired}`);
  }
  lines.push("");
  lines.push(`Please confirm you'll attend, and tell me as early as you can if you can't — the slot can go to someone else.`);
  lines.push("");
  lines.push(company);
  return lines.join("\n");
}
