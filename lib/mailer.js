// lib/mailer.js — sending a CV to a client, and knowing that you did.
//
// Modelled on lib/ai.js and for the same reason: THIS NEVER THROWS. It returns
// { ok, reason }. An SMTP server that is down, misconfigured or slow must not
// turn "record this submission" into a 500 — the recruiter still sent the CV,
// the row still needs writing, and the screen needs to say "saved, but the
// email did not go" rather than losing both.
//
// The password lives in the settings row and is never returned to a browser,
// exactly like the AI key.

import { getSettings } from "@/lib/settings";

const TIMEOUT_MS = 15000;

/** Is outbound email configured at all? */
export function mailReady(s) {
  return !!(s?.smtpHost && s?.smtpUser && s?.smtpPassword && s?.smtpFrom);
}

/** What is missing, in words a person can act on. */
export function mailBlockers(s) {
  const out = [];
  if (!s?.smtpHost) out.push("SMTP host");
  if (!s?.smtpUser) out.push("SMTP username");
  if (!s?.smtpPassword) out.push("SMTP password");
  if (!s?.smtpFrom) out.push("the from address");
  return out;
}

/**
 * Send one email.
 *
 * nodemailer is imported lazily. If it is not installed the app still runs and
 * every other screen still works — the only thing that fails is sending, and it
 * fails with a sentence that says what to install rather than a module-not-found
 * stack trace on a page that was only trying to list candidates.
 */
export async function sendMail({ to, subject, text, html, cc, replyTo, attachments = [] }) {
  const settings = await getSettings();

  if (!mailReady(settings)) {
    return { ok: false, reason: `Email is not set up — missing ${mailBlockers(settings).join(", ")}. Settings → Email.` };
  }
  if (!to || !String(to).trim()) return { ok: false, reason: "No recipient address." };
  if (!subject || !String(subject).trim()) return { ok: false, reason: "No subject." };

  let nodemailer;
  try {
    nodemailer = (await import("nodemailer")).default;
  } catch {
    return { ok: false, reason: "The email library is not installed on the server (npm i nodemailer)." };
  }

  try {
    const transport = nodemailer.createTransport({
      host: settings.smtpHost,
      port: settings.smtpPort || (settings.smtpSecure ? 465 : 587),
      secure: !!settings.smtpSecure,
      auth: { user: settings.smtpUser, pass: settings.smtpPassword },
      connectionTimeout: TIMEOUT_MS,
      greetingTimeout: TIMEOUT_MS,
      socketTimeout: TIMEOUT_MS,
    });

    // Belt and braces on the timeout. nodemailer's own timeouts cover the
    // socket; this covers the whole attempt, so a server that accepts the
    // connection and then says nothing cannot hold the request open.
    const result = await Promise.race([
      transport.sendMail({
        from: settings.smtpFrom,
        to: String(to).trim(),
        cc: cc || undefined,
        replyTo: replyTo || undefined,
        subject: String(subject).trim(),
        text: text || undefined,
        html: html || undefined,
        attachments,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), TIMEOUT_MS + 5000)),
    ]);

    return { ok: true, messageId: result?.messageId || null };
  } catch (e) {
    const msg = String(e?.message || e);
    console.error("[mail]", msg);
    return { ok: false, reason: friendly(msg) };
  }
}

/**
 * SMTP errors are written for administrators. These are the four that actually
 * happen, in words that say what to do about them.
 */
function friendly(msg) {
  const m = msg.toLowerCase();
  if (m.includes("invalid login") || m.includes("535") || m.includes("authentication")) {
    return "The mail server rejected the username or password. If this is Gmail, it needs an app password, not the account password.";
  }
  if (m.includes("enotfound") || m.includes("eai_again")) {
    return "The mail server address could not be found — check the SMTP host.";
  }
  if (m.includes("timed out") || m.includes("etimedout")) {
    return "The mail server did not respond. Check the port, and whether the server allows connections from this machine.";
  }
  if (m.includes("self signed") || m.includes("certificate")) {
    return "The mail server's security certificate was rejected.";
  }
  return `The email did not send: ${msg}`;
}

/**
 * The email that goes with a CV.
 *
 * Written the way a client actually wants to receive one: the summary is in the
 * body, so the person deciding can decide from their phone without opening an
 * attachment. A mail that says only "Please find attached" makes them do work
 * to find out whether the candidate is worth the work.
 */
export function submissionEmail({ candidate, requirement, client, sender, companyName }) {
  const c = candidate || {};
  const r = requirement || {};

  const exp = c.expMonths == null
    ? null
    : c.expMonths < 12
    ? `${c.expMonths} months`
    : `${Math.floor(c.expMonths / 12)} years ${c.expMonths % 12 ? `${c.expMonths % 12} months` : ""}`.trim();

  const notice = c.noticeDays == null ? null : c.noticeDays === 0 ? "Immediate" : `${c.noticeDays} days`;

  const lines = [
    [`Name`, c.name],
    [`Current role`, c.designation],
    [`Experience`, exp],
    [`Location`, c.location],
    [`Notice period`, notice],
    [`Current take-home`, c.currentCtc ? `₹${c.currentCtc.toLocaleString("en-IN")}/month` : null],
    [`Expected`, c.expectedCtc ? `₹${c.expectedCtc.toLocaleString("en-IN")}/month` : null],
    [`Skills`, c.skills],
  ].filter(([, v]) => v);

  const subject = `${c.name || "Candidate"} — ${r.designation || "your opening"}${r.location ? `, ${r.location}` : ""}`;

  const text = [
    `Hello${client?.hrName ? ` ${client.hrName}` : ""},`,
    "",
    `Please find attached the CV for ${c.name || "a candidate"} for the ${r.designation || "open"} position${r.location ? ` in ${r.location}` : ""}.`,
    "",
    ...lines.map(([k, v]) => `${k}: ${v}`),
    "",
    "Happy to arrange a call at a time that suits you.",
    "",
    "Regards,",
    sender?.name || "",
    companyName || "",
    sender?.phone || "",
  ].filter((l) => l !== undefined).join("\n");

  const html = `
<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;color:#1e293b;line-height:1.6">
  <p>Hello${client?.hrName ? ` ${esc(client.hrName)}` : ""},</p>
  <p>Please find attached the CV for <strong>${esc(c.name || "a candidate")}</strong> for the
     ${esc(r.designation || "open")} position${r.location ? ` in ${esc(r.location)}` : ""}.</p>
  <table style="border-collapse:collapse;margin:12px 0">
    ${lines.map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#64748b">${esc(k)}</td><td style="padding:3px 0"><strong>${esc(String(v))}</strong></td></tr>`).join("")}
  </table>
  <p>Happy to arrange a call at a time that suits you.</p>
  <p style="color:#64748b">Regards,<br>${esc(sender?.name || "")}<br>${esc(companyName || "")}${sender?.phone ? `<br>${esc(sender.phone)}` : ""}</p>
</div>`.trim();

  return { subject, text, html };
}

// A candidate's name is typed by a recruiter and goes into an HTML email. An
// apostrophe or an ampersand in a name is common; a name is also the easiest
// place to put something that is not a name.
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
