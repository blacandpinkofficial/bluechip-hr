"use client";
// Placements — the "Recruiters MTD Performance" tab, with the revenue column
// worked out rather than typed.
//
// Two numbers that the old sheet ran together and this one keeps apart:
// selected and joined. A selection is a promise; only a joining can be
// invoiced. Adding them up together is how a month looks better than it was.

import { useCallback, useEffect, useState } from "react";
import Shell from "@/components/Shell";

function money(n) {
  if (n == null) return "—";
  return "₹" + Number(n).toLocaleString("en-IN");
}
function shortMoney(n) {
  if (n == null) return "—";
  const v = Number(n);
  if (v >= 10000000) return "₹" + (v / 10000000).toFixed(1).replace(/\.0$/, "") + "Cr";
  if (v >= 100000) return "₹" + (v / 100000).toFixed(1).replace(/\.0$/, "") + "L";
  if (v >= 1000) return "₹" + Math.round(v / 1000) + "k";
  return "₹" + v;
}
function day(d) {
  return d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—";
}
function monthOptions() {
  const out = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({
      value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: d.toLocaleDateString("en-IN", { month: "long", year: "numeric" }),
    });
  }
  return out;
}

const INVOICE_TONE = {
  pending: "bg-slate-100 text-slate-700 border-slate-300",
  raised: "bg-sky-100 text-sky-800 border-sky-300",
  paid: "bg-emerald-100 text-emerald-800 border-emerald-300",
  "written-off": "bg-red-100 text-red-800 border-red-300",
};

function Stat({ label, value, note, tone = "text-chip-800" }) {
  return (
    <div className="card p-4">
      <div className={"text-2xl font-semibold tabular-nums " + tone}>{value}</div>
      <div className="text-sm text-chip-900">{label}</div>
      {note && <div className="text-[11px] text-slate-500 mt-0.5">{note}</div>}
    </div>
  );
}

