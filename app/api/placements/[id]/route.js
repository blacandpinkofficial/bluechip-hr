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

// The candidate pipeline, in order, and forwards only. "dropped" is not in the
// list on purpose: it indexes to -1, and -1 compares as "miles behind" against
// every real stage, so an unchecked comparison would push a dropped candidate
// forward without anyone asking for it. Every index is checked against -1 first.
const ORDER = ["new", "contacted", "shortlisted", "lined-up", "interviewed", "selected", "joined"];

export async function PATCH(req, { params }) {
  const gate = await requireCapability("placement.write");
  if (!gate.ok) return gate.response;

  try {
    const id = params?.id;
    if (!id) return NextResponse.json({ error: "Which placement?" }, { status: 400 });

    const existing = await prisma.placement.findUnique({
      where: { id },
      include: { candidate: { select: { id: true, name: true, stage: true } } },
    });
    if (!existing) return NextResponse.json({ error: "No such placement." }, { status: 404 });

    const b = await req.json().catch(() => ({}));
    const data = {};
    const settings = await getSettings();

    // Is the drop being lifted in this same request? It decides whether a
    // joining date may be written at all, so it has to be known first.
    const clearingDrop =
      b.droppedOn !== undefined && (b.droppedOn === null || b.droppedOn === "");

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
        // Marking a dropped placement as joined would show a fee as earned on a
        // row that also says the person left. Undo the drop first — which is
        // one click, and says out loud what is being claimed.
        if (existing.droppedOn && !clearingDrop) {
          return NextResponse.json(
            {
              error: `${existing.candidate?.name || "This candidate"} is recorded as dropped out. Undo the drop first if they did in fact join.`,
            },
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

    // ── invoicing ────────────────────────────────────────────────────────────
    // Invoicing is the owner's, not a manager's. A manager runs the desk;
    // raising and settling invoices is the business owner's call. The invoice
    // NUMBER is part of the same act — a placement.write role that could stamp
    // invoice numbers on rows it may not price is not a smaller problem than
    // one that could move the status.
    if (b.invoiceStatus !== undefined || b.invoiceNo !== undefined) {
      if (!can(gate.user.role, "invoice.write")) {
        return NextResponse.json(
          { error: "Only an owner can change invoicing." },
          { status: 403 }
        );
      }
    }

    if (b.invoiceStatus !== undefined) {
      if (!INVOICE.includes(b.invoiceStatus)) {
        return NextResponse.json({ error: `Unknown invoice status "${b.invoiceStatus}".` }, { status: 400 });
      }
      if (b.invoiceStatus !== "pending" && !existing.joinedOn && !data.joinedOn) {
        return NextResponse.json(
          { error: "Record the joining date before invoicing — the fee is only due once they have joined." },
          { status: 400 }
        );
      }
      data.invoiceStatus = b.invoiceStatus;
      // Stamped the first time only. These are the dates the invoice was raised
      // and settled, not the date somebody last touched the row.
      if (b.invoiceStatus === "raised" && !existing.invoicedOn) data.invoicedOn = new Date();
      if (b.invoiceStatus === "paid") {
        if (!existing.invoicedOn) data.invoicedOn = new Date();
        if (!existing.paidOn) data.paidOn = new Date();
      }
    }
    if (b.invoiceNo !== undefined) data.invoiceNo = String(b.invoiceNo || "").trim() || null;

    // ── the drop ─────────────────────────────────────────────────────────────
    if (b.droppedOn !== undefined) {
      if (clearingDrop) {
        data.droppedOn = null;
        data.dropReason = null;
      } else {
        const d = new Date(b.droppedOn);
        if (Number.isNaN(d.getTime())) {
          return NextResponse.json({ error: "Enter a valid date." }, { status: 400 });
        }
        if (d < existing.selectedOn) {
          return NextResponse.json(
            { error: "Someone cannot drop out before they were selected." },
            { status: 400 }
          );
        }
        const joinedAt = data.joinedOn !== undefined ? data.joinedOn : existing.joinedOn;
        if (joinedAt && d < joinedAt) {
          return NextResponse.json(
            { error: "The drop-out date cannot be before the joining date." },
            { status: 400 }
          );
        }
        data.droppedOn = d;
        data.dropReason = String(b.dropReason || "").trim() || null;
      }
    } else if (b.dropReason !== undefined && existing.droppedOn) {
      // Correcting the reason on a drop already recorded, without re-dating it.
      data.dropReason = String(b.dropReason || "").trim() || null;
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const p = await tx.placement.update({ where: { id }, data });

      // The candidate moves with the joining, forwards only.
      //
      // "dropped" is lifted here, and only here, because a joining recorded by
      // hand against a client and a date is evidence rather than inference: a
      // candidate written off earlier and then actually placed must not stay
      // marked dropped. Every other stage that is not in ORDER is left alone.
      if (data.joinedOn && existing.candidate) {
        const at = ORDER.indexOf(existing.candidate.stage);
        const to = ORDER.indexOf("joined");
        if (existing.candidate.stage === "dropped" || (at >= 0 && at < to)) {
          await tx.candidate.update({
            where: { id: existing.candidate.id },
            data: { stage: "joined", archived: false },
          });
        }
      }

      // A drop does NOT rewrite the candidate's stage.
      //
      // It is tempting — the person left, so mark them dropped — but the stage
      // only ever moves forwards, and a candidate whose placement is being
      // dropped is by definition at "selected" or "joined". Writing "dropped"
      // over "joined" is the one move that destroys information: it hides them
      // from every forward-looking queue and it contradicts the placement row
      // sitting right next to it, which still records that they joined on a
      // date and that a fee was earned. The drop lives on the PLACEMENT, where
      // droppedOn and dropReason keep the whole story, and the original record
      // is left intact.

      return p;
    });

    // Everything that moves money gets a line in the log, and that includes the
    // two undos: lifting a drop or clearing a joining date both put a fee back
    // into a month, or take one out of it, and a month that changes value with
    // nothing to say why is the problem this whole app exists to end.
    const who = existing.candidate?.name || "This candidate";
    const summary =
      data.droppedOn ? `${who} dropped out${data.dropReason ? `: ${data.dropReason}` : ""}`
      : "droppedOn" in data ? `${who} — drop undone`
      : data.joinedOn ? `${who} joined on ${new Date(data.joinedOn).toLocaleDateString("en-IN")}`
      : "joinedOn" in data ? `${who} — joining date cleared`
      : data.invoiceStatus ? `${who} invoice → ${data.invoiceStatus}`
      : null;

    if (summary) {
      await prisma.auditLog
        .create({
          data: {
            userId: gate.user.id,
            action: "update",
            entity: "Placement",
            entityId: id,
            summary,
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
