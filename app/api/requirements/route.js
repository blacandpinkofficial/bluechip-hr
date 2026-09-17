// /api/requirements — the openings Blue Chip is recruiting for.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability, can } from "@/lib/auth";
import { resolveFee, describeFee } from "@/lib/fees";
import { percentToBps, parseRupees } from "@/lib/money";
import { pageParams, pageMeta } from "@/lib/paging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req) {
  const gate = await requireCapability("requirement.read");
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const status = url.searchParams.get("status") || "open";
  const clientId = url.searchParams.get("client") || undefined;
  const location = (url.searchParams.get("location") || "").trim();
  const q = (url.searchParams.get("q") || "").trim();

  const where = {
    ...(status === "all" ? {} : { status }),
    ...(clientId ? { clientId } : {}),
    ...(location ? { location: { contains: location, mode: "insensitive" } } : {}),
    ...(q
      ? {
          OR: [
            { designation: { contains: q, mode: "insensitive" } },
            { domain: { contains: q, mode: "insensitive" } },
            { processDetail: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const { take, skip } = pageParams(url);

  const rows = await prisma.requirement.findMany({
    where,
    // id last — see the note in app/api/candidates/route.js. openedAt
    // defaults to now(), so a sheet imported in one go ties on every row.
    orderBy: [{ status: "asc" }, { openedAt: "desc" }, { id: "asc" }],
    include: {
      client: true,
      _count: { select: { candidates: true, interviews: true, placements: true } },
    },
    take,
    skip,
  });

  const totalCount = await prisma.requirement.count({ where });

  const showFees = can(gate.user.role, "client.fees");
  // The screen needs to know whether to offer the row actions at all. A
  // recruiter can read this list but must not be shown an Edit button that
  // would only ever come back 403.
  const showWrite = can(gate.user.role, "requirement.write");

  return NextResponse.json({
    ...pageMeta({ take, skip, totalCount, rows }),
    requirements: rows.map((r) => {
      const fee = resolveFee(r, r.client);
      return {
        id: r.id,
        clientId: r.clientId,
        clientName: r.client?.name || "—",
        designation: r.designation,
        domain: r.domain,
        processType: r.processType,
        processDetail: r.processDetail,
        location: r.location,
        openings: r.openings,
        expMinMonths: r.expMinMonths,
        expMaxMonths: r.expMaxMonths,
        takeHomeMin: r.takeHomeMin,
        takeHomeMax: r.takeHomeMax,
        shift: r.shift,
        relievingRequired: r.relievingRequired,
        arrearsAllowed: r.arrearsAllowed,
        educationMin: r.educationMin,
        docsRequired: r.docsRequired,
        cabFacility: r.cabFacility,
        notes: r.notes,
        status: r.status,
        priority: r.priority,
        publishOnline: r.publishOnline,
        openedAt: r.openedAt,
        closedAt: r.closedAt,
        candidateCount: r._count.candidates,
        interviewCount: r._count.interviews,
        placedCount: r._count.placements,
        // Everyone sees WHETHER terms are set — a recruiter needs to know an
        // opening cannot be billed. Only an owner sees what they are.
        hasFee: fee.feeType != null,
        feeSource: fee.source,
        ...(showFees
          ? { feeType: fee.feeType, feeBps: fee.feeBps, feeFlat: fee.feeFlat, feeLabel: describeFee(fee) }
          : {}),
      };
    }),
    canSeeFees: showFees,
    canWrite: showWrite,
  });
}

export async function POST(req) {
  const gate = await requireCapability("requirement.write");
  if (!gate.ok) return gate.response;

  try {
    const b = await req.json().catch(() => ({}));

    const clientId = String(b.clientId || "").trim();
    const designation = String(b.designation || "").trim();
    const location = String(b.location || "").trim();

    if (!clientId) return NextResponse.json({ error: "Choose a client." }, { status: 400 });
    if (!designation) return NextResponse.json({ error: "Enter the designation." }, { status: 400 });
    if (!location) return NextResponse.json({ error: "Enter the location." }, { status: 400 });

    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client) return NextResponse.json({ error: "That client no longer exists." }, { status: 404 });

    let openings = Number(b.openings);
    if (!Number.isFinite(openings) || openings < 1) openings = 1;

    // Per-opening commercials override the client's house rate. Owner-only,
    // same as the client rate — a one-off rate is still a rate.
    const feeFields = {};
    if (can(gate.user.role, "client.fees") && b.feeType) {
      if (b.feeType === "percent") {
        const bps = percentToBps(b.feePercent ?? b.feeBps);
        if (bps == null) {
          return NextResponse.json({ error: "Percentage must be between 0 and 100." }, { status: 400 });
        }
        feeFields.feeType = "percent";
        feeFields.feeBps = bps;
      } else if (b.feeType === "flat") {
        const flat = parseRupees(b.feeFlat);
        if (flat == null) {
          return NextResponse.json({ error: 'Enter an amount, e.g. 8000 or "8k".' }, { status: 400 });
        }
        feeFields.feeType = "flat";
        feeFields.feeFlat = flat;
      }
    }

    const created = await prisma.requirement.create({
      data: {
        clientId,
        designation,
        location,
        openings,
        domain: String(b.domain || "").trim() || null,
        processType: b.processType || null,
        processDetail: String(b.processDetail || "").trim() || null,
        expMinMonths: intOrNull(b.expMinMonths),
        expMaxMonths: intOrNull(b.expMaxMonths),
        takeHomeMin: parseRupees(b.takeHomeMin),
        takeHomeMax: parseRupees(b.takeHomeMax),
        shift: String(b.shift || "").trim() || null,
        relievingRequired: !!b.relievingRequired,
        arrearsAllowed: b.arrearsAllowed !== false,
        educationMin: String(b.educationMin || "").trim() || null,
        docsRequired: String(b.docsRequired || "").trim() || null,
        cabFacility: ["none", "oneway", "twoway"].includes(b.cabFacility) ? b.cabFacility : "none",
        priority: ["low", "normal", "high"].includes(b.priority) ? b.priority : "normal",
        notes: String(b.notes || "").trim() || null,
        createdById: gate.user.id,
        ...feeFields,
      },
      include: { client: true },
    });

    await prisma.auditLog
      .create({
        data: {
          userId: gate.user.id,
          action: "create",
          entity: "Requirement",
          entityId: created.id,
          summary: `${created.designation} × ${created.openings} for ${created.client.name} (${created.location})`,
        },
      })
      .catch((e) => console.error("[requirements] audit write failed:", e?.message));

    return NextResponse.json({ requirement: created }, { status: 201 });
  } catch (e) {
    console.error("[POST /api/requirements]", e?.message || e);
    return NextResponse.json({ error: "Could not save the requirement." }, { status: 500 });
  }
}

function intOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}
