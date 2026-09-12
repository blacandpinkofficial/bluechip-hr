// /api/invoices — turning a joined placement into a document somebody pays.
//
// Invoice numbers must be gapless and sequential within a financial year. That
// is not a nicety; a series with holes in it is the first thing an auditor asks
// about. Two people clicking "raise" at the same moment is exactly how a hole,
// or a duplicate, appears.
//
// So the number is taken inside a transaction, and the unique constraint on
// Invoice.number is the real guarantee — if two transactions somehow reach the
// same number, the database refuses the second and we retry rather than
// papering over it. Belt, braces, and a database constraint that cannot be
// talked out of it.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import {
  computeInvoice, financialYear, invoiceNumber, sequenceOf, dueDate,
  taxKind, stateCodeFromGstin, rupeesToPaise, ageing, invoiceBlockers,
} from "@/lib/invoice";
import { istDay } from "@/lib/day";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req) {
  const gate = await requireCapability("revenue.read");
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const clientId = url.searchParams.get("clientId");

  const [invoices, settings, billable] = await Promise.all([
    prisma.invoice.findMany({
      where: { ...(status ? { status } : {}), ...(clientId ? { clientId } : {}) },
      orderBy: { issuedOn: "desc" },
      take: 300,
      include: {
        client: { select: { id: true, name: true } },
        lines: { select: { id: true, description: true, amountPaise: true, placementId: true } },
      },
    }),
    getSettings(),
    // Placements that have joined, have a fee, have not dropped, and are not on
    // an invoice yet. This is the "money you have earned and not asked for"
    // list, and on most desks it is longer than anybody expects.
    prisma.placement.findMany({
      where: {
        joinedOn: { not: null },
        droppedOn: null,
        // "No line on an invoice that still stands." NOT `invoiceLines: none`:
        // cancelling an invoice leaves its lines in place, so the plain version
        // hides those placements from this list forever — the fee disappears
        // from "earned but not invoiced" and can never be billed again, even
        // though POST below is perfectly willing to re-bill it.
        invoiceLines: { none: { invoice: { is: { status: { not: "cancelled" } } } } },
      },
      orderBy: { joinedOn: "asc" },
      take: 200,
      include: {
        candidate: { select: { name: true } },
        client: { select: { id: true, name: true, paymentDays: true, gstin: true, state: true } },
        requirement: { select: { designation: true } },
      },
    }),
  ]);

  return NextResponse.json({
    invoices,
    ageing: ageing(invoices, istDay()),
    uninvoiced: billable.map((p) => ({
      id: p.id,
      candidate: p.candidate?.name,
      client: p.client?.name,
      clientId: p.clientId,
      designation: p.requirement?.designation || p.designation,
      joinedOn: p.joinedOn,
      revenue: p.revenue,
      daysSinceJoining: Math.floor((Date.now() - new Date(p.joinedOn).getTime()) / 86400000),
    })),
    uninvoicedTotal: billable.reduce((s, p) => s + (p.revenue || 0), 0),
    companyReady: invoiceBlockers({ settings, client: { name: "x", state: "x" }, placements: [{ joinedOn: 1, revenue: 1 }] }),
    canWrite: (await requireCapability("invoice.write")).ok,
  });
}

