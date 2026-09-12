// PATCH /api/requirements/[id] — edit an opening, including whether it is
// published to the public careers page.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability, can } from "@/lib/auth";
import { percentToBps, parseRupees } from "@/lib/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = ["open", "hold", "filled", "closed"];

export async function PATCH(req, { params }) {
  const gate = await requireCapability("requirement.write");
  if (!gate.ok) return gate.response;

  try {
    const id = params?.id;
    const existing = await prisma.requirement.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "No such requirement." }, { status: 404 });

    const b = await req.json().catch(() => ({}));
    const data = {};

    if (b.designation !== undefined && String(b.designation).trim()) data.designation = String(b.designation).trim();
    if (b.location !== undefined && String(b.location).trim()) data.location = String(b.location).trim();
    if (b.domain !== undefined) data.domain = String(b.domain || "").trim() || null;
    if (b.processType !== undefined) data.processType = b.processType || null;
    if (b.processDetail !== undefined) data.processDetail = String(b.processDetail || "").trim() || null;
    if (b.shift !== undefined) data.shift = String(b.shift || "").trim() || null;
    if (b.notes !== undefined) data.notes = String(b.notes || "").trim() || null;
    if (b.educationMin !== undefined) data.educationMin = String(b.educationMin || "").trim() || null;
    if (b.docsRequired !== undefined) data.docsRequired = String(b.docsRequired || "").trim() || null;

    if (b.openings !== undefined) {
      const n = Number(b.openings);
      data.openings = Number.isFinite(n) && n > 0 ? Math.round(n) : 1;
    }
    if (b.expMinMonths !== undefined) data.expMinMonths = numOrNull(b.expMinMonths);
    if (b.expMaxMonths !== undefined) data.expMaxMonths = numOrNull(b.expMaxMonths);
    if (b.takeHomeMin !== undefined) data.takeHomeMin = parseRupees(b.takeHomeMin);
    if (b.takeHomeMax !== undefined) data.takeHomeMax = parseRupees(b.takeHomeMax);

    if (b.relievingRequired !== undefined) data.relievingRequired = !!b.relievingRequired;
    if (b.arrearsAllowed !== undefined) data.arrearsAllowed = !!b.arrearsAllowed;
    if (b.cabFacility !== undefined && ["none", "oneway", "twoway"].includes(b.cabFacility)) {
      data.cabFacility = b.cabFacility;
    }

    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) {
        return NextResponse.json({ error: `Unknown status "${b.status}".` }, { status: 400 });
      }
      data.status = b.status;
      if (b.status !== "open" && !existing.closedAt) data.closedAt = new Date();
      if (b.status === "open") data.closedAt = null;
      // An opening that is no longer open must leave the careers page with it.
      // Otherwise a filled role keeps collecting applications that nobody wants
      // and candidates get called about a job that does not exist.
      if (b.status !== "open") data.publishOnline = false;
    }

    if (b.publishOnline !== undefined) {
      if (b.publishOnline && (data.status || existing.status) !== "open") {
        return NextResponse.json(
          { error: "Only an open requirement can be published to the careers page." },
          { status: 400 }
        );
      }
      data.publishOnline = !!b.publishOnline;
    }

    // Commercials stay owner-only, here as everywhere else.
    if (can(gate.user.role, "client.fees")) {
      if (b.feeType === "percent") {
        const bps = percentToBps(b.feePercent ?? b.feeBps);
        if (bps == null) return NextResponse.json({ error: "Percentage must be between 0 and 100." }, { status: 400 });
        data.feeType = "percent"; data.feeBps = bps; data.feeFlat = null;
      } else if (b.feeType === "flat") {
        const flat = parseRupees(b.feeFlat);
        if (flat == null) return NextResponse.json({ error: 'Enter an amount, e.g. 8000 or "8k".' }, { status: 400 });
        data.feeType = "flat"; data.feeFlat = flat; data.feeBps = null;
      } else if (b.feeType === null || b.feeType === "") {
        data.feeType = null; data.feeBps = null; data.feeFlat = null;
      }
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }

    const updated = await prisma.requirement.update({ where: { id }, data });

    if (data.publishOnline !== undefined && data.publishOnline !== existing.publishOnline) {
      await prisma.auditLog
        .create({
          data: {
            userId: gate.user.id, action: "update", entity: "Requirement", entityId: id,
            summary: `${existing.designation}: ${data.publishOnline ? "published to" : "removed from"} the careers page`,
          },
        })
        .catch((e) => console.error("[requirement patch] audit write failed:", e?.message));
    }

    return NextResponse.json({ requirement: updated });
  } catch (e) {
    console.error("[PATCH /api/requirements/[id]]", e?.message || e);
    return NextResponse.json({ error: "Could not save the change." }, { status: 500 });
  }
}

function numOrNull(v) {
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}
