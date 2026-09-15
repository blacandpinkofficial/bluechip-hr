// PATCH /api/leads/[id] — triage one website enquiry.
//
// The three cheap verdicts: this is real and I have called them (contacted),
// this is real and we are not doing it (rejected), this is not real (spam).
// The fourth verdict — approve — is a different route, because it writes to
// Requirement and this one must never be able to.
//
// Gated on requirement.write, the same capability as the queue itself.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "approved" is deliberately not here. A lead becomes approved only by going
// through /api/leads/[id]/approve, which is the only code in the application
// that turns public input into a Requirement. Letting this route set the word
// would let someone mark a lead approved without an opening ever existing, and
// the queue would then lie about what had been done.
const SETTABLE = ["new", "contacted", "rejected", "spam"];

export async function PATCH(req, { params }) {
  const gate = await requireCapability("requirement.write");
  if (!gate.ok) return gate.response;

  try {
    const id = String(params?.id || "").slice(0, 40);
    if (!id) return NextResponse.json({ error: "Which enquiry?" }, { status: 400 });

    const b = await req.json().catch(() => ({}));

    const lead = await prisma.requirementLead.findUnique({
      where: { id },
      select: { id: true, status: true, requirementId: true },
    });
    if (!lead) return NextResponse.json({ error: "That enquiry no longer exists." }, { status: 404 });

    const data = {};

    if (b.status !== undefined) {
      const status = String(b.status || "");
      if (!SETTABLE.includes(status)) {
        return NextResponse.json({ error: "That is not a status this screen can set." }, { status: 400 });
      }
      // An approved lead has an opening hanging off it. Moving it back to
      // "rejected" would leave a live Requirement whose origin claims it was
      // never wanted, so the status is frozen once it has been converted. The
      // opening itself can still be closed on /requirements, which is where
      // that decision belongs.
      if (lead.requirementId || lead.status === "approved") {
        return NextResponse.json(
          { error: "This enquiry has already become an opening. Close the opening instead." },
          { status: 409 }
        );
      }
      data.status = status;
      data.reviewedById = gate.user.id;
      data.reviewedAt = new Date();
    }

    if (b.notes !== undefined) {
      // An internal note, written by staff, read only by staff. Capped so one
      // paste cannot put a megabyte in the row.
      data.notes = String(b.notes || "").trim().slice(0, 2000) || null;
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
    }

    const updated = await prisma.requirementLead.update({
      where: { id },
      data,
      select: { id: true, status: true, notes: true, reviewedAt: true },
    });

    if (data.status) {
      await prisma.auditLog
        .create({
          data: {
            userId: gate.user.id,
            action: "update",
            entity: "RequirementLead",
            entityId: id,
            summary: `Website enquiry marked ${data.status}`,
          },
        })
        .catch((e) => console.error("[leads] audit write failed:", e?.message));
    }

    return NextResponse.json({ lead: updated });
  } catch (e) {
    console.error("[PATCH /api/leads/:id]", e?.message || e);
    return NextResponse.json({ error: "Could not update the enquiry." }, { status: 500 });
  }
}
