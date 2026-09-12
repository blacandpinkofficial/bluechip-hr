// PATCH /api/placements/[id] — joining, invoicing, and the one that hurts:
// recording a drop inside the replacement window.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability, can } from "@/lib/auth";
import { replacementDeadline } from "@/lib/fees";
import { getSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INVOICE = ["pending", "raised", "paid", "written-off"];

export async function PATCH(req, { params }) {
  const gate = await requireCapability("placement.write");
  if (!gate.ok) return gate.response;

  try {
    const id = params?.id;
    const existing = await prisma.placement.findUnique({
      where: { id },
      include: { candidate: { select: { id: true, name: true } } },
    });
    if (!existing) return NextResponse.json({ error: "No such placement." }, { status: 404 });

    const b = await req.json().catch(() => ({}));
    const data = {};
    const settings = await getSettings();

    if (b.joinedOn !== undefined) {
      if (b.joinedOn === null || b.joinedOn === "") {
        data.joinedOn = null;
        data.replacementUntil = null;
      } else {
        const d = new Date(b.joinedOn);
        if (Number.isNaN(d.getTime())) {
          return NextResponse.json({ error: "Enter a valid joining date." }, { status: 400 });
        }
        if (d < existing.selectedOn) {
          return NextResponse.json(
            { error: "The joining date cannot be before the selection date." },
            { status: 400 }
          );
        }
        data.joinedOn = d;
        // The replacement clock starts at joining, and uses the window in
        // force today. Existing placements keep the deadline already stamped
        // on them — changing the policy must not shorten a client's cover.
        data.replacementUntil = replacementDeadline(d, settings.replacementDays);
      }
    }

    if (b.employeeId !== undefined) data.employeeId = String(b.employeeId || "").trim() || null;

    if (b.invoiceStatus !== undefined) {
      if (!INVOICE.includes(b.invoiceStatus)) {
        return NextResponse.json({ error: `Unknown invoice status "${b.invoiceStatus}".` }, { status: 400 });
      }
      // Invoicing is the owner's, not a manager's. A manager runs the desk;
      // raising and settling invoices is the business owner's call.
      if (!can(gate.user.role, "invoice.write")) {
        return NextResponse.json(
          { error: "Only an owner can change invoice status." },
          { status: 403 }
        );
      }
      if (b.invoiceStatus !== "pending" && !existing.joinedOn && !data.joinedOn) {
        return NextResponse.json(
          { error: "Record the joining date before invoicing — the fee is only due once they have joined." },
          { status: 400 }
        );
      }
      data.invoiceStatus = b.invoiceStatus;
      if (b.invoiceStatus === "raised" && !existing.invoicedOn) data.invoicedOn = new Date();
      if (b.invoiceStatus === "paid" && !existing.paidOn) data.paidOn = new Date();
    }
    if (b.invoiceNo !== undefined) data.invoiceNo = String(b.invoiceNo || "").trim() || null;

    if (b.droppedOn !== undefined) {
      if (b.droppedOn === null || b.droppedOn === "") {
        data.droppedOn = null;
        data.dropReason = null;
      } else {
        const d = new Date(b.droppedOn);
        if (Number.isNaN(d.getTime())) {
          return NextResponse.json({ error: "Enter a valid date." }, { status: 400 });
        }
        data.droppedOn = d;
        data.dropReason = String(b.dropReason || "").trim() || null;
      }
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const p = await tx.placement.update({ where: { id }, data });
      if (data.joinedOn && existing.candidate) {
        await tx.candidate.update({ where: { id: existing.candidate.id }, data: { stage: "joined" } });
      }
      if (data.droppedOn && existing.candidate) {
        await tx.candidate.update({ where: { id: existing.candidate.id }, data: { stage: "dropped" } });
      }
      return p;
    });

    if (data.droppedOn || data.invoiceStatus) {
      await prisma.auditLog
        .create({
          data: {
            userId: gate.user.id,
            action: "update",
            entity: "Placement",
            entityId: id,
            summary: data.droppedOn
              ? `${existing.candidate?.name} dropped out${data.dropReason ? `: ${data.dropReason}` : ""}`
              : `${existing.candidate?.name} invoice → ${data.invoiceStatus}`,
          },
        })
        .catch((e) => console.error("[placement patch] audit write failed:", e?.message));
    }

    return NextResponse.json({ placement: updated });
  } catch (e) {
    console.error("[PATCH /api/placements/[id]]", e?.message || e);
    return NextResponse.json({ error: "Could not save the change." }, { status: 500 });
  }
}
