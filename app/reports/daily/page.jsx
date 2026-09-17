"use client";
// Daily report — the sheet the desk was actually run from, one day at a time.
//
// This replaces the "recruiters daily report" workbook. That sheet existed to
// answer one question every evening: who worked today and who didn't. It could
// not really answer it, because the only column anyone filled in was the call
// count, and a call count on its own says nothing — sixty calls that reached
// four people and six calls that reached four people are two different
// problems, and only one of them is about effort.
//
// So the ratio travels next to the count in every row, and each row carries a
// one-line reading of the day. Nothing here is typed by anyone: every figure is
// a count of rows that already exist.
//
// No modal, no dialog. The date bar is at the top of the page where it can be
// reached with a thumb, and the whole thing survives a 400px screen — the table
// scrolls sideways inside its card with the name column pinned, which is the
// same shape the rest of this app uses for a wide table.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Shell from "@/components/Shell";
import { ROLE_LABELS } from "@/lib/roles";
import { rupees } from "@/lib/money";
import { timeLabel } from "@/lib/day";

// Literal, never built from a variable. A class name assembled at runtime is a
// class name Tailwind's scanner never saw, so it is not in the stylesheet and
// the colour silently does not happen.
const FLAG_TONE = {
  idle: "bg-red-50 text-red-800 border-red-200",
  off: "bg-slate-100 text-slate-600 border-slate-300",
  check: "bg-amber-50 text-amber-900 border-amber-200",
  "low-connect": "bg-amber-50 text-amber-900 border-amber-200",
  thin: "bg-amber-50 text-amber-900 border-amber-200",
  ok: "bg-emerald-50 text-emerald-800 border-emerald-200",
};

const FLAG_LABEL = {
  idle: "Nothing logged",
  off: "Off",
  check: "Check",
  "low-connect": "Low connect",
  thin: "Thin day",
  ok: "Worked",
};

// Same palette the attendance screen uses, so a status means the same thing
// wherever it is seen.
const STATUS_TONE = {
  present: "bg-emerald-50 text-emerald-800 border-emerald-200",
  leave: "bg-amber-50 text-amber-900 border-amber-200",
  holiday: "bg-sky-50 text-sky-800 border-sky-200",
  "week-off": "bg-slate-100 text-slate-600 border-slate-300",
  "half-day": "bg-violet-50 text-violet-800 border-violet-200",
  absent: "bg-red-50 text-red-800 border-red-200",
};

const BAND_TEXT = {
  none: "text-slate-400",
  bad: "text-red-700",
  fair: "text-amber-800",
  good: "text-emerald-700",
};

function pct(r) {
  return r == null ? "—" : `${r}%`;
}

/**
 * How to read a connect rate — but only when there is enough volume behind it.
 * One connect out of two is not a fifty per cent day, and a screen that says it
 * is trains people to stop believing the screen.
 */
function band(calls, r, floor, poor) {
  if (!calls || r == null || calls < floor) return "none";
  if (r < poor) return "bad";
  if (r < poor + 15) return "fair";
  return "good";
}

function SectionHead({ title, note, children }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
      <h2 className="text-sm font-medium text-chip-900">
        {title}
        {note && <span className="text-slate-400 font-normal"> · {note}</span>}
      </h2>
      {children}
    </div>
  );
}

function Tile({ label, value, note }) {
  return (
    <div className="card p-4">
      <div className="text-2xl sm:text-3xl font-semibold tabular-nums text-chip-800 break-words">
        {value}
      </div>
      <div className="text-sm font-medium text-chip-900 mt-1">{label}</div>
      {note && <div className="text-xs text-slate-500 mt-0.5 leading-tight">{note}</div>}
    </div>
  );
}

/** A number, with the desk's busiest value drawn faintly behind it. */
function CallCell({ n, peak }) {
  return (
    <div>
      <div className="tabular-nums text-chip-900 font-medium">{n}</div>
      <div className="h-1 rounded-full bg-slate-100 overflow-hidden mt-1 w-16">
        <div
          className="h-full bg-chip-500"
          style={{ width: `${Math.min(100, Math.max((n / Math.max(peak, 1)) * 100, n ? 3 : 0))}%` }}
        />
      </div>
    </div>
  );
}

function Num({ n, strong }) {
  if (!n) return <span className="text-slate-300 tabular-nums">0</span>;
  return (
    <span className={"tabular-nums " + (strong ? "font-medium text-chip-900" : "text-chip-800")}>
      {n}
    </span>
  );
}

