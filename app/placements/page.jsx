"use client";
// Placements — the "Recruiters MTD Performance" tab, with the revenue column
// worked out rather than typed.
//
// Two numbers that the old sheet ran together and this one keeps apart:
// selected and joined. A selection is a promise; only a joining can be
// invoiced. Adding them up together is how a month looks better than it was.
//
// Everything is done on the row. Two of the actions cannot be taken back in any
// useful sense — marking somebody joined, and recording that they dropped out —
// so those two ask a second time, in place, before they are written.

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
function pad(n) {
  return String(n).padStart(2, "0");
}
/** Today as a date input wants it — from the local calendar, never from UTC. */
function todayInput() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

const INVOICE_STATUSES = ["pending", "raised", "paid", "written-off"];

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
  const [note, setNote] = useState("");

  // Per-row drafts, kept on the page rather than inside the row, so a reload
  // half-way through typing a date does not throw the date away.
  const [joinDraft, setJoinDraft] = useState({});
  const [confirmJoin, setConfirmJoin] = useState(null); // { id, date }
  const [drop, setDrop] = useState(null);               // { id, on, reason, confirming }

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

  function flash(msg) {
    setNote(msg);
    setTimeout(() => setNote(""), 4000);
  }

  async function patch(id, body, said) {
    setError("");
    try {
      const r = await fetch(`/api/placements/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(j.error || "That change did not save.");
      } else if (said) {
        flash(said);
      }
      load();
    } catch {
      setError("That change did not save — check your connection.");
    }
  }

  async function markJoined(p) {
    const date = (confirmJoin && confirmJoin.id === p.id && confirmJoin.date) || todayInput();
    setConfirmJoin(null);
    await patch(
      p.id,
      { joinedOn: date },
      `${p.candidate?.name || "The candidate"} has joined. The fee is earned and can be invoiced.`
    );
  }

  async function saveDrop(p) {
    if (!drop || drop.id !== p.id) return;
    const payload = { droppedOn: drop.on || todayInput(), dropReason: drop.reason || "" };
    setDrop(null);
    await patch(p.id, payload, `Drop recorded for ${p.candidate?.name || "the candidate"}.`);
  }

  const t = (d && d.totals) || {};
  const me = (d && d.me) || {};
  const rows = Array.isArray(d && d.placements) ? d.placements : [];
  const byRecruiter = Array.isArray(d && d.byRecruiter) ? d.byRecruiter : [];
  const canWrite = !!me.canWrite;
  const canInvoice = !!me.canInvoice;
  // Fees and revenue are shown only to the roles that hold the MONEY
  // capabilities, never to everyone who can merely read a placement. A team
  // leader runs the desk's work and does not see the desk's money.
  const showMoney = !!me.canSeeMoney;
  const showFees = !!(d && d.showFees);
  const deskWide = !!(d && d.deskWide);
  const cols = 6 + (showMoney ? 2 : 0);

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
      {note && (
        <div role="status" className="card border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 mb-4">
          {note}
        </div>
      )}

      {loading ? (
        <div className="card p-10 text-center text-slate-400">Loading…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
            <Stat label="Selected" value={t.selected ?? 0} note="offers made" />
            <Stat label="Joined" value={t.joined ?? 0} note="actually turned up" tone="text-emerald-700" />
            <Stat
              label="Revenue earned"
              value={showMoney ? shortMoney(t.revenue ?? 0) : "—"}
              note={showMoney ? (deskWide ? "joined only" : "joined only · your own") : "not shown for your role"}
            />
            <Stat
              label="Collected"
              value={showMoney ? shortMoney(t.paid ?? 0) : "—"}
              note={showMoney && t.revenue ? `${Math.round(((t.paid || 0) / t.revenue) * 100)}% of earned` : "—"}
            />
          </div>

          {t.dropped > 0 && (
            <div className="card border-red-200 bg-red-50 p-3 text-sm text-red-800 mb-4">
              <b className="tabular-nums">{t.dropped}</b> placement{t.dropped === 1 ? "" : "s"} dropped
              out this month. Their fees are not counted above.
            </div>
          )}

          {deskWide && byRecruiter.length > 0 && (
            <div className="card p-4 mb-5">
              <div className="text-sm font-medium mb-3">By recruiter</div>
              <div className="space-y-2">
                {byRecruiter.map((r) => {
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

          {rows.length === 0 ? (
            <div className="card p-10 text-center">
              <div className="text-chip-900 font-medium">No placements this month.</div>
              <p className="text-sm text-slate-500 mt-1">
                A placement is recorded from a selected interview, on the Interviews screen.
              </p>
              <a href="/interviews" className="btn-primary mt-4 inline-flex">Go to Interviews</a>
            </div>
          ) : (
            <div className="card overflow-x-auto">
              <table className="w-full text-sm min-w-[1100px]">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-left">
                    <th className="px-4 py-2 font-medium text-slate-600">Candidate</th>
                    <th className="px-4 py-2 font-medium text-slate-600">Client &amp; role</th>
                    <th className="px-4 py-2 font-medium text-slate-600">Recruiter</th>
                    <th className="px-4 py-2 font-medium text-slate-600">Selected</th>
                    <th className="px-4 py-2 font-medium text-slate-600">Joined</th>
                    <th className="px-4 py-2 font-medium text-slate-600 text-right">CTC</th>
                    {showMoney && <th className="px-4 py-2 font-medium text-slate-600 text-right">Fee</th>}
                    {showMoney && <th className="px-4 py-2 font-medium text-slate-600">Invoice</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => {
                    const dropped = !!p.droppedOn;
                    const joined = !!p.joinedOn && !dropped;
                    const dropOpen = !!drop && drop.id === p.id;
                    const askingJoin = !!confirmJoin && confirmJoin.id === p.id;
                    return [
                      <tr
                        key={p.id}
                        className={
                          "border-b border-slate-100 last:border-0 align-top " +
                          (dropped
                            ? "bg-red-50/50 opacity-70"
                            : joined
                            ? "bg-emerald-50/40 hover:bg-emerald-50/70"
                            : "hover:bg-slate-50/60")
                        }
                      >
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
                          {dropped ? (
                            <div className="text-xs text-red-700">
                              <div className="font-medium">Dropped {day(p.droppedOn)}</div>
                              {p.dropReason && <div className="text-[11px]">{p.dropReason}</div>}
                              {p.joinedOn && (
                                <div className="text-[11px] text-slate-500">had joined {day(p.joinedOn)}</div>
                              )}
                              {canWrite && (
                                <button
                                  onClick={() => patch(p.id, { droppedOn: null }, "Drop undone.")}
                                  className="mt-1 text-[11px] text-slate-500 underline hover:text-slate-700"
                                >
                                  undo drop
                                </button>
                              )}
                            </div>
                          ) : joined ? (
                            <div>
                              <span className="inline-block rounded border border-emerald-300 bg-emerald-100 px-1.5 py-0.5 text-[11px] font-medium text-emerald-800">
                                JOINED {day(p.joinedOn)}
                              </span>
                              {p.stillReplaceable && (
                                <div className="text-[11px] text-amber-700 mt-0.5">
                                  replaceable to {day(p.replacementUntil)}
                                </div>
                              )}
                              {canWrite && (
                                <button
                                  onClick={() =>
                                    setDrop(dropOpen ? null : { id: p.id, on: todayInput(), reason: "", confirming: false })
                                  }
                                  className="mt-1 block text-[11px] text-slate-500 underline hover:text-slate-700"
                                >
                                  {dropOpen ? "close" : "record a drop"}
                                </button>
                              )}
                            </div>
                          ) : !canWrite ? (
                            <span className="text-xs text-slate-400">not joined yet</span>
                          ) : askingJoin ? (
                            <div className="rounded border border-emerald-300 bg-emerald-50 p-2">
                              <div className="text-[11px] text-emerald-900 mb-1">
                                Joined on {day(confirmJoin.date)}? This earns the fee.
                              </div>
                              <div className="flex items-center gap-2">
                                <button onClick={() => markJoined(p)} className="btn-primary px-2 py-1 text-xs">
                                  Yes — mark joined
                                </button>
                                <button
                                  onClick={() => setConfirmJoin(null)}
                                  className="text-[11px] text-slate-500 underline hover:text-slate-700"
                                >
                                  cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1">
                              <input
                                type="date"
                                className="input py-1 text-xs w-auto"
                                value={joinDraft[p.id] || todayInput()}
                                onChange={(e) => setJoinDraft((s) => ({ ...s, [p.id]: e.target.value }))}
                                aria-label="Joining date"
                              />
                              <button
                                onClick={() => setConfirmJoin({ id: p.id, date: joinDraft[p.id] || todayInput() })}
                                className="px-2 py-1 text-xs rounded border border-emerald-600 bg-emerald-600 text-white transition hover:bg-emerald-700"
                              >
                                Mark joined
                              </button>
                              <button
                                onClick={() =>
                                  setDrop(dropOpen ? null : { id: p.id, on: todayInput(), reason: "", confirming: false })
                                }
                                className="text-[11px] text-slate-500 underline hover:text-slate-700"
                              >
                                drop
                              </button>
                            </div>
                          )}
                        </td>

                        <td className="px-4 py-3 text-right tabular-nums">{shortMoney(p.ctcOfferedAnnual)}</td>

                        {showMoney && (
                          <td className="px-4 py-3 text-right tabular-nums font-medium">
                            {p.maySeeFee ? (
                              <>
                                <span className={joined ? "text-emerald-800" : "text-slate-400"}>
                                  {money(p.revenue)}
                                </span>
                                <div className="text-[11px] text-slate-400 font-normal">
                                  {dropped ? "not earned — dropped" : joined ? "earned" : "not earned yet"}
                                </div>
                                {showFees && p.feeType && (
                                  <div className="text-[11px] text-slate-400 font-normal">
                                    {p.feeType === "percent" && p.feeBps != null
                                      ? `${(p.feeBps / 100).toFixed(2).replace(/\.00$/, "")}%`
                                      : "flat"}
                                  </div>
                                )}
                              </>
                            ) : (
                              <span className="text-slate-400 font-normal">—</span>
                            )}
                          </td>
                        )}

                        {showMoney && (
                          <td className="px-4 py-3">
                            {!p.maySeeFee && <span className="text-slate-400">—</span>}
                            {p.maySeeFee && (
                              <span
                                className={
                                  "inline-block rounded border px-1.5 py-0.5 text-[11px] " +
                                  (INVOICE_TONE[p.invoiceStatus] || INVOICE_TONE.pending)
                                }
                              >
                                {p.invoiceStatus}
                              </span>
                            )}
                            {p.maySeeFee && canInvoice && (
                              <div className="mt-1 space-y-1">
                                <select
                                  id={`inv-${p.id}`}
                                  className="input py-1 text-xs w-auto"
                                  value={p.invoiceStatus}
                                  onChange={(e) =>
                                    patch(p.id, { invoiceStatus: e.target.value }, `Invoice marked ${e.target.value}.`)
                                  }
                                  aria-label="Invoice status"
                                >
                                  {INVOICE_STATUSES.map((s) => (
                                    <option key={s} value={s}>{s}</option>
                                  ))}
                                </select>
                                {p.invoiceStatus !== "pending" && (
                                  <input
                                    id={`invno-${p.id}`}
                                    className="input py-1 text-xs"
                                    placeholder="Invoice no."
                                    defaultValue={p.invoiceNo || ""}
                                    onBlur={(e) =>
                                      e.target.value !== (p.invoiceNo || "") &&
                                      patch(p.id, { invoiceNo: e.target.value }, "Invoice number saved.")
                                    }
                                    aria-label="Invoice number"
                                  />
                                )}
                              </div>
                            )}
                            {p.maySeeFee && (p.invoicedOn || p.paidOn || (!canInvoice && p.invoiceNo)) && (
                              <div className="text-[11px] text-slate-500 mt-1">
                                {p.invoiceNo && !canInvoice ? <div>{p.invoiceNo}</div> : null}
                                {p.invoicedOn && <div>raised {day(p.invoicedOn)}</div>}
                                {p.paidOn && <div>paid {day(p.paidOn)}</div>}
                              </div>
                            )}
                          </td>
                        )}
                      </tr>,

                      dropOpen ? (
                        <tr key={`${p.id}-drop`} className="border-b border-slate-200 bg-red-50/60">
                          <td colSpan={cols} className="px-4 pb-4 pt-3">
                            <div className="text-sm font-medium text-red-900 mb-2">
                              Record that {p.candidate?.name || "this candidate"} dropped out
                            </div>
                            {p.stillReplaceable && (
                              <p className="text-xs text-amber-800 mb-2 max-w-prose">
                                This is inside the free-replacement window, which runs to{" "}
                                {day(p.replacementUntil)}. Blue Chip owes {p.client?.name || "the client"} a
                                replacement, and the fee is at risk.
                              </p>
                            )}
                            <div className="flex flex-wrap items-end gap-3">
                              <div>
                                <label className="label" htmlFor={`don-${p.id}`}>Dropped on</label>
                                <input
                                  id={`don-${p.id}`}
                                  type="date"
                                  className="input w-auto"
                                  value={drop.on}
                                  onChange={(e) => setDrop((s) => ({ ...s, on: e.target.value, confirming: false }))}
                                />
                              </div>
                              <div className="min-w-[18rem] flex-1">
                                <label className="label" htmlFor={`dwhy-${p.id}`}>Why</label>
                                <input
                                  id={`dwhy-${p.id}`}
                                  className="input"
                                  placeholder="Counter-offer from the current employer, shift timings, never turned up…"
                                  value={drop.reason}
                                  onChange={(e) => setDrop((s) => ({ ...s, reason: e.target.value, confirming: false }))}
                                />
                              </div>
                              {drop.confirming ? (
                                <div className="flex items-center gap-2 pb-0.5">
                                  <button
                                    onClick={() => saveDrop(p)}
                                    className="btn border border-red-600 bg-red-600 text-white hover:bg-red-700"
                                  >
                                    Yes — record the drop
                                  </button>
                                  <button
                                    onClick={() => setDrop((s) => ({ ...s, confirming: false }))}
                                    className="btn-ghost"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              ) : (
                                <div className="flex items-center gap-2 pb-0.5">
                                  <button
                                    onClick={() => setDrop((s) => ({ ...s, confirming: true }))}
                                    className="btn-ghost border-red-300 text-red-800 hover:bg-red-100"
                                  >
                                    Record drop
                                  </button>
                                  <button onClick={() => setDrop(null)} className="btn-ghost">
                                    Cancel
                                  </button>
                                </div>
                              )}
                            </div>
                            <p className="text-[11px] text-slate-500 mt-2 max-w-prose">
                              Nothing is deleted. The selection, the joining date and the fee stay on this
                              row exactly as they were — the drop is recorded alongside them, and the fee
                              stops counting towards the month.
                            </p>
                          </td>
                        </tr>
                      ) : null,
                    ];
                  })}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-xs text-slate-500 mt-3 max-w-prose">
            Each fee is calculated once, from the rate in force when the candidate was
            selected, and then stored. Renegotiating a rate with a client changes future
            placements only — a closed month never moves. A fee counts towards the month
            only once the joining date is recorded.
            {showMoney && !deskWide ? " Fees are shown for your own placements only." : ""}
          </p>
        </>
      )}
    </Shell>
  );
}
