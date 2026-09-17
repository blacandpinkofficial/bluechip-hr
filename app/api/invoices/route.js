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
//
// The same logic now covers the placements themselves (BC-02) and the money
// received against the invoice (BC-03): a check followed by a write is not a
// guarantee of anything, so both are conditional writes the database arbitrates.
//
// NOTE ON EXPORTS: a Next.js route.js may export ONLY the HTTP handlers and the
// segment config. Everything else in this file is a module-private function,
// and every pure rule lives in lib/invoice.js.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import {
  computeInvoice, financialYear, invoiceNumber, sequenceOf, dueDate,
  taxKind, stateCodeFromGstin, rupeesToPaise, ageingRows, invoiceBlockers,
  AlreadyBilledError, PaymentKeyConflictError,
  INVOICE_STATUSES, SETTABLE_STATUSES, OUTSTANDING_STATUSES, PAYMENT_METHODS,
  deriveInvoiceStatus, placementStatusForInvoice,
  billablePlacementWhere, invoiceOwnedPlacementWhere,
  ageingBucketWindows, ageingFromBuckets, emptyAgeingBuckets,
  receiptAmountPaise, pageParams, isRetryableTxError,
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
  const { skip, take } = pageParams(url.searchParams, { defaultTake: 100, maxTake: 300 });

  const where = { ...(status ? { status } : {}), ...(clientId ? { clientId } : {}) };
  const today = istDay();

  // ── BC-05: the totals are counted by the database, not by this page ────────
  //
  // The ageing buckets used to be folded in JavaScript over `take: 300`
  // invoices ordered `issuedOn: desc`. Past invoice 301 that drops the OLDEST
  // debt first — the over-90 bucket, which is the entire reason anyone opens
  // this report. The rows below are a page; the buckets are the whole book.
  //
  // `paidPaise < totalPaise` is a FIELD REFERENCE, compared inside Postgres.
  // It does two jobs: it drops fully-settled invoices (which the JS version did
  // with `if (outstandingPaise === 0) continue`) and it drops overpaid ones,
  // which is what makes sum(total) - sum(paid) per bucket exactly equal to
  // sum(total - paid). Without it a single overpaid invoice would net off
  // against real debt somewhere else in the same bucket.
  const ageingStatuses = status
    ? (OUTSTANDING_STATUSES.includes(status) ? [status] : [])
    : OUTSTANDING_STATUSES;
  const outstandingWhere = {
    ...(clientId ? { clientId } : {}),
    status: { in: ageingStatuses },
    paidPaise: { lt: prisma.invoice.fields.totalPaise },
  };

  const windows = ageingBucketWindows(today);
  const billableWhere = billablePlacementWhere();

  const [invoices, totalCount, settings, billable, billableTotals, bucketRows] = await Promise.all([
    // The page. `orderBy` carries an id tie-breaker: issuedOn is a DATE, so a
    // day with two invoices on it has no inherent order and the same row can
    // appear on page one and page two, or on neither.
    prisma.invoice.findMany({
      where,
      orderBy: [{ issuedOn: "desc" }, { id: "desc" }],
      skip,
      take,
      include: {
        client: { select: { id: true, name: true } },
        lines: { select: { id: true, description: true, amountPaise: true, placementId: true } },
      },
    }),
    prisma.invoice.count({ where }),
    getSettings(),
    // Placements that have joined, have a fee, have not dropped, and are not on
    // an invoice yet. This is the "money you have earned and not asked for"
    // list, and on most desks it is longer than anybody expects.
    prisma.placement.findMany({
      where: billableWhere,
      orderBy: [{ joinedOn: "asc" }, { id: "asc" }],
      take: 200,
      include: {
        candidate: { select: { name: true } },
        client: { select: { id: true, name: true, paymentDays: true, gstin: true, state: true } },
        requirement: { select: { designation: true } },
      },
    }),
    // ...and the total over ALL of them, not over the 200 shown.
    prisma.placement.aggregate({
      where: billableWhere,
      _sum: { revenue: true },
      _count: { _all: true },
    }),
    Promise.all(
      windows.map((w) =>
        prisma.invoice.aggregate({
          where: { ...outstandingWhere, dueOn: w.dueOn },
          _count: { _all: true },
          _sum: { totalPaise: true, paidPaise: true },
        })
      )
    ),
  ]);

  const buckets = emptyAgeingBuckets();
  windows.forEach((w, i) => {
    const agg = bucketRows[i];
    buckets[w.key] = {
      count: agg._count?._all || 0,
      paise: (agg._sum?.totalPaise || 0) - (agg._sum?.paidPaise || 0),
    };
  });

  // Placement.revenue is whole rupees (Int) and stays that way — it is a fee,
  // not a tax invoice. The paise figure is derived for anything that has to add
  // up against invoice totals.
  const uninvoicedTotal = billableTotals._sum?.revenue || 0;

  return NextResponse.json({
    invoices,
    totalCount,
    page: { skip, take },
    // buckets and the outstanding totals: the whole book.
    // rows: detail for the invoices on this page, so the table can show "N days
    // late" beside each one.
    ageing: ageingFromBuckets(buckets, ageingRows(invoices, today)),
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
    uninvoicedCount: billableTotals._count?._all || 0,
    uninvoicedTotal,
    uninvoicedTotalPaise: rupeesToPaise(uninvoicedTotal),
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
  const placementIds = Array.isArray(b.placementIds) ? [...new Set(b.placementIds.map(String))] : [];

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

  // A courtesy check, NOT the guarantee. It reads nicely — it can name the
  // invoice number the placement is already on — and it catches the ordinary
  // case of someone working from a stale screen. It cannot catch the case this
  // whole file is about, because between this read and the write below any
  // number of other operators may bill the same joining. That is what the
  // conditional claim inside the transaction is for.
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

  // ── the number, the invoice, and the claim ────────────────────────────────
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

        const inv = await tx.invoice.create({
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

        // ── BC-02: the claim ────────────────────────────────────────────────
        //
        // The only line in this file that actually prevents a placement being
        // billed twice. `billedByInvoiceId: null` is part of the WHERE, so
        // Postgres re-evaluates it after taking the row lock: if another
        // transaction claimed the row and committed while we were waiting, our
        // UPDATE matches zero rows rather than overwriting their claim. Two
        // operators, one winner, and the loser finds out before anything is
        // sent to a client.
        //
        // This is safe at READ COMMITTED precisely because it is a conditional
        // WRITE and not a read followed by a write. A `findMany` here, however
        // careful, would see the same "unbilled" as the other transaction.
        //
        // The placement's invoiceStatus/invoiceNo/invoicedOn ride along in the
        // same statement — BC-04. They used to be a separate updateMany after
        // the transaction had committed, wrapped in `.catch(() => {})`, so the
        // invoice could exist while the placements screen still said "pending"
        // and nothing anywhere recorded that it had failed.
        const claimed = await tx.placement.updateMany({
          where: { id: { in: placementIds }, billedByInvoiceId: null },
          data: {
            billedByInvoiceId: inv.id,
            invoiceStatus: "raised",
            invoiceNo: inv.number,
            invoicedOn: issuedOn,
          },
        });

        if (claimed.count !== placementIds.length) {
          // Anything we did not claim is claimed by somebody else. Name it, so
          // the operator knows what to leave out of the next attempt, then
          // throw — which rolls back the invoice, its lines, its number and the
          // claims we did take. Half an invoice is worse than none.
          const taken = await tx.placement.findMany({
            where: { id: { in: placementIds }, NOT: { billedByInvoiceId: inv.id } },
            select: { id: true, invoiceNo: true, candidate: { select: { name: true } } },
          });
          throw new AlreadyBilledError(
            taken.map((t) => ({
              id: t.id,
              label: t.invoiceNo
                ? `${t.candidate?.name || "A placement"} (on ${t.invoiceNo})`
                : t.candidate?.name || "A placement",
            }))
          );
        }

        // Inside the transaction too. An invoice that exists with nothing in the
        // audit log recording who raised it is the same class of hole as an
        // invoice whose placements still say "pending".
        await tx.auditLog.create({
          data: {
            userId: user.id,
            action: "create",
            entity: "Invoice",
            entityId: inv.id,
            summary: `${inv.number} to ${client.name}`,
          },
        });

        return inv;
      });
    } catch (e) {
      // The claim lost. Not retryable — retrying would allocate another invoice
      // number for the same doomed attempt.
      if (e instanceof AlreadyBilledError) {
        return NextResponse.json(
          { error: e.message, takenPlacementIds: e.placementIds },
          { status: 409 }
        );
      }
      lastError = e;
      // P2002 is the unique constraint on number: somebody else took it between
      // our read and our write. That is the race working as designed — try the
      // next number rather than failing.
      if (e?.code !== "P2002" && !isRetryableTxError(e)) throw e;
    }
  }

  if (!invoice) {
    console.error("[invoices] could not allocate a number", lastError?.message);
    return NextResponse.json(
      { error: "Could not allocate an invoice number — someone else may be invoicing at the same moment. Try again." },
      { status: 409 }
    );
  }

  return NextResponse.json({
    invoice,
    message: `${invoice.number} raised — ₹${Math.round(invoice.totalPaise / 100).toLocaleString("en-IN")} due ${new Date(invoice.dueOn).toLocaleDateString("en-IN")}.`,
  });
}