/** body: { clientId, placementIds: [], issuedOn?, notes? } */
export async function POST(req) {
  const gate = await requireCapability("invoice.write");
  if (!gate.ok) return gate.response;
  const { user } = gate;

  const b = await req.json().catch(() => ({}));
  const clientId = String(b.clientId || "");
  const placementIds = Array.isArray(b.placementIds) ? b.placementIds.map(String) : [];

  if (!clientId) return NextResponse.json({ error: "Which client?" }, { status: 400 });
  if (!placementIds.length) return NextResponse.json({ error: "Pick at least one placement to bill." }, { status: 400 });

  const [settings, client, placements] = await Promise.all([
    getSettings(),
    prisma.client.findUnique({ where: { id: clientId } }),
    prisma.placement.findMany({
      where: { id: { in: placementIds } },
      include: { candidate: { select: { name: true } }, requirement: { select: { designation: true } } },
    }),
  ]);

  if (!client) return NextResponse.json({ error: "That client does not exist." }, { status: 404 });

  // Some ids resolving to nothing means the screen and the database disagree
  // about what exists. Raising an invoice for "the ones that were found" is how
  // a client gets billed for less than the desk thinks it billed them for.
  if (placements.length !== placementIds.length) {
    return NextResponse.json(
      { error: `${placementIds.length - placements.length} of those placements no longer exist. Reload and try again.` },
      { status: 409 }
    );
  }

  // Billing one client's placement on another client's invoice is a mistake
  // nobody catches until the wrong company is asked for money.
  const strays = placements.filter((p) => p.clientId !== clientId);
  if (strays.length) {
    return NextResponse.json(
      { error: `${strays.length} of those placements belong to a different client.` },
      { status: 400 }
    );
  }

  const alreadyBilled = await prisma.invoiceLine.findMany({
    where: { placementId: { in: placementIds } },
    include: { invoice: { select: { number: true, status: true } } },
  });
  const live = alreadyBilled.filter((l) => l.invoice?.status !== "cancelled");
  if (live.length) {
    return NextResponse.json(
      { error: `Already invoiced on ${[...new Set(live.map((l) => l.invoice.number))].join(", ")}.` },
      { status: 409 }
    );
  }

  // A hard stop, with no override. An invoice missing a GSTIN or an address is
  // not a rough draft — it is a document that cannot lawfully be issued, and a
  // "send it anyway" button would only ever be used in a hurry. There was a
  // confirmBlockers escape hatch here; it was unreachable from the screen and
  // wrong in principle, so it is gone rather than wired up.
  const blockers = invoiceBlockers({ settings, client, placements });
  if (blockers.length) {
    return NextResponse.json({ error: blockers.join(" "), blockers }, { status: 400 });
  }

  // ── tax ───────────────────────────────────────────────────────────────────
  const companyState = String(settings.stateCode || stateCodeFromGstin(settings.gstin) || "");
  const clientState = String(
    stateCodeFromGstin(client.gstin) || String(client.state || "").replace(/\D/g, "") || ""
  );
  const kind = taxKind(companyState, clientState);
  if (kind === "unknown") {
    return NextResponse.json(
      { error: `Cannot tell whether this is an intra-state or inter-state supply — ${client.name} has no GSTIN or state code, so the right tax cannot be worked out.` },
      { status: 400 }
    );
  }

  const linesPaise = placements.map((p) => rupeesToPaise(p.revenue || 0));
  const totals = computeInvoice({ linesPaise, gstBps: settings.gstBps ?? 1800, kind });

  const issuedOn = b.issuedOn ? new Date(`${String(b.issuedOn).slice(0, 10)}T00:00:00.000Z`) : istDay();
  if (Number.isNaN(issuedOn.getTime())) return NextResponse.json({ error: "That is not a real date." }, { status: 400 });
  const fy = financialYear(issuedOn);

  // ── the number, then the invoice ──────────────────────────────────────────
  // Retried on the unique-constraint violation rather than assumed unique. The
  // transaction narrows the race; the constraint closes it.
  let invoice = null;
  let lastError = null;
  for (let attempt = 0; attempt < 5 && !invoice; attempt++) {
    try {
      invoice = await prisma.$transaction(async (tx) => {
        // Every number in this financial year, unordered. NOT `orderBy: number
        // desc, take: 50` — invoice numbers are zero-padded strings, so sorting
        // them lexicographically puts ".../999" above ".../1000" and the series
        // silently stops advancing once a year passes a thousand invoices.
        // A year of invoices is a small list; read it and take the real maximum.
        const existing = await tx.invoice.findMany({
          where: { number: { contains: `/${fy}/` } },
          select: { number: true },
          take: 5000,
        });
        const highest = existing.reduce((m, r) => Math.max(m, sequenceOf(r.number)), 0);
        // Deliberately NOT `highest + 1 + attempt`. Adding the attempt number
        // was meant as belt and braces and instead created the exact problem
        // this file exists to prevent: after a collision on N+1, it would jump
        // to N+3 and leave N+2 permanently unused. `highest` is re-read inside
        // each retry, so the next free number is always simply highest + 1.
        const number = invoiceNumber(settings.invoicePrefix, fy, highest + 1);

        return tx.invoice.create({
          data: {
            number,
            clientId,
            issuedOn,
            dueOn: dueDate(issuedOn, client.paymentDays ?? settings.defaultPaymentDays ?? 30),
            subtotalPaise: totals.subtotalPaise,
            gstBps: totals.gstBps,
            cgstPaise: totals.cgstPaise,
            sgstPaise: totals.sgstPaise,
            igstPaise: totals.igstPaise,
            roundOffPaise: totals.roundOffPaise,
            totalPaise: totals.totalPaise,
            billToName: client.name,
            billToGstin: client.gstin || null,
            billToState: client.state || null,
            billToAddress: client.address || null,
            status: "raised",
            notes: String(b.notes || "").trim() || null,
            createdById: user.id,
            lines: {
              create: placements.map((p, i) => ({
                placementId: p.id,
                description: `${p.candidate?.name || "Candidate"} — ${p.requirement?.designation || p.designation} (joined ${new Date(p.joinedOn).toLocaleDateString("en-IN")})`,
                amountPaise: linesPaise[i],
              })),
            },
          },
          include: { lines: true },
        });
      });
    } catch (e) {
      lastError = e;
      // P2002 is the unique constraint on number: somebody else took it between
      // our read and our write. That is the race working as designed — try the
      // next number rather than failing.
      if (e?.code !== "P2002") throw e;
    }
  }

  if (!invoice) {
    console.error("[invoices] could not allocate a number", lastError?.message);
    return NextResponse.json(
      { error: "Could not allocate an invoice number — someone else may be invoicing at the same moment. Try again." },
      { status: 409 }
    );
  }

  // Placement invoice status follows the invoice, so the placements screen does
  // not still say "pending" for money that has been asked for.
  await prisma.placement.updateMany({
    where: { id: { in: placementIds } },
    data: { invoiceStatus: "raised", invoiceNo: invoice.number, invoicedOn: issuedOn },
  }).catch(() => {});

  await prisma.auditLog.create({
    data: { userId: user.id, action: "create", entity: "Invoice", entityId: invoice.id, summary: `${invoice.number} to ${client.name}` },
  }).catch(() => {});

  return NextResponse.json({
    invoice,
    message: `${invoice.number} raised — ₹${Math.round(invoice.totalPaise / 100).toLocaleString("en-IN")} due ${new Date(invoice.dueOn).toLocaleDateString("en-IN")}.`,
  });
}

