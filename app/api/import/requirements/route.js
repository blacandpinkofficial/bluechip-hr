// POST /api/import/requirements
//
// Two passes, deliberately:
//
//   mode=preview   upload the workbook, get back every parsed row plus what
//                  could not be read. Nothing is written.
//   mode=commit    send back the rows the human approved. Only then do we write.
//
// The preview is not a nicety. This sheet is maintained by hand, "COMMERCIALS"
// means two different things depending on the row, and a silent import that
// guesses wrong produces a hundred openings that look right and bill wrong.
// Someone has to look at it once.

import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/prisma";
import { requireCapability, can } from "@/lib/auth";
import { parseJobSheet } from "@/lib/importSheet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req) {
  const gate = await requireCapability("import.run");
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") === "commit" ? "commit" : "preview";

  try {
    return mode === "commit" ? await commit(req, gate) : await preview(req, gate);
  } catch (e) {
    console.error(`[import/requirements ${mode}]`, e?.message || e);
    return NextResponse.json(
      { error: e?.message || "The import failed. Nothing was saved." },
      { status: 500 }
    );
  }
}

async function preview(req, gate) {
  const form = await req.formData();
  const file = form.get("file");
  if (!file || typeof file.arrayBuffer !== "function") {
    return NextResponse.json({ error: "Attach the workbook file." }, { status: 400 });
  }
  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: "That file is over 10 MB. Is it the right one?" }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) {
    return NextResponse.json({ error: "That workbook has no sheets." }, { status: 400 });
  }

  // raw: true so a percent-formatted cell arrives as the fraction 0.0833
  // rather than the string "8%", which loses the decimals. parseCommercials
  // handles both shapes because a hand-kept sheet contains both.
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
    header: 1,
    raw: true,
    defval: "",
    blankrows: false,
  });

  const parsed = parseJobSheet(aoa);

  // Which clients already exist? The preview should say "adds 3 new clients",
  // not spring them on someone after the fact.
  const names = [...new Set(parsed.rows.map((r) => r.client.name))];
  const existing = names.length
    ? await prisma.client.findMany({ where: { name: { in: names } }, select: { name: true } })
    : [];
  const existingNames = new Set(existing.map((c) => c.name));

  return NextResponse.json({
    mode: "preview",
    sheetName,
    sheetNames: wb.SheetNames,
    headerRow: parsed.headerRow,
    unmatchedColumns: parsed.unmatched,
    summary: {
      ...parsed.summary,
      newClients: names.filter((n) => !existingNames.has(n)).length,
      existingClients: names.filter((n) => existingNames.has(n)).length,
    },
    rows: parsed.rows.map((r) => ({
      ...r,
      clientExists: existingNames.has(r.client.name),
    })),
    canSetFees: can(gate.user.role, "client.fees"),
  });
}

async function commit(req, gate) {
  const body = await req.json().catch(() => ({}));
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const filename = String(body.filename || "workbook.xlsx");

  if (rows.length === 0) {
    return NextResponse.json({ error: "No rows to import." }, { status: 400 });
  }
  if (rows.length > 2000) {
    return NextResponse.json({ error: "Too many rows in one import. Split the file." }, { status: 400 });
  }

  const canFees = can(gate.user.role, "client.fees");
  const errors = [];
  let clientsCreated = 0;
  let requirementsCreated = 0;

  // One transaction: either the whole sheet lands or none of it does. A
  // half-imported sheet is worse than a failed one — you cannot tell by looking
  // which openings made it, so the only safe move is to re-import and now you
  // have duplicates.
  await prisma.$transaction(
    async (tx) => {
      const clientIdByName = new Map();

      for (const row of rows) {
        const name = String(row?.client?.name || "").trim();
        if (!name) {
          errors.push({ sourceRow: row?.sourceRow, error: "No company name" });
          continue;
        }

        let clientId = clientIdByName.get(name);
        if (!clientId) {
          let client = await tx.client.findUnique({ where: { name } });
          if (!client) {
            client = await tx.client.create({
              data: {
                name,
                hrName: row.client.hrName || null,
                city: row.client.city || null,
              },
            });
            clientsCreated++;
          } else if (row.client.hrName && !client.hrName) {
            // Fill a gap, never overwrite. Someone may have corrected the
            // contact by hand since the sheet was last touched.
            client = await tx.client.update({
              where: { id: client.id },
              data: { hrName: row.client.hrName },
            });
          }
          clientId = client.id;
          clientIdByName.set(name, clientId);
        }

        const r = row.requirement || {};
        const feeFields = canFees
          ? { feeType: r.feeType || null, feeBps: r.feeBps ?? null, feeFlat: r.feeFlat ?? null }
          : {};

        await tx.requirement.create({
          data: {
            clientId,
            designation: String(r.designation || "Not stated").slice(0, 200),
            domain: r.domain || null,
            processType: r.processType || null,
            processDetail: r.processDetail || null,
            location: String(r.location || "").slice(0, 120),
            openings: Number.isFinite(Number(r.openings)) && Number(r.openings) > 0 ? Math.round(Number(r.openings)) : 1,
            expMinMonths: numOrNull(r.expMinMonths),
            expMaxMonths: numOrNull(r.expMaxMonths),
            takeHomeMin: numOrNull(r.takeHomeMin),
            takeHomeMax: numOrNull(r.takeHomeMax),
            relievingRequired: !!r.relievingRequired,
            arrearsAllowed: r.arrearsAllowed !== false,
            educationMin: r.educationMin || null,
            docsRequired: r.docsRequired || null,
            cabFacility: ["none", "oneway", "twoway"].includes(r.cabFacility) ? r.cabFacility : "none",
            status: "open",
            createdById: gate.user.id,
            ...feeFields,
          },
        });
        requirementsCreated++;
      }

      await tx.importBatch.create({
        data: {
          kind: "requirements",
          filename,
          rowsTotal: rows.length,
          rowsOk: requirementsCreated,
          rowsFailed: errors.length,
          errorsJson: JSON.stringify(errors).slice(0, 20000),
          userId: gate.user.id,
        },
      });
    },
    { timeout: 45000 }
  );

  await prisma.auditLog
    .create({
      data: {
        userId: gate.user.id,
        action: "import",
        entity: "Requirement",
        summary: `Imported ${requirementsCreated} openings and ${clientsCreated} new clients from ${filename}`,
      },
    })
    .catch((e) => console.error("[import] audit write failed:", e?.message));

  return NextResponse.json({
    ok: true,
    clientsCreated,
    requirementsCreated,
    skipped: errors.length,
    errors: errors.slice(0, 50),
    feesImported: canFees,
  });
}

function numOrNull(v) {
  // Number(null) is 0, and Number("") is 0, and Number.isFinite(0) is true — so
  // the obvious version turned every unreadable cell into a hard zero. The
  // parser deliberately emits null for "As per market" and for blanks; a
  // takeHomeMax of 0 then reads as a real ceiling of nothing, which makes the
  // screening blocker below fire on every candidate and makes the call script
  // announce that the client takes freshers. Null means unknown and must stay
  // unknown. (The two sibling routes already guard this; this copy did not.)
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}
