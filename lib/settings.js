// lib/settings.js — the handful of numbers that are policy, not data.
//
// One row, created on first read. Everything here is a commercial term that a
// placement copies at the moment it is created and never looks up again, so
// changing a value affects future placements only — last month's numbers do not
// move because someone renegotiated today.

import { prisma } from "@/lib/prisma";

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
  if (Object.keys(data).length === 0) throw new Error("Nothing to change.");

  await getSettings(); // make sure the row exists before updating it
  return prisma.setting.update({ where: { id: "singleton" }, data });
}
