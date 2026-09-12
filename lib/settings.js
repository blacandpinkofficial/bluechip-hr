// lib/settings.js — the handful of numbers that are policy, not data.
//
// One row, created on first read. Everything here is a commercial term that a
// placement copies at the moment it is created and never looks up again, so
// changing a value affects future placements only — last month's numbers do not
// move because someone renegotiated today.

import { prisma } from "@/lib/prisma";

// What the browser sees in place of a stored API key. Never the key itself.
export const MASK = "••••••••••••";

/** Settings safe to send to a browser: the key is replaced by a flag. */
export function publicSettings(s) {
  // Two secrets now, and both follow the same rule: the browser is told WHETHER
  // one is set, never what it is. A settings form that round-trips the real
  // password is a settings form that leaks it to anyone who opens dev tools, or
  // to anything that logs a request body.
  const { aiApiKey, smtpPassword, ...rest } = s || {};
  return {
    ...rest,
    aiKeySet: !!aiApiKey,
    aiApiKey: aiApiKey ? MASK : "",
    smtpPasswordSet: !!smtpPassword,
    smtpPassword: smtpPassword ? MASK : "",
  };
}

export const DEFAULTS = {
  companyName: "Blue Chip HR Solutions Pvt. Ltd.",
  replacementDays: 90,
  defaultPaymentDays: 30,
};

/**
 * The settings row, created if it is not there yet. Never throws — a missing
 * settings table must not take down a screen that merely wanted a company
 * name, so it falls back to the defaults and says nothing.
 */
export async function getSettings() {
  try {
    const existing = await prisma.setting.findUnique({ where: { id: "singleton" } });
    if (existing) return existing;
    return await prisma.setting.create({ data: { id: "singleton" } });
  } catch (e) {
    console.error("[settings] falling back to defaults:", e?.message || e);
    return { id: "singleton", ...DEFAULTS };
  }
}

export async function updateSettings(patch) {
  const data = {};
  if (typeof patch.companyName === "string" && patch.companyName.trim()) {
    data.companyName = patch.companyName.trim().slice(0, 200);
  }
  if (patch.replacementDays !== undefined) {
    const n = Number(patch.replacementDays);
    if (!Number.isFinite(n) || n < 0 || n > 365) {
      throw new Error("The replacement window must be between 0 and 365 days.");
    }
    data.replacementDays = Math.round(n);
  }
  if (patch.defaultPaymentDays !== undefined) {
    const n = Number(patch.defaultPaymentDays);
    if (!Number.isFinite(n) || n < 0 || n > 365) {
      throw new Error("The credit period must be between 0 and 365 days.");
    }
    data.defaultPaymentDays = Math.round(n);
  }
  if (patch.careersEnabled !== undefined) data.careersEnabled = !!patch.careersEnabled;
  if (patch.careersIntro !== undefined) {
    data.careersIntro = String(patch.careersIntro || "").trim().slice(0, 2000) || null;
  }
  if (patch.careersEmail !== undefined) {
    const e = String(patch.careersEmail || "").trim().toLowerCase();
    if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) {
      throw new Error("That does not look like an email address.");
    }
    data.careersEmail = e || null;
  }

  if (patch.aiEnabled !== undefined) data.aiEnabled = !!patch.aiEnabled;
  if (patch.aiProvider !== undefined) {
    const p = String(patch.aiProvider || "").trim();
    if (p && !["anthropic", "openai"].includes(p)) throw new Error("Unknown AI provider.");
    data.aiProvider = p || null;
  }
  if (patch.aiApiKey !== undefined) {
    const k = String(patch.aiApiKey || "").trim();
    // An empty string means "clear it". The masked placeholder coming back
    // from the form means "leave it alone" — otherwise every save of an
    // unrelated field would overwrite the real key with a row of dots.
    if (k === MASK) {
      // no-op
    } else {
      data.aiApiKey = k || null;
    }
  }

  // ── company identity, for invoices ────────────────────────────────────────
  if (patch.gstin !== undefined) {
    const g = String(patch.gstin || "").trim().toUpperCase();
    if (g && !/^\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z][0-9A-Z]$/.test(g)) {
      throw new Error("That GSTIN is not the right shape — 15 characters, starting with the two-digit state code.");
    }
    data.gstin = g || null;
    // The state code lives inside the GSTIN. Deriving it rather than asking
    // twice removes the way these two get out of step, which would silently
    // switch every invoice between IGST and CGST+SGST.
    if (g && !patch.stateCode) data.stateCode = g.slice(0, 2);
  }
  if (patch.stateCode !== undefined) {
    const c = String(patch.stateCode || "").replace(/\D/g, "").slice(0, 2);
    data.stateCode = c || null;
  }
  if (patch.stateName !== undefined) data.stateName = String(patch.stateName || "").trim().slice(0, 100) || null;
  if (patch.addressLine !== undefined) data.addressLine = String(patch.addressLine || "").trim().slice(0, 500) || null;
  if (patch.bankName !== undefined) data.bankName = String(patch.bankName || "").trim().slice(0, 200) || null;
  if (patch.bankAccount !== undefined) data.bankAccount = String(patch.bankAccount || "").trim().slice(0, 50) || null;
  if (patch.bankIfsc !== undefined) data.bankIfsc = String(patch.bankIfsc || "").trim().toUpperCase().slice(0, 20) || null;
  if (patch.invoicePrefix !== undefined) {
    const p2 = String(patch.invoicePrefix || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
    if (!p2) throw new Error("The invoice prefix cannot be empty — it is part of every invoice number.");
    data.invoicePrefix = p2;
  }
  if (patch.gstBps !== undefined) {
    const n = Number(patch.gstBps);
    if (!Number.isFinite(n) || n < 0 || n > 5000) throw new Error("GST must be between 0% and 50%.");
    data.gstBps = Math.round(n);
  }

  // ── outbound email ────────────────────────────────────────────────────────
  if (patch.smtpHost !== undefined) data.smtpHost = String(patch.smtpHost || "").trim().slice(0, 200) || null;
  if (patch.smtpPort !== undefined) {
    const n = Number(patch.smtpPort);
    if (patch.smtpPort === "" || patch.smtpPort === null) data.smtpPort = null;
    else if (!Number.isFinite(n) || n < 1 || n > 65535) throw new Error("That is not a valid port number.");
    else data.smtpPort = Math.round(n);
  }
  if (patch.smtpUser !== undefined) data.smtpUser = String(patch.smtpUser || "").trim().slice(0, 200) || null;
  if (patch.smtpFrom !== undefined) {
    const e = String(patch.smtpFrom || "").trim();
    // Allows both "someone@example.com" and "Name <someone@example.com>",
    // because both are valid From headers and people type both.
    if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$|^.+<[^@\s]+@[^@\s]+\.[^@\s]+>$/.test(e)) {
      throw new Error("The from address does not look like an email address.");
    }
    data.smtpFrom = e || null;
  }
  if (patch.smtpSecure !== undefined) data.smtpSecure = !!patch.smtpSecure;
  if (patch.smtpPassword !== undefined) {
    const k = String(patch.smtpPassword || "").trim();
    // Same rule as the AI key: the mask means "leave it alone".
    if (k !== MASK) data.smtpPassword = k || null;
  }

  if (Object.keys(data).length === 0) throw new Error("Nothing to change.");

  await getSettings(); // make sure the row exists before updating it
  return prisma.setting.update({ where: { id: "singleton" }, data });
}