export default function PlacementsPage() {
  const months = monthOptions();
  const [month, setMonth] = useState(months[0].value);
  const [d, setD] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const r = await fetch(`/api/placements?month=${month}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load placements.");
      setD(j);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => { load(); }, [load]);

  async function patch(id, body) {
    setError("");
    try {
      const r = await fetch(`/api/placements/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error || "That change did not save."); }
      load();
    } catch {
      setError("That change did not save — check your connection.");
    }
  }

  const t = d?.totals || {};

  return (
    <Shell
      title="Placements"
      subtitle="Selections, joinings and the fee each one earns — computed from the terms frozen at selection."
      actions={
        <select
          id="month"
          className="input w-auto"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          aria-label="Month"
        >
          {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      }
    >
      {error && (
        <div role="alert" className="card border-red-200 bg-red-50 p-3 text-sm text-red-800 mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <div className="card p-10 text-center text-slate-400">Loading…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
            <Stat label="Selected" value={t.selected ?? 0} note="offers made" />
            <Stat label="Joined" value={t.joined ?? 0} note="actually turned up" tone="text-emerald-700" />
            <Stat label="Revenue earned" value={shortMoney(t.revenue ?? 0)} note="joined only" />
            <Stat label="Collected" value={shortMoney(t.paid ?? 0)}
              note={t.revenue ? `${Math.round(((t.paid || 0) / t.revenue) * 100)}% of earned` : "—"} />
          </div>

          {t.dropped > 0 && (
            <div className="card border-red-200 bg-red-50 p-3 text-sm text-red-800 mb-4">
              <b className="tabular-nums">{t.dropped}</b> placement{t.dropped === 1 ? "" : "s"} dropped
              out this month. Their fees are not counted above.
            </div>
          )}

          {d?.deskWide && d.byRecruiter?.length > 0 && (
            <div className="card p-4 mb-5">
              <div className="text-sm font-medium mb-3">By recruiter</div>
              <div className="space-y-2">
                {d.byRecruiter.map((r) => {
                  const pct = t.revenue ? Math.round((r.revenue / t.revenue) * 100) : 0;
                  return (
                    <div key={r.id}>
                      <div className="flex justify-between text-sm">
                        <span>{r.name}</span>
                        <span className="text-slate-600 tabular-nums">
                          {r.joined}/{r.selected} joined · {money(r.revenue)}
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-slate-100 overflow-hidden mt-0.5">
                        <div className="h-full bg-chip-500" style={{ width: `${Math.max(pct, r.revenue ? 3 : 0)}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {!d?.placements?.length ? (
            <div className="card p-10 text-center">
              <div className="text-chip-900 font-medium">No placements this month.</div>
              <p className="text-sm text-slate-500 mt-1">
                A placement is recorded when a candidate is selected, from the Calls screen.
              </p>
            </div>
          ) : (
            <div className="card overflow-x-auto">
              <table className="w-full text-sm min-w-[1000px]">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-left">
                    <th className="px-4 py-2 font-medium text-slate-600">Candidate</th>
                    <th className="px-4 py-2 font-medium text-slate-600">Client &amp; role</th>
                    <th className="px-4 py-2 font-medium text-slate-600">Recruiter</th>
                    <th className="px-4 py-2 font-medium text-slate-600">Selected</th>
                    <th className="px-4 py-2 font-medium text-slate-600">Joined</th>
                    <th className="px-4 py-2 font-medium text-slate-600 text-right">CTC</th>
                    <th className="px-4 py-2 font-medium text-slate-600 text-right">Fee</th>
                    <th className="px-4 py-2 font-medium text-slate-600">Invoice</th>
                  </tr>
                </thead>
                <tbody>
                  {d.placements.map((p) => (
                    <tr key={p.id} className={
                      "border-b border-slate-100 last:border-0 align-top " +
                      (p.droppedOn ? "bg-red-50/50 opacity-70" : "hover:bg-slate-50/60")
                    }>
                      <td className="px-4 py-3">
                        <div className="font-medium text-chip-900">{p.candidate?.name}</div>
                        <div className="text-xs text-slate-500 tabular-nums">
                          {p.employeeId ? `Emp ${p.employeeId}` : p.candidate?.phone}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div>{p.client?.name}</div>
                        <div className="text-xs text-slate-500">{p.designation} · {p.location}</div>
                      </td>
                      <td className="px-4 py-3 text-xs">{p.recruiter?.name || "—"}</td>
                      <td className="px-4 py-3 whitespace-nowrap">{day(p.selectedOn)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {p.droppedOn ? (
                          <span className="text-red-700 text-xs">
                            dropped {day(p.droppedOn)}
                            {p.dropReason && <div className="text-[11px]">{p.dropReason}</div>}
                          </span>
                        ) : p.joinedOn ? (
                          <>
                            {day(p.joinedOn)}
                            {p.stillReplaceable && (
                              <div className="text-[11px] text-amber-700">
                                replaceable to {day(p.replacementUntil)}
                              </div>
                            )}
                          </>
                        ) : (
                          <input
                            type="date"
                            className="input py-1 text-xs w-auto"
                            onChange={(e) => e.target.value && patch(p.id, { joinedOn: e.target.value })}
                            aria-label="Joining date"
                          />
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{shortMoney(p.ctcOfferedAnnual)}</td>
                      <td className="px-4 py-3 text-right tabular-nums font-medium">
                        {money(p.revenue)}
                        <div className="text-[11px] text-slate-400 font-normal">
                          {p.feeType === "percent" ? `${(p.feeBps / 100).toFixed(2).replace(/\.00$/, "")}%` : "flat"}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <select
                          id={`inv-${p.id}`}
                          className={"input py-1 text-xs w-auto border " + (INVOICE_TONE[p.invoiceStatus] || "")}
                          value={p.invoiceStatus}
                          onChange={(e) => patch(p.id, { invoiceStatus: e.target.value })}
                          aria-label="Invoice status"
                        >
                          {["pending", "raised", "paid", "written-off"].map((s) => (
                            <option key={s} value={s}>{s}</option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-xs text-slate-500 mt-3 max-w-prose">
            Each fee is calculated once, from the rate in force when the candidate was
            selected, and then stored. Renegotiating a rate with a client changes future
            placements only — a closed month never moves.
          </p>
        </>
      )}
    </Shell>
  );
}
