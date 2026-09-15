// POST /api/leads/[id]/approve — the one door from public input into Requirement.
//
// Nothing a stranger types reaches the table the desk works from except through
// here, and only when a person holding requirement.write presses a button. Three
// properties this route has to have, and the reasons they are not obvious:
//
//   1. A lead converts ONCE. Not "usually once" — a double click, a retried
//      request or two managers on the same queue at the same moment must not
//      produce two openings. So the lead is CLAIMED by a conditional update
//      inside a transaction before the opening is created, and
//      RequirementLead.requirementId carries a unique index as the backstop.
//
//   2. The values written are the ones in the REQUEST, not the ones in the
//      lead. The reviewer edits the pre-filled form before approving, and a
//      route that re-read the lead would silently discard their corrections and
//      write the stranger's numbers instead. The lead's text is the draft; the
//      human's version is the record.
//
//   3. publishOnline is forced false, and is not read from the body at all.
//      Otherwise the path from "anonymous form submission" to "listing on the
//      public internet" would be one mistyped checkbox long.
//
// Commercials are not settable here either. An approved lead starts with no fee
// terms and inherits the client's; a rate is agreed on a call and typed in on
// /requirements by someone holding client.fees, which a team leader does not.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability, can } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req, { params }) {
  const gate = await requireCapability("requirement.write");
  if (!gate.ok) return gate.response;

  try {
    const id = String(params?.id || "").slice(0, 40);
    if (!id) return NextResponse.json({ error: "Which enquiry?" }, { status: 400 });

    const b = await req.json().catch(() => ({}));

    const lead = await prisma.requirementLead.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        requirementId: true,
        companyName: true,
        contactName: true,
        phone: true,
        email: true,
        city: true,
      },
    });
    if (!lead) return NextResponse.json({ error: "That enquiry no longer exists." }, { status: 404 });
    if (lead.requirementId || lead.status === "approved") {
      return NextResponse.json(
        { error: "This enquiry has already been turned into an opening." },
        { status: 409 }
      );
    }

    const designation = String(b.designation || "").trim().slice(0, 160);
    const location = String(b.location || "").trim().slice(0, 160);
    if (!designation) return NextResponse.json({ error: "Enter the designation." }, { status: 400 });
    if (!location) return NextResponse.json({ error: "Enter the location." }, { status: 400 });

    // Either an existing client the reviewer picked, or a new one created from
    // the enquiry. The second is a client.write act and is checked as one: a
    // role that may open requirements but not create clients is refused here
    // rather than given a client row it was not allowed to make. The check is
    // done before the transaction; the writing is done inside it.
    const pickedClientId = String(b.clientId || "").trim().slice(0, 40);
    const newClientName = String(b.newClientName || lead.companyName || "").trim().slice(0, 160);

    if (!pickedClientId) {
      if (!can(gate.user.role, "client.write")) {
        return NextResponse.json(
          { error: "Choose an existing client — you don't have access to create a new one." },
          { status: 403 }
        );
      }
      if (!newClientName) {
        return NextResponse.json({ error: "Choose or name a client." }, { status: 400 });
      }
    }

    let openings = Number(b.openings);
    if (!Number.isFinite(openings) || openings < 1) openings = 1;
    openings = Math.min(Math.round(openings), 999);

    const created = await prisma.$transaction(async (tx) => {
      // Claim the lead FIRST, before anything is created. The WHERE is the lock:
      // only a lead that is still unconverted matches, so a second request
      // racing this one updates zero rows and is told so, rather than creating a
      // duplicate opening. Claiming first is also why a lost race leaves nothing
      // behind — no half-made client, no orphan requirement.
      const claim = await tx.requirementLead.updateMany({
        where: { id, requirementId: null, status: { not: "approved" } },
        data: {
          status: "approved",
          reviewedById: gate.user.id,
          reviewedAt: new Date(),
          ...(b.notes !== undefined
            ? { notes: String(b.notes || "").trim().slice(0, 2000) || null }
            : {}),
        },
      });
      if (claim.count === 0) {
        const err = new Error("ALREADY_CONVERTED");
        err.code = "ALREADY_CONVERTED";
        throw err;
      }

      let clientId = pickedClientId;
      if (clientId) {
        const exists = await tx.client.findUnique({
          where: { id: clientId },
          select: { id: true },
        });
        if (!exists) {
          const err = new Error("NO_CLIENT");
          err.code = "NO_CLIENT";
          throw err;
        }
      } else {
        // Client.name is unique, so upsert rather than create: a second enquiry
        // from a company already on the books attaches to that company instead
        // of failing on the constraint. The update block is empty on purpose —
        // an enquiry must not be able to rewrite an existing client's details,
        // only to fill in a brand new row.
        const client = await tx.client.upsert({
          where: { name: newClientName },
          update: {},
          create: {
            name: newClientName,
            city: lead.city || null,
            hrName: lead.contactName || null,
            hrPhone: lead.phone || null,
            hrEmail: lead.email || null,
          },
          select: { id: true },
        });
        clientId = client.id;
      }

      const requirement = await tx.requirement.create({
        data: {
          clientId,
          designation,
          location,
          openings,
          domain: str(b.domain, 160),
          processType: ["voice", "non-voice", "semi-voice"].includes(b.processType)
            ? b.processType
            : null,
          processDetail: str(b.processDetail, 2000),
          expMinMonths: intOrNull(b.expMinMonths, 600),
          expMaxMonths: intOrNull(b.expMaxMonths, 600),
          takeHomeMin: rupeesOrNull(b.takeHomeMin),
          takeHomeMax: rupeesOrNull(b.takeHomeMax),
          shift: str(b.shift, 60),
          educationMin: str(b.educationMin, 200),
          relievingRequired: !!b.relievingRequired,
          arrearsAllowed: b.arrearsAllowed !== false,
          cabFacility: ["none", "oneway", "twoway"].includes(b.cabFacility) ? b.cabFacility : "none",
          priority: ["low", "normal", "high"].includes(b.priority) ? b.priority : "normal",
          notes: str(b.notes, 2000),
          createdById: gate.user.id,
          // Never from the body. An approved enquiry is an internal opening
          // until somebody opens /requirements and decides to publish it.
          publishOnline: false,
          status: "open",
        },
        select: { id: true, designation: true, location: true, openings: true },
      });

      await tx.requirementLead.update({
        where: { id },
        data: { requirementId: requirement.id },
      });

      return requirement;
    });

    await prisma.auditLog
      .create({
        data: {
          userId: gate.user.id,
          action: "create",
          entity: "Requirement",
          entityId: created.id,
          summary: `Approved website enquiry from ${lead.companyName}: ${created.designation} × ${created.openings} (${created.location})`,
        },
      })
      .catch((e) => console.error("[leads] audit write failed:", e?.message));

    return NextResponse.json({ requirement: created }, { status: 201 });
  } catch (e) {
    if (e?.code === "ALREADY_CONVERTED") {
      return NextResponse.json(
        { error: "This enquiry has already been turned into an opening." },
        { status: 409 }
      );
    }
    if (e?.code === "NO_CLIENT") {
      return NextResponse.json({ error: "That client no longer exists." }, { status: 404 });
    }
    // The unique index on RequirementLead.requirementId, doing its job if the
    // claim above ever fails to.
    if (e?.code === "P2002") {
      return NextResponse.json(
        { error: "This enquiry has already been turned into an opening." },
        { status: 409 }
      );
    }
    console.error("[POST /api/leads/:id/approve]", e?.message || e);
    return NextResponse.json({ error: "Could not create the opening." }, { status: 500 });
  }
}

// ── helpers, none exported ──────────────────────────────────────────────────

function str(v, max) {
  const s = String(v == null ? "" : v).trim().slice(0, max);
  return s || null;
}

function intOrNull(v, max) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n) : null;
}

function rupeesOrNull(v) {
  const n = Number(String(v == null ? "" : v).replace(/[₹,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 && n <= 10000000 ? Math.round(n) : null;
}
