// GET /api/leads — the website enquiry queue.
//
// Gated on requirement.write, which is the same capability that decides who may
// create an opening. That is the point: approving a lead CREATES an opening, so
// anyone who can read this queue is someone who could have typed the opening in
// by hand anyway. A recruiter holds requirement.read but not .write and does not
// see this screen at all.
//
// Everything a lead carries was typed by a stranger, so the fields come back as
// stored and the screen renders them as text. Nothing here is interpolated into
// markup anywhere.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability, can } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = ["new", "contacted", "approved", "rejected", "spam"];

export async function GET(req) {
  const gate = await requireCapability("requirement.write");
  if (!gate.ok) return gate.response;

  try {
    const url = new URL(req.url);
    const status = url.searchParams.get("status") || "open";

    // "open" is the default view and is not a stored status — it is the two
    // that still need someone: new and contacted. A queue that opens showing
    // every lead ever received is a queue nobody works.
    const where =
      status === "all"
        ? {}
        : status === "open"
        ? { status: { in: ["new", "contacted"] } }
        : STATUSES.includes(status)
        ? { status }
        : { status: { in: ["new", "contacted"] } };

    const rows = await prisma.requirementLead.findMany({
      where,
      orderBy: [{ createdAt: "desc" }],
      take: 300,
      select: {
        id: true,
        companyName: true,
        contactName: true,
        phone: true,
        email: true,
        city: true,
        designation: true,
        openings: true,
        expMinMonths: true,
        expMaxMonths: true,
        budgetMin: true,
        budgetMax: true,
        shift: true,
        jobDescription: true,
        status: true,
        notes: true,
        ip: true,
        userAgent: true,
        reviewedAt: true,
        requirementId: true,
        createdAt: true,
        reviewedBy: { select: { name: true } },
        requirement: { select: { id: true, designation: true, location: true } },
      },
    });

    const counts = await prisma.requirementLead
      .groupBy({ by: ["status"], _count: { _all: true } })
      .catch(() => []);

    // The client list for the approve form. Only id and name — this screen has
    // no business knowing a client's commercials, and a select that fetched the
    // whole row would put feeBps into a JSON response read by a team leader who
    // does not hold client.fees.
    let clients = [];
    if (can(gate.user.role, "client.read")) {
      clients = await prisma.client.findMany({
        where: { active: true },
        orderBy: { name: "asc" },
        take: 500,
        select: { id: true, name: true },
      });
    }

    return NextResponse.json({
      leads: rows.map((r) => ({
        ...r,
        reviewedByName: r.reviewedBy?.name || null,
        reviewedBy: undefined,
      })),
      clients,
      counts: (Array.isArray(counts) ? counts : []).reduce((acc, c) => {
        acc[c.status] = c._count?._all || 0;
        return acc;
      }, {}),
      // Creating a client from a lead is a client.write act. The screen needs
      // to know whether to offer it, rather than offering a control that would
      // only ever come back 403.
      canCreateClient: can(gate.user.role, "client.write"),
    });
  } catch (e) {
    console.error("[GET /api/leads]", e?.message || e);
    return NextResponse.json({ error: "Could not load the enquiry queue." }, { status: 500 });
  }
}
