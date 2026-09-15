// scripts/unseed-demo.mjs — remove everything seed-demo.mjs created, and
// nothing else.
//
//   node scripts/unseed-demo.mjs          shows exactly what would go, deletes nothing
//   node scripts/unseed-demo.mjs --yes    deletes it
//
// THIS RUNS AGAINST THE LIVE DATABASE. The whole design of this file is the
// promise that it cannot reach a real record:
//
//   • It never matches on "looks like a demo". It selects on three markers
//     that a real row cannot carry, and then CHECKS all three agree before
//     deleting anything. A row that matches one marker but not the others
//     stops the script rather than being deleted on a guess.
//   • It refuses to run at all if a real record has become entangled with a
//     demo one — an invoice raised against a demo placement, a real candidate
//     assigned to a demo opening — because deleting the demo row would then
//     silently alter the real one. It says which row, and stops.
//   • Running it twice is fine. The second run finds nothing and says so.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ═══════════════════════════════════════════════════════════════════════════
// THE MARKERS — these must match scripts/seed-demo.mjs exactly.
// ═══════════════════════════════════════════════════════════════════════════

const DEMO_CLIENT_PREFIX = "DEMO ";
const DEMO_NAME_PREFIX = "DEMO ";
const DEMO_SOURCE = "demo-seed";
// 009000xxxx — outside the Indian numbering plan entirely: mobiles begin 6–9,
// landlines are dialled 0 + an STD code beginning 1–8, and 00 is the
// international access prefix. No subscriber number can be in this block.
const DEMO_PHONE_PREFIX = "009000";

const CONFIRMED = process.argv.slice(2).includes("--yes");

function head(s) {
  console.log("");
  console.log(`  ${s}`);
  console.log(`  ${"─".repeat(s.length)}`);
}

function stop(lines) {
  console.error("");
  console.error("  Refusing to delete anything.");
  console.error("");
  for (const l of lines) console.error(`  ${l}`);
  console.error("");
  process.exit(1);
}

