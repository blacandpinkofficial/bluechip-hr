// lib/placementView.js — the ONE place that decides what a placement row looks
// like to a given role. GET, POST and PATCH on /api/placements all go through
// it, so the three can never drift apart again.
//
// This is an ALLOW-LIST, on purpose. The bug this file exists to close (BC-01)
// was a deletion list: POST did `const { revenue, ...rest } = created` and
// shipped feeType, feeBps and feeFlat — the client's agreed commercial rate —
// to every team leader who recorded a placement. A deletion list leaks every
// column added to Placement afterwards; an allow-list leaks nothing it has not
// been told to show. When you add a column to the Placement model, it is
// invisible in the API until you name it here, and that is the correct default.
//
// Two separate gates, because they answer two different questions:
//
//   revenue.read / revenue.own → the RUPEE FIGURE this placement earned, and
//                                the invoice that carries it.
//   client.fees                → the client's agreed RATE behind that figure
//                                (feeType / feeBps / feeFlat). Owner-only:
//                                freezeTerms copies these straight off the
//                                client or the requirement, so they ARE the
//                                commercials.
//
// A team_leader holds placement.read, placement.write and report.desk but
// neither revenue.read nor client.fees — they run the desk's WORK, not its
// money. They are the role every assertion in this file is really about.

import { can } from "@/lib/auth";

// Everything a placement is, minus the money. Named one by one.
const PASSTHROUGH = [
  "id",
  "candidateId",
  "requirementId",
  "clientId",
  "recruiterId",
  "selectedOn",
  "joinedOn",
  "employeeId",
  "ctcOfferedAnnual",
  "takeHomeMonthly",
  "designation",
  "location",
  "replacementUntil",
  "droppedOn",
  "dropReason",
  "createdAt",
  "updatedAt",
];

// Nested selections the routes already make. They are passed through as the
// route selected them — keep those `select` clauses narrow, because anything
// widened to `client: true` would bring the client's live commercials back in
// through a side door this file cannot see.
const NESTED = ["candidate", "client", "requirement", "recruiter"];

// The rupee figure, and the invoice that carries it. The invoice travels with
// the fee, not with the placement: an invoice number and a "paid" chip say what
// the desk billed and collected just as plainly as the figure does, so they sit
// behind the same gate. (GET has always done this; POST and PATCH now match.)
const MONEY = ["revenue", "invoiceStatus", "invoiceNo", "invoicedOn", "paidOn"];

// The client's agreed rate. client.fees, owner-only.
const FEE_TERMS = ["feeType", "feeBps", "feeFlat"];

// Deliberately absent from every list above, and not an oversight:
//
//   billedByInvoiceId — internal. Which invoice currently owns this row's
//                       revenue; it exists for concurrency-safe invoice
//                       claiming and means nothing outside that transaction.
//   invoiceLines      — relation, never selected by these routes.

/**
 * Project a Placement row into what `role` may see.
 *
 * Returns a NEW object. Forbidden keys are OMITTED, never nulled or zeroed — a
 * `revenue: 0` reads as "this placement earned nothing", which is a different
 * and untrue statement from "you may not see what it earned".
 *
 * @param {object} row               a Placement row (optionally with nested
 *                                   candidate/client/requirement/recruiter)
 * @param {string} role              owner | manager | team_leader | recruiter
 * @param {object} [options]
 * @param {string} [options.viewerId] the signed-in user's id. Enables the
 *                                   own-revenue rule: a role holding
 *                                   revenue.own but not revenue.read sees the
 *                                   fee on placements that are THEIRS and on
 *                                   no others. Omit it and only revenue.read
 *                                   opens the money.
 * @returns {object|null}
 */
export function placementForRole(row, role, options = {}) {
  if (!row || typeof row !== "object") return null;

  const viewerId = options.viewerId ?? null;

  // Desk-wide money, or just their own? Both questions, kept apart — the same
  // distinction GET has always drawn.
  const maySeeFee =
    can(role, "revenue.read") ||
    (can(role, "revenue.own") && viewerId != null && row.recruiterId === viewerId);

  const maySeeTerms = can(role, "client.fees");

  const out = {};

  for (const k of PASSTHROUGH) if (k in row) out[k] = row[k];
  for (const k of NESTED) if (k in row) out[k] = row[k];

  // Always stated, either way, so the browser never has to guess whether a
  // missing fee means "hidden" or "not loaded".
  out.maySeeFee = maySeeFee;

  if (maySeeFee) for (const k of MONEY) if (k in row) out[k] = row[k];
  if (maySeeTerms) for (const k of FEE_TERMS) if (k in row) out[k] = row[k];

  // Within the free-replacement window the fee is not safe yet. Derived from
  // dates only — no money in it — so everyone sees it.
  if ("replacementUntil" in row) {
    out.stillReplaceable =
      !!row.replacementUntil &&
      !row.droppedOn &&
      new Date(row.replacementUntil) > new Date();
  }

  return out;
}
