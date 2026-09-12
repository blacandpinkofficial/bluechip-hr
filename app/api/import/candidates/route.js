// POST /api/import/candidates
//
// Reads the Excel/CSV file Naukri or Monster gives you when you tick candidates
// and press Download. That export is the supported way to get this data out; it
// is what the subscription is for. There is no scraping in this app and there
// should never be — both portals forbid it, and a banned account takes the
// desk's whole sourcing pipeline with it.
//
// Two passes, same as the requirements import:
//   mode=preview   nothing is written; you see every row and every problem
//   mode=commit    only the rows a human approved are saved
//
// The match key is the phone number. A candidate already in the database is
// UPDATED, never duplicated — two rows for one person means two recruiters
// ringing them about the same job, which is how a client stops taking the call.
import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/auth";
import { parsePortalExport } from "@/lib/importCandidates";

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
    console.error(`[import/candidates ${mode}]`, e?.message || e);
    return NextResponse.json(
      { error: e?.message || "The import failed. Nothing was saved." },
      { status: 500 }
    );
  }
}

async function preview(req) {
  const form = await req.formData();
  const file = form.get("file");
  if (!file || typeof file.arrayBuffer !== "function") {
    return NextResponse.json({ error: "Choose a file first." }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > 15 * 1024 * 1024) {
    return NextResponse.json({ error: "That file is over 15 MB. Export it in two halves." }, { status: 400 });
  }

  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return NextResponse.json({ error: "That file has no sheets in it." }, { status: 400 });

  // raw: true so a mobile column that was formatted as a number arrives as the
  // number it became — which is exactly the case the parser has to detect and
  // refuse, rather than a rounded string it cannot tell from a real one.
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: "" });

  const parsed = parsePortalExport(aoa, {
    defaultSource: String(form.get("source") || "") || undefined,
  });

  // Which of these people are already on the books, so the preview can say
  // "update" or "new" per row rather than after the fact.
  const phones = parsed.rows.map((r) => r.candidate.phone).filter(Boolean);
  const existing = phones.length
    ? await prisma.candidate.findMany({
        where: { phone: { in: phones } },
        select: { id: true, phone: true, name: true, stage: true, owner: { select: { name: true } } },
      })
    : [];
  const known = new Map(existing.map((c) => [c.phone, c]));

  const rows = parsed.rows.map((r) => {
    const match = r.candidate.phone ? known.get(r.candidate.phone) : null;
    return {
      ...r,
      existing: match
        ? { id: match.id, name: match.name, stage: match.stage, owner: match.owner?.name || null }
        : null,
      action: !r.usable ? "skip" : match ? "update" : "create",
    };
  });

  return NextResponse.json({
    filename: file.name || "export.xlsx",
    sheetName,
    source: parsed.source,
    unmatchedHeaders: parsed.unmatched,
    rows,
    summary: {
      ...parsed.summary,
      alreadyOnBooks: rows.filter((r) => r.existing).length,
      newPeople: rows.filter((r) => r.action === "create").length,
    },
  });
}

async function commit(req, gate) {
  const body = await req.json().catch(() => ({}));
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const filename = String(body.filename || "export.xlsx");
  const requirementId = body.requirementId ? String(body.requirementId) : null;
  // Unassigned by default. Auto-assigning a hundred imported candidates to
  // whoever ran the import puts them all in one person's follow-up list, and
  // nobody calls a list of a hundred.
  const ownerId = body.ownerId ? String(body.ownerId) : null;

  if (!rows.length) return NextResponse.json({ error: "No rows to import." }, { status: 400 });

  if (requirementId) {
    const exists = await prisma.requirement.findUnique({ where: { id: requirementId }, select: { id: true } });
    if (!exists) return NextResponse.json({ error: "That opening does not exist." }, { status: 400 });
  }

  let created = 0;
  let updated = 0;
  const errors = [];

  for (const r of rows) {
    const c = r?.candidate || {};
    const phone = String(c.phone || "").trim();
    if (!phone || !c.name) {
      errors.push({ row: r?.sourceRow, error: "No usable name or phone." });
      continue;
    }

    try {
      const existing = await prisma.candidate.findUnique({ where: { phone } });

      if (existing) {
        // Fill gaps; never overwrite. Someone on this desk spoke to this person
        // and typed what they learned — a portal profile last touched eight
        // months ago must not flatten that.
        await prisma.candidate.update({
          where: { id: existing.id },
          data: {
            email: existing.email || c.email || null,
            location: existing.location || c.location || null,
            designation: existing.designation || c.designation || null,
            expMonths: existing.expMonths ?? c.expMonths ?? null,
            noticeDays: existing.noticeDays ?? c.noticeDays ?? null,
            skills: existing.skills || c.skills || null,
            education: existing.education || c.education || null,
            altPhone: existing.altPhone || c.altPhone || null,
            // The requirement IS updated: re-importing against a new opening is
            // usually the reason someone is importing them again.
            requirementId: requirementId || existing.requirementId,
          },
        });
        updated += 1;
      } else {
        await prisma.candidate.create({
          data: {
            name: c.name,
            phone,
            altPhone: c.altPhone || null,
            email: c.email || null,
            location: c.location || null,
            designation: c.designation || null,
            expMonths: c.expMonths ?? null,
            noticeDays: c.noticeDays ?? null,
            skills: c.skills || null,
            education: c.education || null,
            source: c.source || "naukri",
            status: c.status || null,
            stage: "new",
            requirementId,
            ownerId,
          },
        });
        created += 1;
      }
    } catch (e) {
      // The unique constraint on phone is the likely one, if two approved rows
      // carry the same number. Reported per row, not fatal for the batch.
      errors.push({ row: r?.sourceRow, error: e?.message || "Could not save this row." });
    }
  }

  const batch = await prisma.importBatch.create({
    data: {
      kind: "candidates",
      filename,
      rowsTotal: rows.length,
      rowsOk: created + updated,
      rowsFailed: errors.length,
      errorsJson: JSON.stringify(errors.slice(0, 100)),
      userId: gate.user.id,
    },
  });

  return NextResponse.json({
    batchId: batch.id,
    created,
    updated,
    failed: errors.length,
    errors: errors.slice(0, 50),
    message:
      `${created} new ${created === 1 ? "candidate" : "candidates"}, ${updated} updated` +
      (errors.length ? `, ${errors.length} could not be saved.` : "."),
  });
}