async function main() {
  // ── 1. Find the demo rows, by their anchors ──────────────────────────────
  const clients = await prisma.client.findMany({
    where: { name: { startsWith: DEMO_CLIENT_PREFIX } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const clientIds = clients.map((c) => c.id);

  const candidates = await prisma.candidate.findMany({
    where: { phone: { startsWith: DEMO_PHONE_PREFIX } },
    select: { id: true, name: true, phone: true, source: true, stage: true },
    orderBy: { phone: "asc" },
  });
  const candidateIds = candidates.map((c) => c.id);

  const requirements = clientIds.length
    ? await prisma.requirement.findMany({
        where: { clientId: { in: clientIds } },
        select: { id: true, designation: true, location: true, clientId: true },
        orderBy: { designation: "asc" },
      })
    : [];
  const requirementIds = requirements.map((r) => r.id);

  if (!clients.length && !candidates.length) {
    console.log("");
    console.log("  Nothing to remove — there is no demo data in this database.");
    console.log("");
    return;
  }

  // ── 2. The markers must all agree ────────────────────────────────────────
  //
  // A row sitting in the reserved phone block that is not also named "DEMO …"
  // and sourced "demo-seed" was not written by the seeder. Deleting it on the
  // strength of one marker is exactly the mistake this script exists to avoid.
  const mismatched = candidates.filter(
    (c) => c.source !== DEMO_SOURCE || !c.name.startsWith(DEMO_NAME_PREFIX)
  );
  if (mismatched.length) {
    stop([
      `${mismatched.length} row(s) are in the reserved demo phone block but do not carry the`,
      "other two demo markers, so this script cannot prove they are demo data:",
      "",
      ...mismatched.map((c) => `    ${c.phone}  ${c.name}  (source: ${c.source ?? "—"})`),
      "",
      "Check them by hand. Nothing has been deleted.",
    ]);
  }

  // ── 3. Entanglement checks: would deleting a demo row change a real one? ──
  const problems = [];

  if (candidateIds.length) {
    const invoiced = await prisma.invoiceLine.findMany({
      where: { placement: { candidateId: { in: candidateIds } } },
      select: { id: true, description: true, invoice: { select: { number: true } } },
    });
    if (invoiced.length) {
      problems.push(
        `${invoiced.length} invoice line(s) are billed against a demo placement:`,
        ...invoiced.map((l) => `    ${l.invoice?.number ?? "(no number)"} — ${l.description}`),
        "Deleting the placement would blank those lines and change a real invoice.",
        "Cancel or delete the invoice first."
      );
    }
  }

  if (clientIds.length) {
    const invoices = await prisma.invoice.findMany({
      where: { clientId: { in: clientIds } },
      select: { number: true, totalPaise: true },
    });
    if (invoices.length) {
      problems.push(
        `${invoices.length} invoice(s) have been raised against a demo client:`,
        ...invoices.map((i) => `    ${i.number}`),
        "An invoice is a legal document and this script will not delete one."
      );
    }

    const docs = await prisma.document.findMany({
      where: { clientId: { in: clientIds } },
      select: { id: true, title: true },
    });
    if (docs.length) {
      problems.push(
        `${docs.length} document(s) are attached to a demo client:`,
        ...docs.map((d) => `    ${d.title}`),
        "Deleting the client would silently detach them. Move or delete them first."
      );
    }
  }

  if (requirementIds.length) {
    // A real candidate parked on a demo opening. Candidate.requirement is an
    // optional relation, so deleting the requirement would quietly null their
    // requirementId instead of failing.
    const strayCandidates = await prisma.candidate.findMany({
      where: { requirementId: { in: requirementIds }, phone: { not: { startsWith: DEMO_PHONE_PREFIX } } },
      select: { name: true, phone: true },
    });
    if (strayCandidates.length) {
      problems.push(
        `${strayCandidates.length} real candidate(s) are assigned to a demo opening:`,
        ...strayCandidates.map((c) => `    ${c.name} (${c.phone})`),
        "Reassign them before removing the demo data."
      );
    }

    const strayWhere = { requirementId: { in: requirementIds }, candidateId: { notIn: candidateIds.length ? candidateIds : ["-"] } };
    const [strayInterviews, straySubmissions, strayPlacements] = await Promise.all([
      prisma.interview.count({ where: strayWhere }),
      prisma.submission.count({ where: strayWhere }),
      prisma.placement.count({ where: strayWhere }),
    ]);
    if (strayInterviews || straySubmissions || strayPlacements) {
      problems.push(
        "Real records exist against a demo opening:",
        `    interviews ${strayInterviews} · submissions ${straySubmissions} · placements ${strayPlacements}`,
        "Move or delete them first."
      );
    }
  }

  if (problems.length) stop(problems);

  // ── 4. Count everything that will go ─────────────────────────────────────
  const inCand = { candidateId: { in: candidateIds.length ? candidateIds : ["-"] } };

  const [calls, submissions, interviews, placements, clientNotes] = await Promise.all([
    prisma.candidateCall.count({ where: inCand }),
    prisma.submission.count({ where: inCand }),
    prisma.interview.count({ where: inCand }),
    prisma.placement.count({ where: inCand }),
    clientIds.length ? prisma.clientNote.count({ where: { clientId: { in: clientIds } } }) : 0,
  ]);

  // Reminders carry no foreign key, only a refId, so they have to be found by
  // the ids they point at — otherwise they survive as pointers to nothing.
  const [placementRows, submissionRows, interviewRows] = await Promise.all([
    prisma.placement.findMany({ where: inCand, select: { id: true } }),
    prisma.submission.findMany({ where: inCand, select: { id: true } }),
    prisma.interview.findMany({ where: inCand, select: { id: true } }),
  ]);
  const refIds = [
    ...candidateIds,
    ...placementRows.map((r) => r.id),
    ...submissionRows.map((r) => r.id),
    ...interviewRows.map((r) => r.id),
  ];
  const reminders = refIds.length
    ? await prisma.reminder.count({ where: { refId: { in: refIds } } })
    : 0;

  const total =
    reminders + placements + submissions + interviews + calls +
    candidates.length + clientNotes + requirements.length + clients.length;

  // ── 5. Say exactly what will go ──────────────────────────────────────────
  head(CONFIRMED ? "Deleting demo data" : "This is what would be deleted");

  console.log("  Clients");
  for (const c of clients) console.log(`      ${c.name}`);
  console.log("");
  console.log("  Requirements");
  for (const r of requirements) console.log(`      ${r.designation} — ${r.location}`);
  console.log("");
  console.log("  Candidates");
  for (const c of candidates) console.log(`      ${c.phone}  ${c.name}  [${c.stage}]`);
  console.log("");
  console.log("  Counts");
  console.log(`      reminders        ${reminders}`);
  console.log(`      placements       ${placements}`);
  console.log(`      submissions      ${submissions}`);
  console.log(`      interviews       ${interviews}`);
  console.log(`      calls            ${calls}`);
  console.log(`      candidates       ${candidates.length}`);
  console.log(`      client notes     ${clientNotes}`);
  console.log(`      requirements     ${requirements.length}`);
  console.log(`      clients          ${clients.length}`);
  console.log(`      ─────────────────────`);
  console.log(`      total rows       ${total}`);
  console.log("");

  if (!CONFIRMED) {
    console.log("  Nothing has been deleted. To go ahead:");
    console.log("");
    console.log("      node scripts/unseed-demo.mjs --yes");
    console.log("");
    return;
  }

  // ── 6. Delete, in dependency order, all or nothing ───────────────────────
  //
  // Placement → Candidate and every requirement relation are required FKs, so
  // the order is not a preference: the wrong order fails on a constraint
  // halfway through and leaves the database part-cleaned.
  const done = await prisma.$transaction(
    async (tx) => {
      const out = {};
      out.reminders = refIds.length ? (await tx.reminder.deleteMany({ where: { refId: { in: refIds } } })).count : 0;
      out.placements = candidateIds.length ? (await tx.placement.deleteMany({ where: inCand })).count : 0;
      out.submissions = candidateIds.length ? (await tx.submission.deleteMany({ where: inCand })).count : 0;
      out.interviews = candidateIds.length ? (await tx.interview.deleteMany({ where: inCand })).count : 0;
      out.calls = candidateIds.length ? (await tx.candidateCall.deleteMany({ where: inCand })).count : 0;
      // Belt and braces: match on all three markers, not just the phone block.
      out.candidates = candidateIds.length
        ? (await tx.candidate.deleteMany({
            where: {
              id: { in: candidateIds },
              phone: { startsWith: DEMO_PHONE_PREFIX },
              source: DEMO_SOURCE,
              name: { startsWith: DEMO_NAME_PREFIX },
            },
          })).count
        : 0;
      out.clientNotes = clientIds.length ? (await tx.clientNote.deleteMany({ where: { clientId: { in: clientIds } } })).count : 0;
      out.requirements = clientIds.length ? (await tx.requirement.deleteMany({ where: { clientId: { in: clientIds } } })).count : 0;
      out.clients = (await tx.client.deleteMany({
        where: { id: { in: clientIds }, name: { startsWith: DEMO_CLIENT_PREFIX } },
      })).count;
      return out;
    },
    { maxWait: 15000, timeout: 120000 }
  );

  const deleted = Object.values(done).reduce((a, b) => a + b, 0);

  console.log(`  Deleted ${deleted} rows.`);
  if (deleted !== total) {
    console.log("");
    console.log(`  (Expected ${total}. The difference is rows that changed between the count`);
    console.log("   and the delete — run this again to confirm nothing demo is left.)");
  }
  console.log("");
  console.log("  The demo is gone. Real clients, requirements and candidates are untouched.");
  console.log("");
}

try {
  await main();
} catch (e) {
  console.error("");
  console.error("  Failed — nothing was deleted.");
  console.error(`  ${e?.message || e}`);
  console.error("");
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
