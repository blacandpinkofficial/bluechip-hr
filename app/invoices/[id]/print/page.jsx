// The printed tax invoice.
//
// A SERVER component, deliberately. Every other screen in this app fetches from
// the browser, but this one is a document: it must render identically every
// time, contain no client JavaScript that could fail to load mid-print, and
// show exactly what was stored rather than anything recomputed today. An
// invoice whose figures are derived at view time is an invoice that can quietly
// change after it was sent.
//
// Printing is the browser's own Ctrl+P. No PDF library, nothing to keep
// updated, and the output is a real PDF through "Save as PDF" on every machine.

import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getSession, can } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { paiseToString, amountInWords } from "@/lib/invoice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function d(x) {
  return x ? new Date(x).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }) : "—";
}

export default async function InvoicePrintPage({ params }) {
  // The middleware only checks that a cookie exists. Money needs the real check.
  const session = await getSession();
  if (!session || !can(session.user.role, "revenue.read")) {
    return (
      <main style={{ padding: 40, fontFamily: "system-ui, sans-serif" }}>
        <h1>Not available</h1>
        <p>You do not have access to invoices.</p>
      </main>
    );
  }

  const [invoice, settings] = await Promise.all([
    prisma.invoice.findUnique({
      where: { id: params.id },
      include: { lines: true, client: { select: { hrName: true } } },
    }),
    getSettings(),
  ]);
  if (!invoice) notFound();

  const intra = invoice.cgstPaise > 0 || invoice.sgstPaise > 0;
  const halfPct = (invoice.gstBps / 200).toFixed(2).replace(/\.00$/, "");
  const fullPct = (invoice.gstBps / 100).toFixed(2).replace(/\.00$/, "");

  return (
    <main className="invoice">
      <style>{`
        /* Scoped here rather than in globals.css: this page is a document, and
           the app's own styling is not what should decide how it prints. */
        .invoice { max-width: 800px; margin: 0 auto; padding: 32px;
          font-family: system-ui, "Segoe UI", Arial, sans-serif; font-size: 13px;
          color: #111827; background: #fff; }
        .invoice h1 { font-size: 20px; margin: 0; letter-spacing: .5px; }
        .muted { color: #6b7280; }
        .row { display: flex; justify-content: space-between; gap: 24px; }
        .box { border: 1px solid #d1d5db; padding: 12px; border-radius: 4px; }
        table { width: 100%; border-collapse: collapse; margin-top: 18px; }
        th, td { border: 1px solid #d1d5db; padding: 7px 9px; text-align: left; vertical-align: top; }
        th { background: #f3f4f6; font-weight: 600; }
        .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .totals td { border: none; padding: 3px 9px; }
        .totals .line td { border-top: 1px solid #d1d5db; }
        .grand td { border-top: 2px solid #111827; font-weight: 700; font-size: 15px; }
        .noprint { margin-bottom: 20px; }
        @media print {
          .noprint { display: none !important; }
          .invoice { padding: 0; max-width: none; }
          /* A tax invoice that splits a line item across two pages is a tax
             invoice somebody will query. */
          tr, .box { break-inside: avoid; }
        }
      `}</style>

      <div className="noprint">
        <a href="/invoices">&larr; Invoices</a>
        <span className="muted"> · Use your browser&rsquo;s Print (Ctrl+P) — choose &ldquo;Save as PDF&rdquo; to send it by email.</span>
      </div>

      <div className="row" style={{ alignItems: "flex-start", marginBottom: 20 }}>
        <div>
          <h1>{settings.companyName}</h1>
          {settings.addressLine && <div className="muted" style={{ marginTop: 4, whiteSpace: "pre-line" }}>{settings.addressLine}</div>}
          {settings.gstin && <div style={{ marginTop: 6 }}><strong>GSTIN:</strong> {settings.gstin}</div>}
          {settings.stateName && <div><strong>State:</strong> {settings.stateName}{settings.stateCode ? ` (${settings.stateCode})` : ""}</div>}
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: 1 }}>TAX INVOICE</div>
          <div style={{ marginTop: 8 }}><strong>{invoice.number}</strong></div>
          <div className="muted">Issued {d(invoice.issuedOn)}</div>
          <div className="muted">Due {d(invoice.dueOn)}</div>
          {invoice.status !== "raised" && (
            <div style={{ marginTop: 6, textTransform: "uppercase", fontSize: 11, letterSpacing: 1 }}>{invoice.status}</div>
          )}
        </div>
      </div>

      <div className="box">
        <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1 }}>Bill to</div>
        <div style={{ fontWeight: 600, marginTop: 3 }}>{invoice.billToName}</div>
        {invoice.client?.hrName && <div>Attn: {invoice.client.hrName}</div>}
        {invoice.billToAddress && <div className="muted" style={{ whiteSpace: "pre-line" }}>{invoice.billToAddress}</div>}
        {invoice.billToGstin && <div style={{ marginTop: 4 }}><strong>GSTIN:</strong> {invoice.billToGstin}</div>}
        {invoice.billToState && <div><strong>Place of supply:</strong> {invoice.billToState}</div>}
      </div>

      <table>
        <thead>
          <tr>
            <th style={{ width: 32 }}>#</th>
            <th>Description</th>
            {/* SAC 998511 is "executive/retained search services" — the code
                recruitment fees are billed under. It belongs on the invoice;
                without it the client cannot claim input credit cleanly. */}
            <th style={{ width: 80 }}>SAC</th>
            <th className="num" style={{ width: 110 }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((l, i) => (
            <tr key={l.id}>
              <td>{i + 1}</td>
              <td>{l.description}</td>
              <td>998511</td>
              <td className="num">{paiseToString(l.amountPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="row" style={{ marginTop: 16, alignItems: "flex-start" }}>
        <div style={{ flex: 1 }}>
          <div className="box">
            <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1 }}>Amount in words</div>
            <div style={{ marginTop: 4 }}>{amountInWords(invoice.totalPaise)}</div>
          </div>
          {(settings.bankName || settings.bankAccount) && (
            <div className="box" style={{ marginTop: 12 }}>
              <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1 }}>Payment</div>
              {settings.bankName && <div style={{ marginTop: 4 }}>{settings.bankName}</div>}
              {settings.bankAccount && <div>A/c {settings.bankAccount}</div>}
              {settings.bankIfsc && <div>IFSC {settings.bankIfsc}</div>}
            </div>
          )}
          {invoice.notes && <div className="muted" style={{ marginTop: 12, whiteSpace: "pre-line" }}>{invoice.notes}</div>}
        </div>

        <table className="totals" style={{ width: 300, marginTop: 0 }}>
          <tbody>
            <tr><td>Subtotal</td><td className="num">{paiseToString(invoice.subtotalPaise)}</td></tr>
            {intra ? (
              <>
                <tr><td>CGST @ {halfPct}%</td><td className="num">{paiseToString(invoice.cgstPaise)}</td></tr>
                <tr><td>SGST @ {halfPct}%</td><td className="num">{paiseToString(invoice.sgstPaise)}</td></tr>
              </>
            ) : invoice.igstPaise > 0 ? (
              <tr><td>IGST @ {fullPct}%</td><td className="num">{paiseToString(invoice.igstPaise)}</td></tr>
            ) : (
              <tr><td className="muted">No GST charged</td><td className="num">0.00</td></tr>
            )}
            {invoice.roundOffPaise !== 0 && (
              <tr><td>Round off</td><td className="num">{paiseToString(invoice.roundOffPaise)}</td></tr>
            )}
            <tr className="grand"><td>Total</td><td className="num">₹{paiseToString(invoice.totalPaise)}</td></tr>
            {invoice.paidPaise > 0 && (
              <>
                <tr className="line"><td>Received</td><td className="num">{paiseToString(invoice.paidPaise)}</td></tr>
                <tr><td><strong>Balance</strong></td><td className="num"><strong>{paiseToString(invoice.totalPaise - invoice.paidPaise)}</strong></td></tr>
              </>
            )}
          </tbody>
        </table>
      </div>

      <div className="row" style={{ marginTop: 48, alignItems: "flex-end" }}>
        <div className="muted" style={{ fontSize: 11, maxWidth: 380 }}>
          This is a computer-generated invoice. Payment is due by {d(invoice.dueOn)}.
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ height: 40 }} />
          <div style={{ borderTop: "1px solid #9ca3af", paddingTop: 6, minWidth: 200 }}>
            For {settings.companyName}
          </div>
        </div>
      </div>
    </main>
  );
}
