// GET /api/public/jobs — the openings Blue Chip is willing to show the world.
//
// Unauthenticated, so it is built as an allow-list rather than a filter: it
// selects the handful of fields that are safe to publish instead of loading the
// row and removing what isn't. A filter forgets a field the day someone adds
// one; an allow-list cannot.
//
// Commercials, the client's HR contact, internal notes and the candidate
// pipeline never leave the building.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const settings = await getSettings();
    if (!settings.careersEnabled) {
      return NextResponse.json({ enabled: false, jobs: [] }, { status: 200 });
    }

    const url = new URL(req.url);
    const q = (url.searchParams.get("q") || "").trim().slice(0, 80);
    const location = (url.searchParams.get("location") || "").trim().slice(0, 80);

    const rows = await prisma.requirement.findMany({
      where: {
        status: "open",
        publishOnline: true,
        ...(location ? { location: { contains: location, mode: "insensitive" } } : {}),
        ...(q ? {
          OR: [
            { designation: { contains: q, mode: "insensitive" } },
            { domain: { contains: q, mode: "insensitive" } },
            { processDetail: { contains: q, mode: "insensitive" } },
          ],
        } : {}),
      },
      orderBy: [{ priority: "desc" }, { openedAt: "desc" }],
      take: 100,
      select: {
        id: true, designation: true, domain: true, processType: true,
        location: true, openings: true, shift: true,
        expMinMonths: true, expMaxMonths: true,
        takeHomeMin: true, takeHomeMax: true,
        educationMin: true, relievingRequired: true, arrearsAllowed: true,
        cabFacility: true, openedAt: true,
        // The client's NAME is published; nothing else about them is. A
        // candidate needs to know who they'd work for.
        client: { select: { name: true } },
      },
    });

    return NextResponse.json({
      enabled: true,
      intro: settings.careersIntro || null,
      email: settings.careersEmail || null,
      company: settings.companyName,
      locations: [...new Set(rows.map((r) => r.location).filter(Boolean))].sort(),
      jobs: rows.map((r) => ({ ...r, clientName: r.client?.name || null, client: undefined })),
    });
  } catch (e) {
    console.error("[GET /api/public/jobs]", e?.message || e);
    return NextResponse.json({ enabled: false, jobs: [], error: "Unavailable" }, { status: 500 });
  }
}