export default function DailyReportPage() {
  // Empty until the server says what day it is. The browser must never be the
  // thing that decides which day this desk is looking at.
  const [date, setDate] = useState("");
  const [d, setD] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const p = new URLSearchParams();
      if (date) p.set("date", date);
      const qs = p.toString();
      const r = await fetch(`/api/reports/daily${qs ? `?${qs}` : ""}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load the daily report.");
      setD(j);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => { load(); }, [load]);

  const rows = Array.isArray(d?.rows) ? d.rows : [];
  const t = d?.totals || {};
  const th = d?.thresholds || { fullDayCalls: 25, rateFloor: 10, poorConnectPct: 25 };
  const peak = rows.reduce((n, r) => Math.max(n, r.calls || 0), 0);
  // The empty string means "whatever day the server thinks it is", which is the
  // state this page starts in. Once the server has answered, the picker shows
  // the day it answered for — echoing it back into state would only cost a
  // second identical fetch of an eight-table aggregate.
  const shown = date || d?.date || "";

  return (
    <Shell
      title="Daily report"
      subtitle={`One row per ${ROLE_LABELS.recruiter.toLowerCase()}, for one day. This is the evening sheet — counted from the work itself, so nobody fills it in.`}
      actions={
        <Link href="/reports" className="btn-ghost text-sm whitespace-nowrap">
          Trends &amp; funnel
        </Link>
      }
    >
      {/* ── the day ───────────────────────────────────────────────────────── */}
      <div className="card p-4 mb-5">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-ghost text-sm"
            onClick={() => d?.prevDate && setDate(d.prevDate)}
            disabled={loading || !d?.prevDate}
          >
            ← Previous day
          </button>
          <button
            type="button"
            className="btn-ghost text-sm"
            onClick={() => d?.nextDate && setDate(d.nextDate)}
            disabled={loading || !d?.nextDate}
          >
            Next day →
          </button>
          <label htmlFor="day" className="sr-only">Day</label>
          <input
            id="day"
            type="date"
            className="input w-auto"
            value={shown}
            max={d?.today || undefined}
            onChange={(e) => e.target.value && setDate(e.target.value)}
          />
          <button
            type="button"
            className="btn-ghost text-sm"
            onClick={() => d?.today && setDate(d.today)}
            disabled={loading || !d || d.isToday}
          >
            Today
          </button>
        </div>
        <div className="mt-3 text-lg font-medium text-chip-900 leading-tight">
          {d?.dateLabel || "…"}
          {d?.isToday && <span className="text-sm text-slate-400 font-normal"> · so far today</span>}
        </div>
        {d && d.deskWide && (
          <p className="text-sm text-slate-500 mt-0.5">
            {d.worked} of {d.onDesk} on the desk logged something.
            {d.worked < d.onDesk && " The blank rows are at the bottom."}
          </p>
        )}
        {d && !d.deskWide && (
          <p className="text-sm text-slate-500 mt-0.5">Your own day. Everyone sees their own.</p>
        )}
      </div>

      {error && (
        <div role="alert" className="card border-red-200 bg-red-50 p-3 text-sm text-red-800 mb-4">
          {error}
        </div>
      )}

      {loading && !d ? (
        <div className="card p-10 text-center text-slate-400">Loading…</div>
      ) : !d ? null : (
        <>
          {/* ── the day in six numbers ────────────────────────────────────── */}
          <section className={loading ? "opacity-50 transition" : "transition"}>
            <SectionHead
              title={d.deskWide ? "The desk, this day" : "Your day"}
              note="counted, never typed"
            />
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <Tile
                label="Calls"
                value={t.calls ?? 0}
                note={`${t.connects ?? 0} reached — ${pct(t.connectRate)} of them`}
              />
              <Tile
                label="CVs sent"
                value={t.submissions ?? 0}
                note={`${t.newCandidates ?? 0} new ${t.newCandidates === 1 ? "candidate" : "candidates"} added`}
              />
              <Tile
                label="Interviews"
                value={t.lineUps ?? 0}
                note={`${t.attended ?? 0} attended · ${t.selected ?? 0} selected`}
              />
              <Tile
                label="Callbacks kept"
                value={`${t.callbacksKept ?? 0}/${t.callbacksDue ?? 0}`}
                note={
                  t.callbacksDue
                    ? "promised for this day, and rung back"
                    : "nobody was owed a call back on this day"
                }
              />
              <Tile
                label="Joined"
                value={t.joined ?? 0}
                note="a selection is a promise; only a joining is real"
              />
              {d.showMoney ? (
                <Tile
                  label="Billable"
                  value={rupees(t.revenue ?? 0, { short: true })}
                  note="from the joinings on this day"
                />
              ) : (
                <Tile
                  label="Selections"
                  value={t.selected ?? 0}
                  note="interviews on this day that ended in a yes"
                />
              )}
            </div>
          </section>

          {/* ── one row per recruiter ─────────────────────────────────────── */}
          <section className="mt-7">
            <SectionHead
              title={d.deskWide ? `Every ${ROLE_LABELS.recruiter.toLowerCase()}` : "You"}
              note={d.deskWide ? "busiest first, blank days last" : null}
            />

            {rows.length === 0 ? (
              <div className="card p-10 text-center">
                <div className="text-chip-900 font-medium">No rows for this day.</div>
                <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
                  Everyone on the phones gets a row here whether or not they logged anything,
                  so an empty table means there are no {ROLE_LABELS.recruiter.toLowerCase()} accounts yet — not that the
                  desk was quiet. Add the team and this fills itself in.
                </p>
              </div>
            ) : (
              <div className="card overflow-x-auto">
                <table className="w-full text-sm min-w-[64rem]">
                  <thead>
                    <tr className="bg-slate-50 border-y border-slate-200 text-left">
                      <th className="px-4 py-2 font-medium text-slate-600 sticky left-0 bg-slate-50 z-10 min-w-[11rem]">
                        {ROLE_LABELS.recruiter}
                      </th>
                      <th className="px-3 py-2 font-medium text-slate-600 text-right">Calls</th>
                      <th className="px-3 py-2 font-medium text-slate-600 text-right">Reached</th>
                      <th className="px-3 py-2 font-medium text-slate-600 text-right">New</th>
                      <th className="px-3 py-2 font-medium text-slate-600 text-right">CVs sent</th>
                      <th className="px-3 py-2 font-medium text-slate-600 text-right">Lined up</th>
                      <th className="px-3 py-2 font-medium text-slate-600 text-right">Attended</th>
                      <th className="px-3 py-2 font-medium text-slate-600 text-right">Selected</th>
                      <th className="px-3 py-2 font-medium text-slate-600 text-right">Joined</th>
                      <th className="px-3 py-2 font-medium text-slate-600 text-right">Callbacks</th>
                      {d.showMoney && (
                        <th className="px-3 py-2 font-medium text-slate-600 text-right">Billable</th>
                      )}
                      <th className="px-4 py-2 font-medium text-slate-600 min-w-[16rem]">
                        How the day read
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className="border-b border-slate-100 last:border-0 align-top">
                        <td className="px-4 py-3 sticky left-0 bg-white z-10">
                          <div className="font-medium text-chip-900 leading-tight">{r.name}</div>
                          <div className="text-[11px] text-slate-400">{r.roleLabel}</div>
                          {r.attendance ? (
                            <span
                              className={
                                "inline-block mt-1 text-[11px] px-2 py-0.5 rounded border " +
                                (STATUS_TONE[r.attendance.status] || STATUS_TONE.present)
                              }
                              title={
                                r.attendance.checkIn
                                  ? `In at ${timeLabel(r.attendance.checkIn)}`
                                  : "No check-in recorded"
                              }
                            >
                              {r.attendance.status}
                            </span>
                          ) : (
                            <span className="inline-block mt-1 text-[11px] text-slate-300">
                              not marked
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-right">
                          <div className="inline-flex flex-col items-end">
                            <CallCell n={r.calls} peak={peak} />
                          </div>
                        </td>
                        <td className="px-3 py-3 text-right">
                          <div className="tabular-nums text-chip-800">{r.connects}</div>
                          <div
                            className={
                              "text-[11px] tabular-nums " +
                              (BAND_TEXT[band(r.calls, r.connectRate, th.rateFloor, th.poorConnectPct)] ||
                                BAND_TEXT.none)
                            }
                          >
                            {pct(r.connectRate)}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-right"><Num n={r.newCandidates} /></td>
                        <td className="px-3 py-3 text-right"><Num n={r.submissions} /></td>
                        <td className="px-3 py-3 text-right"><Num n={r.lineUps} /></td>
                        <td className="px-3 py-3 text-right"><Num n={r.attended} /></td>
                        <td className="px-3 py-3 text-right"><Num n={r.selected} strong /></td>
                        <td className="px-3 py-3 text-right"><Num n={r.joined} strong /></td>
                        <td className="px-3 py-3 text-right">
                          {r.callbacksDue ? (
                            <span
                              className={
                                "tabular-nums " +
                                (r.callbacksKept === r.callbacksDue
                                  ? "text-emerald-700"
                                  : r.callbacksKept === 0
                                  ? "text-red-700"
                                  : "text-amber-800")
                              }
                            >
                              {r.callbacksKept}/{r.callbacksDue}
                            </span>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </td>
                        {d.showMoney && (
                          <td className="px-3 py-3 text-right tabular-nums text-chip-800">
                            {r.revenue ? rupees(r.revenue, { short: true }) : <span className="text-slate-300">—</span>}
                          </td>
                        )}
                        <td className="px-4 py-3">
                          <span
                            className={
                              "inline-block text-[11px] px-2 py-0.5 rounded border " +
                              (FLAG_TONE[r.flag] || FLAG_TONE.off)
                            }
                          >
                            {FLAG_LABEL[r.flag] || "—"}
                          </span>
                          {r.note && (
                            <div className="text-xs text-slate-500 mt-1 leading-snug">{r.note}</div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-50 border-t border-slate-200">
                      <td className="px-4 py-3 sticky left-0 bg-slate-50 z-10 font-medium text-chip-900">
                        Whole desk
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums font-medium text-chip-900">
                        {t.calls ?? 0}
                      </td>
                      <td className="px-3 py-3 text-right">
                        <div className="tabular-nums font-medium text-chip-900">{t.connects ?? 0}</div>
                        <div className="text-[11px] tabular-nums text-slate-500">{pct(t.connectRate)}</div>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums font-medium">{t.newCandidates ?? 0}</td>
                      <td className="px-3 py-3 text-right tabular-nums font-medium">{t.submissions ?? 0}</td>
                      <td className="px-3 py-3 text-right tabular-nums font-medium">{t.lineUps ?? 0}</td>
                      <td className="px-3 py-3 text-right tabular-nums font-medium">{t.attended ?? 0}</td>
                      <td className="px-3 py-3 text-right tabular-nums font-medium">{t.selected ?? 0}</td>
                      <td className="px-3 py-3 text-right tabular-nums font-medium">{t.joined ?? 0}</td>
                      <td className="px-3 py-3 text-right tabular-nums font-medium">
                        {t.callbacksDue ? `${t.callbacksKept}/${t.callbacksDue}` : "—"}
                      </td>
                      {d.showMoney && (
                        <td className="px-3 py-3 text-right tabular-nums font-medium text-chip-900">
                          {rupees(t.revenue ?? 0, { short: true })}
                        </td>
                      )}
                      <td className="px-4 py-3" />
                    </tr>
                  </tfoot>
                </table>

                <p className="text-xs text-slate-500 p-4 max-w-prose">
                  <b>Calls</b> and <b>Reached</b> belong together. A day of {th.fullDayCalls} calls
                  reaching a quarter of them is a list problem; a day of six calls is not, whatever
                  the percentage says. The rate is only coloured once there are at least{" "}
                  {th.rateFloor} calls behind it, because one connect out of two is not a fifty per
                  cent day. <b>Callbacks</b> counts the people someone promised to ring back on this
                  day and then actually rang, at or after the hour they promised — the column the
                  old sheet had and nobody could fill in honestly, because it needed yesterday&rsquo;s
                  page open next to today&rsquo;s. Interviews are counted against whoever owns the
                  candidate, not whoever typed the row in.
                </p>
              </div>
            )}
          </section>

          <p className="text-xs text-slate-500 mt-6 max-w-prose">
            The day is the Indian working day, decided on the server from the server&rsquo;s clock:
            midnight to midnight IST, so a night shift&rsquo;s calls land on the night they were
            made and not split across two pages. Somebody with no row at all is somebody
            with no account — everyone on the phones gets a row here every day, even an empty one,
            because the empty one is the thing this page exists to show.
            {d.showMoney
              ? " Money is shown to owners and managers. Team leaders see the same work with the billable column absent."
              : ""}
          </p>
        </>
      )}
    </Shell>
  );
}
