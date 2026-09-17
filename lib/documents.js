// lib/documents.js — which documents are for the whole desk, and which are not.
//
// The knowledge base holds two very different things under one model. Most of
// it is meant to be read by everyone: handover notes, client process notes,
// training material, policy. One kind is not — `client`, which in practice is
// the scanned signed agreement, and a signed agreement has the fee in it.
//
// The rest of the app is careful about that number. client.fees is owner-only,
// revenue.read excludes the team leader, and lib/placementView.js strips the
// fee out of every placement row a team leader is allowed to see. Then the
// agreement itself sat in Knowledge behind candidate.read, which every
// telecaller holds — so the number everything else guards was a search away,
// as a PDF, with the client's rate card on page two.
//
// Two rules, and they have to hold together:
//
//   1. A confidential document does not appear in anyone's list unless they
//      hold document.confidential.
//   2. Its FILE is refused for the same people — a list filter alone is
//      decoration, because the download URL is guessable from an id somebody
//      saw last month and it is the file that carries the number.
//
// An archived document is also refused. Archiving is how the desk takes a
// document out of circulation, and a route that still serves the file makes
// that a gesture rather than an act.

/** Every kind a document may be. Mirrored by the selects on /knowledge. */
export const KINDS = ["note", "handover", "process", "training", "client", "policy"];

/**
 * Kinds that carry commercials. Deliberately a list rather than a boolean
 * column: the kind is already chosen at upload time, and one more thing to
 * remember to tick is one more thing that gets forgotten on the day it matters.
 */
export const CONFIDENTIAL_KINDS = ["client"];

export function isConfidentialKind(kind) {
  return CONFIDENTIAL_KINDS.includes(String(kind || ""));
}

/**
 * The where-fragment for a document list, given whether this viewer may see
 * commercials. Spread into a prisma where.
 */
export function documentScope(maySeeConfidential) {
  if (maySeeConfidential) return {};
  return { kind: { notIn: CONFIDENTIAL_KINDS } };
}

/** The kinds to offer this viewer in a filter or a picker. */
export function visibleKinds(maySeeConfidential) {
  return maySeeConfidential ? KINDS : KINDS.filter((k) => !isConfidentialKind(k));
}