/**
 * Two different things, deliberately not mixed in one request:
 *
 *   a receipt   { id, paidRupees | amountPaise, idempotencyKey, receivedOn?,
 *                 method?, reference?, note? }
 *   a change    { id, status?, notes? }
 *
 * "Paid" is not a status somebody sets. It is what the receipts add up to.
 */
export async function PATCH(req) {
  const gate = await requireCapability("invoice.write");
  if (!gate.ok) return gate.response;
  const { user } = gate;

  const b = await req.json().catch(() => ({}));
  const id = String(b.id || "");
  if (!id) return NextResponse.json({ error: "Which invoice?" }, { status: 400 });

  const inv = await prisma.invoice.findUnique({ where: { id } });
  if (!inv) return NextResponse.json({ error: "That invoice no longer exists." }, { status: 404 });

  const wantsReceipt = b.amountPaise !== undefined || b.paidRupees !== undefined;
  const wantsStatus = b.status !== undefined;
  const wantsNotes = b.notes !== undefined;

  if (wantsReceipt && wantsStatus) {
    return NextResponse.json(
      { error: "Record the receipt, or change the status — not both in one request. The status follows from what has been received." },
      { status: 400 }
    );
  }

  if (wantsReceipt) return recordReceipt({ invoice: inv, body: b, user });
  if (wantsStatus || wantsNotes) return changeInvoice({ invoice: inv, body: b, user });

  return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
}

