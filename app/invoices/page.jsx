"use client";
// Invoices — money earned, money asked for, money actually in.
//
// The first thing on the screen is deliberately not the invoice list. It is the
// placements that have joined and never been billed, because that is the number
// that surprises people: work finished, fee earned, nobody asked for it.

import { Fragment, useCallback, useEffect, useState } from "react";
import Shell from "@/components/Shell";
import { paiseToString } from "@/lib/invoice";

function inr(rupees) {
  return `₹${Number(rupees || 0).toLocaleString("en-IN")}`;
}
function dt(x) {
  return x ? new Date(x).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—";
}

const STATUS_TONE = {
  raised: "bg-sky-50 text-sky-800 border-sky-200",
  "part-paid": "bg-amber-50 text-amber-900 border-amber-200",
  paid: "bg-emerald-50 text-emerald-800 border-emerald-200",
  "written-off": "bg-red-50 text-red-800 border-red-200",
  cancelled: "bg-slate-100 text-slate-500 border-slate-300",
  draft: "bg-slate-100 text-slate-600 border-slate-300",
};

export default function InvoicesPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState(new Set());
  const [payFor, setPayFor] = useState(null);
  const [payAmount, setPayAmount] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/invoices");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load invoices.");
      setData(j);
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Placements are grouped by client because one invoice bills one client. The
  // tick boxes are scoped to a client for the same reason — selecting across
  // two clients is not a thing that can be billed.
  const byClient = {};
  for (const p of data?.uninvoiced || []) {
    (byClient[p.clientId] ||= { name: p.client, rows: [] }).rows.push(p);
  }

  const pickedClient = (() => {
    const first = (data?.uninvoiced || []).find((p) => picked.has(p.id));
    return first ? first.clientId : null;
  })();

  function toggle(p) {
    const next = new Set(picked);
    if (next.has(p.id)) next.delete(p.id);
    else {
      if (pickedClient && pickedClient !== p.clientId) {
        setError("One invoice bills one client. Clear the selection first.");
        return;
      }
      next.add(p.id);
    }
    setError("");
    setPicked(next);
  }

  async function raise() {
    if (!picked.size || busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: pickedClient, placementIds: [...picked] }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not raise the invoice.");
      setFlash(j.message);
      setPicked(new Set());
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function patch(body) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/invoices", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "That did not save.");
      setFlash(j.message);
      setPayFor(null);
      setPayAmount("");
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const ag = data?.ageing;

  return (
    <Shell title="Invoices" subtitle="What has been billed, what is overdue, and what has been earned but never asked for.">
      {error && <div role="alert" className="card border-red-200 bg-red-50 p-3 text-sm text-red-800 mb-4">{error}</div>}
      {flash && <div className="card border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 mb-4">{flash}</div>}

      {data?.companyReady?.length > 0 && (
        <div className="card border-amber-200 bg-amber-50 p-4 mb-4">
          <div className="text-sm font-medium text-amber-900">
            Invoices cannot be raised correctly until these are filled in:
          </div>
          <ul className="text-sm text-amber-900/90 mt-2 space-y-0.5">
            {data.companyReady.map((b, i) => <li key={i}>• {b}</li>)}
          </ul>
          <a href="/settings" className="btn-ghost mt-3 inline-flex text-sm">Open settings</a>
        </div>
      )}

      {loading ? (
        <div className="card p-10 text-center text-slate-400">Loading…</div>
      ) : (
        <>
          {/* ── earned, never billed ───────────────────────────────────────── */}
          <div className="card p-5 mb-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-medium text-chip-900">Earned but not invoiced</div>
                <div className="text-sm text-slate-500">
                  {data.uninvoiced.length === 0
                    ? "Nothing outstanding — every joined placement has been billed."
                    : `${data.uninvoiced.length} placement${data.uninvoiced.length === 1 ? "" : "s"} worth ${inr(data.uninvoicedTotal)}.`}
                </div>
              </div>
              {picked.size > 0 && data.canWrite && (
                <button className="btn-primary" onClick={raise} disabled={busy}>
                  {busy ? "Raising…" : `Raise invoice for ${picked.size}`}
                </button>
              )}
            </div>

            {Object.entries(byClient).map(([cid, group]) => (
              <div key={cid} className="mt-4">
                <div className="text-sm font-medium text-slate-700 mb-1">{group.name}</div>
                <table className="w-full text-sm">
                  <tbody>
                    {group.rows.map((p) => (
                      <tr key={p.id} className="border-t border-slate-100">
                        <td className="py-2 w-8">
                          {data.canWrite && (
                            <input
                              type="checkbox"
                              aria-label={`Bill ${p.candidate}`}
                              checked={picked.has(p.id)}
                              onChange={() => toggle(p)}
                            />
                          )}
                        </td>
                        <td className="py-2">{p.candidate}</td>
                        <td className="py-2 text-slate-500">{p.designation}</td>
                        <td className="py-2 text-slate-500">
                          joined {dt(p.joinedOn)}
                          {p.daysSinceJoining > 45 && (
                            <span className="text-amber-700"> · {p.daysSinceJoining} days ago</span>
                          )}
                        </td>
                        <td className="py-2 text-right tabular-nums">{inr(p.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>

          {/* ── ageing ─────────────────────────────────────────────────────── */}
          {ag && ag.totalOutstandingPaise > 0 && (
            <div className="grid sm:grid-cols-5 gap-3 mb-6">
              <Bucket label="Not due" b={ag.buckets.notDue} />
              <Bucket label="1–30 late" b={ag.buckets.d0_30} tone="amber" />
              <Bucket label="31–60 late" b={ag.buckets.d31_60} tone="amber" />
              <Bucket label="61–90 late" b={ag.buckets.d61_90} tone="red" />
              <Bucket label="Over 90" b={ag.buckets.over90} tone="red" />
            </div>
          )}

          {/* ── the invoices ───────────────────────────────────────────────── */}
          {data.invoices.length === 0 ? (
            <div className="card p-10 text-center">
              <div className="text-chip-900 font-medium">No invoices yet.</div>
              <p className="text-sm text-slate-500 mt-1">Tick a placement above and raise the first one.</p>
            </div>
          ) : (
            <div className="card overflow-x-auto">
              <table className="w-full text-sm min-w-[760px]">
                <thead className="bg-slate-50 text-left text-slate-500">
                  <tr>
                    <th className="p-3 font-medium">Number</th>
                    <th className="p-3 font-medium">Client</th>
                    <th className="p-3 font-medium">Issued</th>
                    <th className="p-3 font-medium">Due</th>
                    <th className="p-3 font-medium text-right">Total</th>
                    <th className="p-3 font-medium text-right">Outstanding</th>
                    <th className="p-3 font-medium">Status</th>
                    <th className="p-3" />
                  </tr>
                </thead>
                <tbody>
                  {data.invoices.map((inv) => {
                    const row = ag?.rows.find((r) => r.id === inv.id);
                    const outstanding = inv.totalPaise - (inv.paidPaise || 0);
                    return (
                      <Fragment key={inv.id}>
                        <tr className="border-t border-slate-100">
                          <td className="p-3 font-medium text-chip-900">{inv.number}</td>
                          <td className="p-3">{inv.client?.name || inv.billToName}</td>
                          <td className="p-3 text-slate-500">{dt(inv.issuedOn)}</td>
                          <td className="p-3">
                            {dt(inv.dueOn)}
                            {row?.daysLate > 0 && (
                              <div className="text-xs text-red-700">{row.daysLate} days late</div>
                            )}
                          </td>
                          <td className="p-3 text-right tabular-nums">{paiseToString(inv.totalPaise)}</td>
                          <td className="p-3 text-right tabular-nums">
                            {outstanding > 0 ? paiseToString(outstanding) : "—"}
                          </td>
                          <td className="p-3">
                            <span className={"text-[11px] px-2 py-0.5 rounded border " + (STATUS_TONE[inv.status] || STATUS_TONE.draft)}>
                              {inv.status}
                            </span>
                          </td>
                          <td className="p-3 text-right whitespace-nowrap">
                            <a href={`/invoices/${inv.id}/print`} target="_blank" rel="noopener noreferrer"
                              className="text-xs text-slate-400 hover:text-chip-700 mr-2">Print</a>
                            {data.canWrite && outstanding > 0 && (
                              <button className="text-xs text-slate-400 hover:text-chip-700"
                                onClick={() => { setPayFor(payFor === inv.id ? null : inv.id); setPayAmount(String(Math.round(outstanding / 100))); }}>
                                Record payment
                              </button>
                            )}
                          </td>
                        </tr>
                        {payFor === inv.id && (
                          <tr className="border-t border-slate-100 bg-slate-50">
                            <td colSpan={8} className="p-4">
                              <div className="flex flex-wrap items-end gap-3">
                                <div>
                                  <label htmlFor={`pay-${inv.id}`} className="label">Amount received (₹)</label>
                                  <input id={`pay-${inv.id}`} className="input max-w-[12rem]" inputMode="numeric"
                                    value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
                                </div>
                                <button className="btn-primary" disabled={busy}
                                  onClick={() => patch({ id: inv.id, paidRupees: Number(payAmount) })}>
                                  Save
                                </button>
                                <button className="btn-ghost" onClick={() => setPayFor(null)}>Cancel</button>
                                <button className="text-xs text-slate-400 hover:text-red-700 ml-auto"
                                  onClick={() => patch({ id: inv.id, status: "written-off" })}>
                                  Write off
                                </button>
                              </div>
                              <p className="text-xs text-slate-500 mt-2">
                                Part payments are fine — enter what actually arrived, and the balance stays outstanding.
                              </p>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Shell>
  );
}

function Bucket({ label, b, tone }) {
  const colour = tone === "red" ? "text-red-700" : tone === "amber" ? "text-amber-800" : "text-chip-900";
  return (
    <div className="card p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={"text-lg tabular-nums mt-1 " + colour}>₹{paiseToString(b.paise).replace(/\.00$/, "")}</div>
      <div className="text-xs text-slate-400">{b.count} invoice{b.count === 1 ? "" : "s"}</div>
    </div>
  );
}
