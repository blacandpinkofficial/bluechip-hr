"use client";
// Attendance — one big button for the person, a grid for the manager.
//
// The person's half is deliberately one tap and nothing else. Anything that
// takes longer than a tap does not get done at 9am, and attendance that is not
// marked is attendance that gets reconstructed from memory at month end, which
// is how payroll arguments start.

import { useCallback, useEffect, useState } from "react";
import Shell from "@/components/Shell";
import { recentMonths, monthLabel, timeLabel } from "@/lib/day";

const STATUS_TONE = {
  present: "bg-emerald-50 text-emerald-800 border-emerald-200",
  leave: "bg-amber-50 text-amber-900 border-amber-200",
  holiday: "bg-sky-50 text-sky-800 border-sky-200",
  "week-off": "bg-slate-100 text-slate-600 border-slate-300",
  absent: "bg-red-50 text-red-800 border-red-200",
  "half-day": "bg-violet-50 text-violet-800 border-violet-200",
};

const STATUSES = ["present", "leave", "holiday", "week-off", "half-day", "absent"];

function dayLabel(d) {
  return new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", weekday: "short", timeZone: "UTC" });
}

export default function AttendancePage() {
  const [month, setMonth] = useState(recentMonths(1)[0]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null); // { userId, name, day, status, note }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/attendance?month=${month}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load attendance.");
      setData(j);
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => { load(); }, [load]);

  async function tap(action) {
    if (busy) return;
    setBusy(true);
    setError("");
    setFlash("");
    try {
      const r = await fetch("/api/attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "That did not save.");
      setFlash(j.message);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveMark(e) {
    e.preventDefault();
    if (!editing || busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: editing.userId,
          day: editing.day,
          status: editing.status,
          note: editing.note,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "That did not save.");
      setFlash(j.message);
      setEditing(null);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const mine = data?.mine;
  const checkedIn = !!mine?.checkIn;
  const checkedOut = !!mine?.checkOut;

  return (
    <Shell
      title="Attendance"
      subtitle="One tap in, one tap out. Hours worked are what pay is calculated from."
      actions={
        <select aria-label="Month" className="input max-w-[11rem]" value={month} onChange={(e) => setMonth(e.target.value)}>
          {recentMonths(12).map((m) => (
            <option key={m} value={m}>{monthLabel(m)}</option>
          ))}
        </select>
      }
    >
      {error && <div role="alert" className="card border-red-200 bg-red-50 p-3 text-sm text-red-800 mb-4">{error}</div>}
      {flash && <div className="card border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 mb-4">{flash}</div>}

      {/* ── the person's own day ─────────────────────────────────────────── */}
      <div className="card p-5 mb-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="text-sm text-slate-500">Today</div>
            <div className="text-lg font-medium text-chip-900">
              {checkedOut
                ? `In at ${timeLabel(mine.checkIn)}, out at ${timeLabel(mine.checkOut)}${mine.hours != null ? ` — ${mine.hours} hours` : ""}`
                : checkedIn
                ? `Checked in at ${timeLabel(mine.checkIn)}`
                : "Not checked in yet"}
            </div>
            {checkedIn && !checkedOut && (
              <p className="text-xs text-slate-500 mt-1">
                Remember to check out. A day with no check-out counts as no hours, not a full day.
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <button className="btn-primary" onClick={() => tap("in")} disabled={busy || checkedIn}>
              Check in
            </button>
            <button className="btn-ghost" onClick={() => tap("out")} disabled={busy || !checkedIn || checkedOut}>
              Check out
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="card p-10 text-center text-slate-400">Loading…</div>
      ) : (
        <>
          {/* ── the month's totals ───────────────────────────────────────── */}
          {data?.people?.length > 0 && (
            <div className="card overflow-x-auto mb-6">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-slate-500">
                  <tr>
                    <th className="p-3 font-medium">{data.seesDesk ? "Person" : "You"}</th>
                    <th className="p-3 font-medium text-right">Hours</th>
                    <th className="p-3 font-medium text-right">Present</th>
                    <th className="p-3 font-medium text-right">Paid leave</th>
                    <th className="p-3 font-medium text-right">Absent</th>
                    <th className="p-3 font-medium text-right">Overtime</th>
                    <th className="p-3 font-medium">Needs fixing</th>
                  </tr>
                </thead>
                <tbody>
                  {data.people.map((p) => (
                    <tr key={p.user.id} className="border-t border-slate-100">
                      <td className="p-3 font-medium text-chip-900">{p.user.name}</td>
                      <td className="p-3 text-right tabular-nums">{p.workedHours}</td>
                      <td className="p-3 text-right tabular-nums">{p.presentDays}</td>
                      <td className="p-3 text-right tabular-nums">{p.paidLeaveDays}</td>
                      <td className="p-3 text-right tabular-nums">{p.absentDays}</td>
                      <td className="p-3 text-right tabular-nums">{p.overtimeHours || "—"}</td>
                      <td className="p-3">
                        {p.incompleteDays > 0 ? (
                          <span className="text-amber-800 text-xs">
                            {p.incompleteDays} day{p.incompleteDays === 1 ? "" : "s"} with no check-out
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ── the days themselves ──────────────────────────────────────── */}
          {data?.rows?.length === 0 ? (
            <div className="card p-10 text-center">
              <div className="text-chip-900 font-medium">Nothing marked for {monthLabel(month)}.</div>
              <p className="text-sm text-slate-500 mt-1">Check in above, and the day appears here.</p>
            </div>
          ) : (
            <div className="card overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-slate-500">
                  <tr>
                    <th className="p-3 font-medium">Day</th>
                    {data?.seesDesk && <th className="p-3 font-medium">Person</th>}
                    <th className="p-3 font-medium">In</th>
                    <th className="p-3 font-medium">Out</th>
                    <th className="p-3 font-medium text-right">Hours</th>
                    <th className="p-3 font-medium">Status</th>
                    {data?.canEdit && <th className="p-3" />}
                  </tr>
                </thead>
                <tbody>
                  {(data?.rows || []).map((r) => (
                    <tr key={r.id} className="border-t border-slate-100">
                      <td className="p-3 whitespace-nowrap">{dayLabel(r.day)}</td>
                      {data.seesDesk && <td className="p-3">{r.user?.name}</td>}
                      <td className="p-3">{timeLabel(r.checkIn)}</td>
                      <td className="p-3">
                        {r.incomplete ? (
                          <span className="text-amber-700">missing</span>
                        ) : (
                          timeLabel(r.checkOut)
                        )}
                      </td>
                      <td className="p-3 text-right tabular-nums">{r.hours ?? "—"}</td>
                      <td className="p-3">
                        <span className={"text-[11px] px-2 py-0.5 rounded border " + (STATUS_TONE[r.status] || STATUS_TONE.present)}>
                          {r.status}
                        </span>
                        {r.source === "manager" && (
                          <span className="text-[11px] text-slate-400 ml-2">corrected</span>
                        )}
                      </td>
                      {data.canEdit && (
                        <td className="p-3 text-right">
                          <button
                            className="text-xs text-slate-400 hover:text-chip-700"
                            onClick={() =>
                              setEditing({
                                userId: r.userId,
                                name: r.user?.name,
                                day: String(r.day).slice(0, 10),
                                status: r.status,
                                note: r.note || "",
                              })
                            }
                          >
                            Correct
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {editing && (
        <form onSubmit={saveMark} className="card p-5 mt-5 max-w-lg">
          <div className="font-medium text-chip-900 mb-3">
            {editing.name} — {editing.day}
          </div>
          <label htmlFor="e-status" className="label">Status</label>
          <select id="e-status" className="input" value={editing.status}
            onChange={(e) => setEditing({ ...editing, status: e.target.value })}>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <div className="mt-3">
            <label htmlFor="e-note" className="label">Why (the person can see this)</label>
            <input id="e-note" className="input" value={editing.note}
              placeholder="Forgot to check out — confirmed left at 6pm"
              onChange={(e) => setEditing({ ...editing, note: e.target.value })} />
          </div>
          <div className="flex gap-2 mt-4">
            <button type="submit" className="btn-primary" disabled={busy}>Save</button>
            <button type="button" className="btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
          </div>
          <p className="text-xs text-slate-500 mt-3">
            Correcting a day changes what that person is paid. The change is recorded
            against your name.
          </p>
        </form>
      )}

      <p className="text-xs text-slate-500 mt-4 max-w-prose">
        Pay is calculated from hours actually worked, not from the number of days with
        a row. A six-hour day on an eight-hour shift is six-eighths of that day&rsquo;s pay.
        Days with no check-out count as no hours until someone fixes them, which is why
        they are listed rather than quietly averaged.
      </p>
    </Shell>
  );
}