// ═══════════════════════════════════════════════════════════════════════════
// BC-03 — recording money.
//
// What was here: read inv.paidPaise, add the new amount in JavaScript, write
// the absolute total back. No transaction, no version, no row for the receipt
// itself. Two ₹50,000 receipts keyed at the same moment both read 0 and the
// second overwrote the first. ₹50,000 vanished, and because the individual
// receipts were never stored there was nothing to reconstruct it from and
// nothing to notice it by — the invoice simply said ₹50,000 and was wrong.
//
// What is here now: a Payment row is the record, Invoice.paidPaise is a cached
// sum of those rows recomputed from scratch in the same transaction, and the
// caller's idempotency key makes a retry a no-op instead of a second receipt.
// ═══════════════════════════════════════════════════════════════════════════
async function recordReceipt({ invoice, body, user }) {
  const amountPaise = receiptAmountPaise(body);
  if (amountPaise === null) {
    return NextResponse.json(
      { error: "Enter the amount received, in rupees — digits, with at most two decimal places." },
      { status: 400 }
    );
  }
  if (amountPaise === 0) {
    return NextResponse.json(
      { error: "A receipt of nothing is not a receipt. Enter the amount that actually arrived, or a negative amount to reverse one that did not." },
      { status: 400 }
    );
  }
  if (invoice.status === "cancelled") {
    return NextResponse.json(
      { error: `${invoice.number} is cancelled — nothing is owed against it, so nothing can be received against it. If money did arrive, it belongs on another invoice.` },
      { status: 409 }
    );
  }

  const idempotencyKey = String(body.idempotencyKey || "").trim();
  if (!idempotencyKey) {
    return NextResponse.json(
      { error: "This request carries no idempotency key, so a retry could not be told apart from a second payment. Reload the page and try again." },
      { status: 400 }
    );
  }
  if (idempotencyKey.length > 200) {
    return NextResponse.json({ error: "That idempotency key is not a key." }, { status: 400 });
  }

  const method = body.method === undefined || body.method === null || body.method === ""
    ? null
    : String(body.method).trim().toLowerCase();
  if (method && !PAYMENT_METHODS.includes(method)) {
    return NextResponse.json(
      { error: `Method must be one of: ${PAYMENT_METHODS.join(", ")}.` },
      { status: 400 }
    );
  }

  const receivedOn = body.receivedOn
    ? new Date(`${String(body.receivedOn).slice(0, 10)}T00:00:00.000Z`)
    : istDay();
  if (Number.isNaN(receivedOn.getTime())) {
    return NextResponse.json({ error: "That is not a real date." }, { status: 400 });
  }

  // The ordinary retry: the first attempt reached the database, the response
  // did not reach the browser, and the same key came back. Answer with what is
  // already true rather than recording it again.
  const prior = await prisma.payment.findUnique({ where: { idempotencyKey } });
  if (prior) return replayReceipt(prior, invoice.id, amountPaise);

  let result = null;
  let lastError = null;
  for (let attempt = 0; attempt < 5 && !result; attempt++) {
    try {
      result = await prisma.$transaction(
        async (tx) => {
          // The receipt itself. Never updated, never deleted — a mis-keyed
          // receipt is corrected by a second row with a negative amount, so the
          // ledger shows what happened rather than what somebody wishes had.
          const payment = await tx.payment.create({
            data: {
              invoiceId: invoice.id,
              amountPaise,
              receivedOn,
              method,
              reference: String(body.reference || "").trim() || null,
              note: String(body.note || "").trim() || null,
              recordedById: user.id,
              idempotencyKey,
            },
          });

          // DERIVED, never accumulated. `paidPaise + amount` is the lost update
          // that made this an audit finding; summing the rows cannot lose one,
          // because the rows are what there is.
          const sum = await tx.payment.aggregate({
            where: { invoiceId: invoice.id },
            _sum: { amountPaise: true },
          });
          const paidPaise = sum._sum.amountPaise || 0;

          // Re-read the invoice INSIDE the transaction, every attempt.
          //
          // The copy fetched by the handler was read before this block opened,
          // so a concurrent cancel or write-off committed in the gap would be
          // invisible here — and deriveInvoiceStatus would then stamp "paid"
          // over a cancelled invoice, releasing its placements to be billed a
          // second time. Serializable only protects what the transaction
          // actually reads, so the read has to be in here. It also matters on
          // retry: a P2034 replay of a stale object would decide from the same
          // stale values that lost the first race.
          const live = await tx.invoice.findUnique({
            where: { id: invoice.id },
            select: { status: true, totalPaise: true, paidOn: true },
          });
          if (!live) throw new Error("Invoice disappeared mid-transaction.");

          const status = deriveInvoiceStatus({
            currentStatus: live.status,
            totalPaise: live.totalPaise,
            paidPaise,
          });

          // paidOn follows the status in both directions. A reversal that takes
          // an invoice back out of "paid" must not leave a settlement date on it.
          const paidOn =
            status === "paid" ? live.paidOn || receivedOn
            : live.status === "paid" ? null
            : live.paidOn;

          const row = await tx.invoice.update({
            where: { id: invoice.id },
            data: { paidPaise, status, paidOn },
          });

          // ── BC-04, inside the transaction and no longer swallowed ──────────
          await tx.placement.updateMany({
            where: invoiceOwnedPlacementWhere(invoice.id),
            data: {
              invoiceStatus: placementStatusForInvoice(status),
              ...(status === "paid" ? { paidOn: row.paidOn || receivedOn } : {}),
              ...(invoice.status === "paid" && status !== "paid" ? { paidOn: null } : {}),
            },
          });

          await tx.auditLog.create({
            data: {
              userId: user.id,
              action: "update",
              entity: "Invoice",
              entityId: invoice.id,
              summary: `${invoice.number} ${amountPaise < 0 ? "reversal" : "receipt"} ₹${Math.abs(Math.round(amountPaise / 100)).toLocaleString("en-IN")} → ${status}`,
            },
          });

          return { invoice: row, payment };
        },
        {
          // ── why Serializable ──────────────────────────────────────────────
          // The conditional write in POST is safe at READ COMMITTED because
          // Postgres re-checks an UPDATE's WHERE clause after it takes the row
          // lock. This transaction ends in a READ — the aggregate — and reads
          // do not block. At READ COMMITTED two concurrent receipts would each
          // see only their own uncommitted row and each compute a total missing
          // the other's, reintroducing the exact lost update this is fixing.
          //
          // Serializable makes Postgres abort one of them (P2034); the loop
          // retries it, and the second pass sees the first receipt committed.
          isolationLevel: "Serializable",
          timeout: 15000,
        }
      );
    } catch (e) {
      // Two requests carrying the SAME key in flight together: one inserted,
      // the other lost the unique index. That is a retry, not a payment.
      if (e?.code === "P2002" && String(e?.meta?.target || "").includes("idempotencyKey")) {
        const now = await prisma.payment.findUnique({ where: { idempotencyKey } });
        if (now) return replayReceipt(now, invoice.id, amountPaise);
      }
      lastError = e;
      if (!isRetryableTxError(e)) throw e;
    }
  }

  if (!result) {
    console.error("[invoices] receipt could not be recorded", lastError?.message);
    return NextResponse.json(
      { error: "Could not record that receipt — someone else is posting against this invoice at the same moment. Try again; the same amount will not be recorded twice." },
      { status: 409 }
    );
  }

  const row = result.invoice;
  const over = row.paidPaise > row.totalPaise;
  return NextResponse.json({
    invoice: row,
    payment: result.payment,
    replayed: false,
    // Overpayment is real (a client rounds up, or pays two invoices together),
    // so it is allowed — but it is flagged rather than silently absorbed,
    // because far more often it means the wrong invoice was marked off.
    message: over
      ? `Recorded — but that is ₹${Math.round((row.paidPaise - row.totalPaise) / 100).toLocaleString("en-IN")} more than the invoice. Check it is the right one.`
      : amountPaise < 0
        ? "Reversal recorded. The earlier receipt is still on the ledger; this row cancels it."
        : "Recorded.",
  });
}

