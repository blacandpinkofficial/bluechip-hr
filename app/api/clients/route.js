// /api/clients — the companies Blue Chip recruits for.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability, can } from "@/lib/auth";
import { percentToBps, parseRupees } from "@/lib/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req) {
  const gate = await requireCapability("client.read");
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  const showInactive = url.searchParams.get("inactive") === "1";

  const where = {
    ...(showInactive ? {} : { active: true }),
    ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
  };

  const clients = await prisma.client.findMany({
    where,
    orderBy: { name: "asc" },
    include: {
      _count: { select: { requirements: true, placements: true } },
      requirements: { where: { status: "open" }, select: { openings: true } },
    },
  });

  // Commercials are owner-only. A manager can see the client list and every
  // opening; what they must not see is the rate. Stripping it here rather than
  // hiding it in the UI is the difference between a rule and a suggestion.
  const showFees = can(gate.user.role, "client.fees");

  return NextResponse.json({
    clients: clients.map((c) => ({
      id: c.id,
      name: c.name,
      hrName: c.hrName,
      hrPhone: c.hrPhone,
      hrEmail: c.hrEmail,
      city: c.city,
      active: c.active,
      paymentDays: c.paymentDays,
      requirementCount: c._count.requirements,
      placementCount: c._count.placements,
      openOpenings: c.requirements.reduce((n, r) => n + (r.openings || 0), 0),
      ...(showFees
        ? { feeType: c.feeType, feeBps: c.feeBps, feeFlat: c.feeFlat }
        : {}),
    })),
    canSeeFees: showFees,
  });
}

export async function POST(req) {
  const gate = await requireCapability("client.write");
  if (!gate.ok) return gate.response;

  try {
    const b = await req.json().catch(() => ({}));
    const name = String(b.name || "").trim();
    if (!name) {
      return NextResponse.json({ error: "A company name is required." }, { status: 400 });
    }

    const existing = await prisma.client.findUnique({ where: { name } });
    if (existing) {
      return NextResponse.json(
        { error: `"${name}" is already on the list.`, clientId: existing.id },
        { status: 409 }
      );
    }

    // Only an owner may set commercials. A manager creating a client leaves
    // the rate unset, and the requirement screen says so plainly rather than
    // defaulting to something that would quietly bill wrong.
    const feeFields = {};
    if (can(gate.user.role, "client.fees")) {
      if (b.feeType === "percent") {
        const bps = percentToBps(b.feePercent ?? b.feeBps);
        if (bps == null) {
          return NextResponse.json(
            { error: "Enter the percentage as a number between 0 and 100, e.g. 8.33" },
            { status: 400 }
          );
        }
        feeFields.feeType = "percent";
        feeFields.feeBps = bps;
        feeFields.feeFlat = null;
      } else if (b.feeType === "flat") {
        const flat = parseRupees(b.feeFlat);
        if (flat == null) {
          return NextResponse.json(
            { error: 'Enter the fee as an amount, e.g. 8000 or "8k"' },
            { status: 400 }
          );
        }
        feeFields.feeType = "flat";
        feeFields.feeFlat = flat;
        feeFields.feeBps = null;
      }
    }

    const client = await prisma.client.create({
      data: {
        name,
        hrName: String(b.hrName || "").trim() || null,
        hrPhone: String(b.hrPhone || "").trim() || null,
        hrEmail: String(b.hrEmail || "").trim().toLowerCase() || null,
        city: String(b.city || "").trim() || null,
        paymentDays: Number.isFinite(Number(b.paymentDays)) ? Number(b.paymentDays) : 30,
        ...feeFields,
      },
    });

    await prisma.auditLog
      .create({
        data: {
          userId: gate.user.id,
          action: "create",
          entity: "Client",
          entityId: client.id,
          summary: `Added client ${client.name}`,
        },
      })
      .catch((e) => console.error("[clients] audit write failed:", e?.message));

    return NextResponse.json({ client }, { status: 201 });
  } catch (e) {
    console.error("[POST /api/clients]", e?.message || e);
    return NextResponse.json({ error: "Could not save the client." }, { status: 500 });
  }
}