/** body: { id, status?, paidRupees?, paidOn?, notes? } */
export async function PATCH(req) {
  const gate = await requireCapability("invoice.write");
  if (!gate.ok) return gate.response;
  const { user } = gate;

  const b = await req.json().catch(() => ({}));
  const id = String(b.id || "");
  if (!id) return NextResponse.json({ error: "Which invoice?" }, { status: 400 });

  const inv = await prisma.invoice.findUnique({ where: { id } });
  if (!inv) return NextResponse.json({ error: "That invoice no longer exists." }, { status: 404 });

  const data = {};

  if (b.paidRupees !== undefined) {
    const paise = rupeesToPaise(b.paidRupees);
    if (!Number.isFinite(paise) || paise < 0) {
      return NextResponse.json({ error: "Enter the amount received, in rupees." }, { status: 400 });
    }
    // Overpayment is real (a client rounds up, or pays two invoices together),
    // so it is allowed — but it is flagged rather than silently absorbed,
    // because far more often it means the wrong invoice was marked off.
    const total = inv.paidPaise + paise;
    data.paidPaise = total;
    data.status = total >= inv.totalPaise ? "paid" : total > 0 ? "part-paid" : inv.status;
    if (data.status === "paid") data.paidOn = b.paidOn ? new Date(`${String(b.paidOn).slice(0, 10)}T00:00:00.000Z`) : new Date();
  }

  if (b.status !== undefined) {
    const STATUSES = ["draft", "raised", "paid", "part-paid", "written-off", "cancelled"];
    if (!STATUSES.includes(b.status)) {
      return NextResponse.json({ error: `Status must be one of: ${STATUSES.join(", ")}` }, { status: 400 });
    }
    data.status = b.status;
    if (b.status === "paid" && !inv.paidOn) {
      data.paidOn = new Date();
      data.paidPaise = inv.totalPaise;
    }
  }

  if (b.notes !== undefined) data.notes = String(b.notes || "").trim() || null;

  const row = await prisma.invoice.update({ where: { id }, data });

  if (data.status) {
    // Only a FULLY paid invoice makes its placements paid. Treating "part-paid"
    // as paid used to tip the whole placement's revenue into the collected
    // figure on the placements screen, so receiving ₹10,000 against a ₹2,00,000
    // invoice reported ₹2,00,000 as money in the bank.
    //
    // Cancelling releases the placements back to "pending" so they reappear in
    // "earned but not invoiced" — otherwise the fee is simply lost from view.
    const placementStatus =
      data.status === "paid" ? "paid"
      : data.status === "written-off" ? "written-off"
      : data.status === "cancelled" ? "pending"
      : "raised";

    await prisma.placement.updateMany({
      where: { invoiceLines: { some: { invoiceId: id } } },
      data: {
        invoiceStatus: placementStatus,
        ...(data.status === "paid" ? { paidOn: data.paidOn || new Date() } : {}),
        ...(data.status === "cancelled" ? { invoiceNo: null, invoicedOn: null } : {}),
      },
    }).catch(() => {});
  }

  await prisma.auditLog.create({
    data: { userId: user.id, action: "update", entity: "Invoice", entityId: id, summary: `${inv.number} → ${data.status || "updated"}` },
  }).catch(() => {});

  const over = row.paidPaise > row.totalPaise;
  return NextResponse.json({
    invoice: row,
    message: over
      ? `Recorded — but that is ₹${Math.round((row.paidPaise - row.totalPaise) / 100).toLocaleString("en-IN")} more than the invoice. Check it is the right one.`
      : "Saved.",
  });
}