/** The answer to a retried receipt: what is already true, and nothing new. */
async function replayReceipt(prior, invoiceId, amountPaise) {
  // The same key with different money is a caller bug, and treating it as a
  // replay would silently swallow a real payment.
  if (prior.invoiceId !== invoiceId || prior.amountPaise !== amountPaise) {
    const conflict = new PaymentKeyConflictError();
    return NextResponse.json({ error: conflict.message }, { status: 409 });
  }
  const row = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  return NextResponse.json({
    invoice: row,
    payment: prior,
    replayed: true,
    message: "Already recorded — this is the same receipt, so nothing was added.",
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Status and notes. No money moves here.
// ═══════════════════════════════════════════════════════════════════════════
async function changeInvoice({ invoice, body, user }) {
  const data = {};
  let nextStatus = null;

  if (body.status !== undefined) {
    if (!INVOICE_STATUSES.includes(body.status)) {
      return NextResponse.json(
        { error: `Status must be one of: ${INVOICE_STATUSES.join(", ")}` },
        { status: 400 }
      );
    }
    if (!SETTABLE_STATUSES.includes(body.status)) {
      // The old handler let you set "paid" and helpfully wrote
      // `paidPaise = totalPaise` to match — money on the books with no receipt
      // behind it, which is precisely the hole BC-03 exists to close. There is
      // no honest way to invent the receipt, so the answer is to record it.
      return NextResponse.json(
        { error: `"${body.status}" is not a status anyone sets — it is what the receipts add up to. Record the payment and the invoice will follow.` },
        { status: 400 }
      );
    }
    // A cancelled invoice is void, and un-voiding one is not a status change.
    // Its placements have been RELEASED — anyone may have billed them onto a
    // new invoice since — so bringing this one back to life would put the same
    // fee on two live invoices, which is the whole of BC-02 arriving through
    // the back door. Bill it again and it gets a new number, which is what an
    // auditor expects to see anyway.
    if (invoice.status === "cancelled" && body.status !== "cancelled") {
      return NextResponse.json(
        { error: `${invoice.number} was cancelled and its placements were released — some may be on another invoice by now. Raise a fresh invoice rather than reviving this one.` },
        { status: 409 }
      );
    }
    // Cancelling an invoice that has received money is a credit note, not a
    // status change, and doing it here would orphan the Payment rows against a
    // document that says nothing was ever owed.
    if (body.status === "cancelled" && invoice.paidPaise !== 0) {
      return NextResponse.json(
        { error: `${invoice.number} has ₹${Math.round(invoice.paidPaise / 100).toLocaleString("en-IN")} received against it. Reverse the receipts first — cancelling now would leave that money pointing at an invoice that says nothing was owed.` },
        { status: 409 }
      );
    }
    nextStatus = body.status;
    data.status = nextStatus;
  }

  if (body.notes !== undefined) data.notes = String(body.notes || "").trim() || null;
  if (!Object.keys(data).length) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });

  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.invoice.update({ where: { id: invoice.id }, data });

    if (nextStatus) {
      // ── BC-04 ────────────────────────────────────────────────────────────
      // Inside the transaction, and no `.catch(() => {})`. If the placements
      // cannot be brought into line the invoice does not change either, which
      // is the only way the two can be relied on to agree.
      await tx.placement.updateMany({
        where: invoiceOwnedPlacementWhere(invoice.id),
        data: {
          invoiceStatus: placementStatusForInvoice(nextStatus),
          ...(nextStatus === "cancelled" ? { invoiceNo: null, invoicedOn: null, paidOn: null } : {}),
        },
      });

      // ── BC-02's other half: cancelling RELEASES the claim ─────────────────
      // Without this the placements stay pointed at a cancelled invoice, never
      // reappear in "earned but not invoiced", and the fee is lost from view
      // forever. Scoped to this invoice's claims, so a placement already
      // re-billed onto a later invoice keeps that claim.
      if (nextStatus === "cancelled") {
        await tx.placement.updateMany({
          where: { billedByInvoiceId: invoice.id },
          data: { billedByInvoiceId: null },
        });
      }
    }

    await tx.auditLog.create({
      data: {
        userId: user.id,
        action: "update",
        entity: "Invoice",
        entityId: invoice.id,
        summary: `${invoice.number} → ${nextStatus || "notes updated"}`,
      },
    });

    return updated;
  });

  return NextResponse.json({
    invoice: row,
    message:
      nextStatus === "cancelled"
        ? `${row.number} cancelled. Its placements are claimable again and back in "earned but not invoiced".`
        : nextStatus === "written-off"
          ? `${row.number} written off.`
          : "Saved.",
  });
}
