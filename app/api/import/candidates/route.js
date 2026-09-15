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
//
// A batch is imported AGAINST AN OPENING: a telecaller is handed a requirement
// by their team leader and imports the list for it, so every row lands with
// that requirementId and with the importer as owner. The one case that is never
// decided automatically is a candidate already sitting against a DIFFERENT
// opening — see commit() below.
//
// GET on this same path hands back the blank template to fill in.
import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/auth";
import {
  parsePortalExport,
  SAMPLE_CANDIDATE_TEMPLATE,
  sampleTemplateAoa,
} from "@/lib/importCandidates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/import/candidates — the blank sheet to copy.
//
// Built here rather than served as a static file so that the headers in the
// download are the headers the parser accepts, always: both come from
// SAMPLE_CANDIDATE_TEMPLATE in lib/importCandidates.js. A stale template in
// public/ is worse than none — it teaches column names that stopped working.
export async function GET() {
  const gate = await requireCapability("import.candidates");
  if (!gate.ok) return gate.response;

  try {
    const ws = XLSX.utils.aoa_to_sheet(sampleTemplateAoa());
    ws["!cols"] = SAMPLE_CANDIDATE_TEMPLATE.headers.map((h) => ({ wch: Math.max(16, h.length + 4) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, SAMPLE_CANDIDATE_TEMPLATE.sheetName);
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    return new NextResponse(buf, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${SAMPLE_CANDIDATE_TEMPLATE.filename}"`,
        "Content-Length": String(buf.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    console.error("[GET /api/import/candidates]", e?.message || e);
    return NextResponse.json({ error: "Could not build the sample file." }, { status: 500 });
  }
}

export async function POST(req) {
  const gate = await requireCapability("import.candidates");
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

  // Which opening this batch is being called for. Optional — a general
  // database top-up has no opening — but the screen asks for it first, because
  // a hundred candidates with no opening attached cannot be screened and the
  // call screen has nothing to pitch them.
  const requirementId = String(form.get("requirementId") || "").trim() || null;
  let requirement = null;
  if (requirementId) {
    const r = await prisma.requirement.findUnique({
      where: { id: requirementId },
      select: {
        id: true, designation: true, location: true, status: true,
        client: { select: { name: true } },
      },
    });
    if (!r) return NextResponse.json({ error: "That opening does not exist." }, { status: 400 });
    requirement = {
      id: r.id,
      designation: r.designation,
      location: r.location,
      status: r.status,
      clientName: r.client?.name || null,
    };
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
        select: {
          id: true, phone: true, name: true, stage: true, requirementId: true,
          owner: { select: { name: true } },
          requirement: {
            select: { id: true, designation: true, location: true, client: { select: { name: true } } },
          },
        },
      })
    : [];
  const known = new Map(existing.map((c) => [c.phone, c]));

  const rows = parsed.rows.map((r) => {
    const match = r.candidate.phone ? known.get(r.candidate.phone) : null;

    // Four things can happen to a row, and the screen has to be able to say
    // which before anything is written:
    //   create   nobody on the books with this number
    //   link     already here, against no opening — this batch gives them one
    //   update   already here, against THIS opening — details filled in
    //   conflict already here, against SOMEONE ELSE'S opening
    // A conflict is never resolved silently. Moving a candidate off a live
    // opening loses whoever was working them; leaving them is also a decision.
    // So the row is shown, left unticked, and the person importing chooses.
    let action = "skip";
    if (r.usable) {
      if (!match) action = "create";
      else if (!requirementId) action = "update";
      else if (!match.requirementId) action = "link";
      else if (match.requirementId === requirementId) action = "update";
      else action = "conflict";
    }

    return {
      ...r,
      existing: match
        ? {
            id: match.id,
            name: match.name,
            stage: match.stage,
            owner: match.owner?.name || null,
            requirementId: match.requirementId || null,
            requirementLabel: match.requirement
              ? [
                  match.requirement.designation,
                  match.requirement.client?.name,
                  match.requirement.location,
                ].filter(Boolean).join(" · ")
              : null,
          }
        : null,
      action,
    };
  });

  return NextResponse.json({
    filename: file.name || "export.xlsx",
    sheetName,
    source: parsed.source,
    unmatchedHeaders: parsed.unmatched,
    requirement,
    rows,
    summary: {
      ...parsed.summary,
      alreadyOnBooks: rows.filter((r) => r.existing).length,
      newPeople: rows.filter((r) => r.action === "create").length,
      linked: rows.filter((r) => r.action === "link").length,
      conflicts: rows.filter((r) => r.action === "conflict").length,
    },
  });
}

async function commit(req, gate) {
  const body = await req.json().catch(() => ({}));
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const filename = String(body.filename || "export.xlsx");
  const requirementId = body.requirementId ? String(body.requirementId) : null;
  // A telecaller is handed an opening and imports the list for it, so the
  // batch belongs to whoever ran the import — they are the one who will dial
  // it. The screen can turn this off (assignToMe: false) when someone is
  // topping the database up for the desk rather than for themselves, because a
  // hundred candidates in one person's follow-up list is a list nobody calls.
  const ownerId = body.assignToMe === false
    ? (body.ownerId ? String(body.ownerId) : null)
    : gate.user.id;

  if (!rows.length) return NextResponse.json({ error: "No rows to import." }, { status: 400 });

  if (requirementId) {
    const exists = await prisma.requirement.findUnique({ where: { id: requirementId }, select: { id: true } });
    if (!exists) return NextResponse.json({ error: "That opening does not exist." }, { status: 400 });
  }

  let created = 0;
  let updated = 0;
  let linked = 0;
  let moved = 0;
  let keptOnTheirOpening = 0;
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
        // What happens to the opening this person is already against:
        //
        //   no opening yet        → linked to this batch's opening
        //   the same opening      → nothing to change
        //   a DIFFERENT opening   → LEFT WHERE IT IS, unless the person
        //                           importing ticked "move to this opening" on
        //                           that row in the preview.
        //
        // Silently re-pointing a candidate at a new opening loses the work
        // whoever had them was doing — their screening, their pitch, their
        // interview slot — and the first anyone knows of it is a client asking
        // why a CV was sent twice for two different roles.
        let nextRequirementId = existing.requirementId;
        if (requirementId) {
          if (!existing.requirementId) {
            nextRequirementId = requirementId;
            linked += 1;
          } else if (existing.requirementId === requirementId) {
            nextRequirementId = requirementId;
          } else if (r.moveRequirement === true) {
            nextRequirementId = requirementId;
            moved += 1;
          } else {
            keptOnTheirOpening += 1;
          }
        }

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
            requirementId: nextRequirementId,
            // An unowned candidate is claimed by whoever imported them, the
            // same way logging a call claims one. Somebody else's candidate is
            // never taken off them by an import.
            ownerId: existing.ownerId || ownerId,
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
      // carry the same number — or if someone else added this person between
      // the preview and the Import button. Reported per row, in words, and
      // never swallowed: a row that did not save must say so.
      const dupe = e?.code === "P2002";
      errors.push({
        row: r?.sourceRow,
        error: dupe
          ? `${phone} is already on the books — that number appears twice in this file, or someone added them while you were looking at the preview.`
          : e?.message || "Could not save this row.",
      });
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
    linked,
    moved,
    keptOnTheirOpening,
    requirementId,
    failed: errors.length,
    errors: errors.slice(0, 50),
    message:
      `${created} new ${created === 1 ? "candidate" : "candidates"}, ${updated} updated` +
      (linked ? `, ${linked} linked to this opening` : "") +
      (moved ? `, ${moved} moved across` : "") +
      (keptOnTheirOpening
        ? `, ${keptOnTheirOpening} left on the opening they were already against`
        : "") +
      (errors.length ? `, ${errors.length} could not be saved.` : "."),
  });
}
