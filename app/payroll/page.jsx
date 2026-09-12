"use client";
// Payroll — what everyone is owed, and the month's achiever.
//
// A recruiter opening this page sees exactly one row: their own. That is not a
// courtesy, it is the reason the payroll.read and payroll.own capabilities are
// separate. The achiever board below it is desk-wide on purpose — it carries
// joinings and revenue, never pay.

import { Fragment, useCallback, useEffect, useState } from "react";
import Shell from "@/components/Shell";
import { recentMonths, monthLabel } from "@/lib/day";

function inr(n) {
  if (n == null) return "—";
  return `₹${Number(n).toLocaleString("en-IN")}`;
}

export default function PayrollPage() {
  const [month, setMonth] = useState(recentMonths(1)[0]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null); // { message, payload }
  const [open, setOpen] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/payroll?month=${month}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load payroll.");
      setData(j);
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => { load(); }, [load]);

  async function act(payload) {
    if (busy) return;
    setBusy(true);
    setError("");
    setFlash("");
    try {
      const r = await fetch("/api/payroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, ...payload }),
      });
      const j = await r.json();
      if (!r.ok) {
        // A 409 asking for confirmation is not an error to swallow — it is the
        // app saying "are you sure", and it must be shown as a question.
        if (j.needsConfirmation) {
          setConfirm({ message: j.error, payload });
          return;
        }
        throw new Error(j.error || "That did not work.");
      }
      setFlash(j.message);
      setConfirm(null);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const locked = data && data.status !== "draft";
  const ach = data?.achiever;

  return (
    <Shell
      title="Payroll"
      subtitle="Salary pro-rated by hours worked, plus incentive on candidates who actually joined."
      actions={
        <div className="flex gap-2">
          <select className="input max-w-[11rem]" value={month} onChange={(e) => setMonth(e.target.value)}>
            {recentMonths(12).map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
          {data?.canLock && (
            locked ? (
              <>
                {data.status === "locked" && (
                  <button className="btn-primary" onClick={() => act({ action: "paid" })} disabled={busy}>
                    Mark paid
                  </button>
                )}
                <button className="btn-ghost" onClick={() => act({ action: "reopen" })} disabled={busy}>
                  Reopen
                </button>
              </>
            ) : (
              <button className="btn-primary" onClick={() => act({ action: "lock" })} disabled={busy}>
                Lock the month
              </button>
            )
          )}
        </div>
      }
    >
      {error && <div role="alert" className="card border-red-200 bg-red-50 p-3 text-sm text-red-800 mb-4">{error}</div>}
      {flash && <div className="card border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 mb-4">{flash}</div>}

      {confirm && (
        <div className="card border-amber-300 bg-amber-50 p-4 mb-4">
          <div className="text-sm text-amber-900">{confirm.message}</div>
          <div className="flex gap-2 mt-3">
            <button
              className="btn-primary"
              disabled={busy}
              onClick={() => act({ ...confirm.payload, confirmEarly: true, confirmMissing: true })}
            >
              Lock anyway
            </button>
            <button className="btn-ghost" onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </div>
      )}

      {locked && (
        <div className="card border-slate-300 bg-slate-50 p-3 text-sm text-slate-700 mb-4">
          {monthLabel(month)} is <strong>{data.status}</strong>. These figures are frozen — correcting
          attendance for this month will not change them. Reopen the month first if something is wrong.
        </div>
      )}

      {loading ? (
        <div className="card p-10 text-center text-slate-400">Loading…</div>
      ) : (
        <>
          {data?.totals && (
            <div className="grid sm:grid-cols-4 gap-3 mb-5">
              <Stat label="People" value={data.totals.people} />
              <Stat label="Salary" value={inr(data.totals.basic)} />
              <Stat label="Incentive" value={inr(data.totals.incentive)} />
              <Stat label="Total to pay" value={inr(data.totals.net)} strong />
            </div>
          )}

          {data?.totals?.needsAttention > 0 && (
            <div className="card border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 mb-4">
              {data.totals.needsAttention} {data.totals.needsAttention === 1 ? "person is" : "people are"} not
              ready to pay — a missing salary, or days with no check-out. Fix those before locking.
            </div>
          )}

          <div className="card overflow-x-auto mb-6">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-slate-500">
                <tr>
                  <th className="p-3 font-medium">Person</th>
                  <th className="p-3 font-medium text-right">Hours</th>
                  <th className="p-3 font-medium text-right">Of month</th>
                  <th className="p-3 font-medium text-right">Salary</th>
                  <th className="p-3 font-medium text-right">Joinings</th>
                  <th className="p-3 font-medium text-right">Incentive</th>
                  <th className="p-3 font-medium text-right">Net</th>
                  <th className="p-3" />
                </tr>
              </thead>
              <tbody>
                {(data?.rows || []).map((r) => (
                  // The key belongs on the Fragment, not on the rows inside it —
                  // a bare <> in a map renders but warns, and the warning is the
                  // only thing that tells you the rows are not being reconciled.
                  <Fragment key={r.userId}>
                    <tr className="border-t border-slate-100">
                      <td className="p-3">
                        <div className="font-medium text-chip-900">{r.name}</div>
                        {r.blocker && <div className="text-xs text-amber-800">{r.blocker}</div>}
                        {r.needsAttention && !r.blocker && (
                          <div className="text-xs text-amber-800">{r.incompleteDays} day(s) with no check-out</div>
                        )}
                      </td>
                      <td className="p-3 text-right tabular-nums">{r.workedHours}</td>
                      <td className="p-3 text-right tabular-nums text-slate-500">{r.proRataPct}%</td>
                      <td className="p-3 text-right tabular-nums">{inr(r.earnedBasic)}</td>
                      <td className="p-3 text-right tabular-nums">{r.joinings || "—"}</td>
                      <td className="p-3 text-right tabular-nums">{r.incentive ? inr(r.incentive) : "—"}</td>
                      <td className="p-3 text-right tabular-nums font-medium">{inr(r.netPay)}</td>
                      <td className="p-3 text-right">
                        <button className="text-xs text-slate-400 hover:text-chip-700"
                          onClick={() => setOpen(open === r.userId ? null : r.userId)}>
                          {open === r.userId ? "Hide" : "Payslip"}
                        </button>
                      </td>
                    </tr>
                    {open === r.userId && (
                      <tr className="border-t border-slate-100 bg-slate-50">
                        <td colSpan={8} className="p-4">
                          <Payslip row={r} month={month} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {/* ── the month's achiever ──────────────────────────────────────── */}
          <div className="card p-5">
            <div className="text-sm text-slate-500 mb-2">Achiever of the month</div>
            {!ach ? (
              <div className="text-slate-500 text-sm">
                Nobody has a joining this month yet. The board fills as candidates join —
                not when they are selected.
              </div>
            ) : (
              <>
                <div className="text-xl font-medium text-chip-900">
                  {ach.name}
                  {ach.sharedWith?.length > 0 && ` — tied with ${ach.sharedWith.join(", ")}`}
                </div>
                <div className="text-sm text-slate-600 mt-1">
                  {ach.joinings} joining{ach.joinings === 1 ? "" : "s"} · {inr(ach.revenue)} billed
                  {ach.runnerUp && ` · runner-up ${ach.runnerUp.name} with ${ach.runnerUp.joinings}`}
                </div>
                {data.board?.length > 1 && (
                  <table className="w-full text-sm mt-4">
                    <tbody>
                      {data.board.map((b, i) => (
                        <tr key={b.userId} className="border-t border-slate-100">
                          <td className="py-2 w-8 text-slate-400">{i + 1}</td>
                          <td className="py-2">{b.name}</td>
                          <td className="py-2 text-right tabular-nums">{b.joinings}</td>
                          <td className="py-2 text-right tabular-nums text-slate-500">{inr(b.revenue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <p className="text-xs text-slate-500 mt-3 max-w-prose">
                  Ranked on joinings first and revenue second. Revenue alone would reward
                  whoever happened to be handed the highest-paying requirement; joinings
                  measure the work.
                </p>
              </>
            )}
          </div>
        </>
      )}
    </Shell>
  );
}

function Stat({ label, value, strong }) {
  return (
    <div className="card p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={"mt-1 tabular-nums " + (strong ? "text-xl font-semibold text-chip-900" : "text-lg text-chip-900")}>
        {value}
      </div>
    </div>
  );
}

function Payslip({ row, month }) {
  return (
    <div className="max-w-xl text-sm">
      <div className="font-medium text-chip-900 mb-2">{row.name} — {monthLabel(month)}</div>
      <Line label="Monthly salary" value={inr(row.monthlyGross)} />
      <Line label="Full month" value={`${row.standardHours} hours`} />
      <Line label="Worked" value={`${row.workedHours} hours (${row.proRataPct}%)`} />
      <Line label="Present" value={`${row.presentDays} days`} />
      <Line label="Paid leave / holiday" value={`${row.paidLeaveDays} days`} />
      <Line label="Absent" value={`${row.absentDays} days`} />
      <div className="border-t border-slate-200 my-2" />
      <Line label="Earned salary" value={inr(row.earnedBasic)} />
      <Line label={`Incentive — ${row.incentiveBasis || "none"}`} value={inr(row.incentive)} />
      {row.deductions > 0 && <Line label="Deductions" value={`− ${inr(row.deductions)}`} />}
      <div className="border-t border-slate-200 my-2" />
      <Line label="Net pay" value={inr(row.netPay)} strong />
      <p className="text-xs text-slate-500 mt-3">
        Salary is pro-rated by hours worked, capped at one full month — extra hours do
        not increase it. Incentive counts only candidates who joined and did not drop.
      </p>
    </div>
  );
}

function Line({ label, value, strong }) {
  return (
    <div className="flex justify-between py-1">
      <span className="text-slate-600">{label}</span>
      <span className={"tabular-nums " + (strong ? "font-semibold text-chip-900" : "text-slate-800")}>{value}</span>
    </div>
  );
}
