// lib/ai.js — the optional AI layer.
//
// Three rules, and the first one is the important one:
//
//   1. NOTHING DEPENDS ON IT. Every feature that uses AI already works without
//      it. The AI rewrites a script that was already usable; it never produces
//      the only version. A recruiter at 9am with an expired API key gets a
//      slightly plainer script, not an empty screen.
//   2. It is server-side only. The key never reaches a browser, and neither do
//      candidate details via a third party the browser talks to directly.
//   3. It fails silently and fast. A ten-second timeout, one attempt, and on
//      any error the caller gets the deterministic version with a note saying
//      why. An AI outage must never look like an app outage.

import { getSettings } from "@/lib/settings";

const TIMEOUT_MS = 10000;
const MAX_TOKENS = 1200;

/** Is AI configured and switched on? Never throws. */
export async function aiReady() {
  try {
    const s = await getSettings();
    return !!(s.aiEnabled && s.aiApiKey && s.aiProvider);
  } catch {
    return false;
  }
}

/**
 * One completion. Returns { ok, text } or { ok: false, reason } — never throws,
 * because every caller's correct response to a failure is "use the built-in
 * version", and that should not require a try/catch at every call site.
 */
export async function complete({ system, prompt }) {
  let s;
  try {
    s = await getSettings();
  } catch {
    return { ok: false, reason: "settings unavailable" };
  }

  if (!s.aiEnabled) return { ok: false, reason: "AI is switched off in settings" };
  if (!s.aiApiKey || !s.aiProvider) return { ok: false, reason: "no AI key configured" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    if (s.aiProvider === "anthropic") {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": s.aiApiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: MAX_TOKENS,
          system,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        // The status is worth surfacing — 401 means the key is wrong and
        // someone should fix it, 529 means try later. Lumping them together as
        // "AI failed" leaves nobody knowing which.
        return { ok: false, reason: `Anthropic returned ${r.status}`, detail: body.slice(0, 300) };
      }
      const j = await r.json();
      const text = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
      return text ? { ok: true, text } : { ok: false, reason: "empty response" };
    }

    if (s.aiProvider === "openai") {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${s.aiApiKey}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          max_tokens: MAX_TOKENS,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
        }),
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        return { ok: false, reason: `OpenAI returned ${r.status}`, detail: body.slice(0, 300) };
      }
      const j = await r.json();
      const text = j.choices?.[0]?.message?.content?.trim();
      return text ? { ok: true, text } : { ok: false, reason: "empty response" };
    }

    return { ok: false, reason: `unknown provider "${s.aiProvider}"` };
  } catch (e) {
    if (e?.name === "AbortError") return { ok: false, reason: "AI timed out" };
    // Egress on this box is restricted; a blocked outbound call looks like this.
    return { ok: false, reason: e?.message || "AI request failed" };
  } finally {
    clearTimeout(timer);
  }
}

// The instruction that keeps generated scripts usable. Written as constraints
// on truthfulness rather than tone, because the failure mode that costs money
// here is a candidate joining on a false promise and leaving inside the
// replacement window.
export const SCRIPT_SYSTEM = `You write call scripts for recruiters at an Indian staffing agency.

Hard rules:
- Use ONLY the facts given. Never invent a salary, a benefit, a company detail,
  a growth timeline or a perk that is not in the input. If a fact is missing,
  leave it out rather than guessing.
- Never tell the recruiter to conceal or downplay a requirement the client has
  set. A candidate misled into a job leaves within weeks, the fee is clawed
  back, and the client stops calling.
- Where the role is genuinely wrong for the candidate, say so plainly and
  suggest moving on. That is a useful outcome, not a failure.
- Indian English. Rupees. Short sentences a person can say out loud on a phone
  without rehearsing.
- No emoji, no exclamation marks, no American sales cliches.

Return plain text with the section headings you are asked for and nothing else.`;
