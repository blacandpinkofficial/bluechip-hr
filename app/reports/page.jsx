"use client";
// Reports — what the desk did, and where it is losing people.
//
// Charts are hand-drawn SVG rather than a charting library: four small bar
// series don't justify 80 kB of JavaScript on a page that recruiters open on
// whatever laptop the office has.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Shell from "@/components/Shell";

function pct(r) { return r == null ? "—" : `${r}%`; }
function shortMoney(n) {
  if (n == null) return "—";
  const v = Number(n);
  if (v >= 10000000) return "₹" + (v / 10000000).toFixed(1).replace(/\.0$/, "") + "Cr";
  if (v >= 100000) return "₹" + (v / 100000).toFixed(1).replace(/\.0$/, "") + "L";
  if (v >= 1000) return "₹" + Math.round(v / 1000) + "k";
  return "₹" + v;
}

/**
 * A bar chart. Every label names a value the chart actually reaches, and the
 * y-axis top is the real peak rather than a rounded number that makes a quiet
 * week look busy.
 */
function Bars({ series, label, accent = "#2c60a0" }) {
  const peak = Math.max(1, ...series.map((s) => s.count));
  const w = 100 / Math.max(series.length, 1);
  const total = series.reduce((n, s) => n + s.count, 0);

  return (
    <div className="card p-4">
      <div className="flex items-baseline justify-between mb-1">
        <div className="text-sm font-medium text-chip-900">{label}</div>
        <div className="text-xs text-slate-500 tabular-nums">{total} in {series.length} days</div>
      </div>
      <svg viewBox="0 0 100 34" preserveAspectRatio="none" className="w-full h-24" role="img"
           aria-label={`${label}: ${total} over ${series.length} days, peak ${peak}`}>
        {/* A faint line at the peak, so the tallest bar has something to mean. */}
        <line x1="0" y1="2" x2="100" y2="2" stroke="#e2e8f0" strokeWidth="0.3" />
        {series.map((s, i) => {
          const h = (s.count / peak) * 30;
          return (
            <rect
              key={s.date}
              x={i * w + w * 0.15}
              y={32 - h}
              width={w * 0.7}
              height={Math.max(h, s.count ? 0.6 : 0)}
              fill={accent}
              opacity={s.count ? 1 : 0.15}
            >
              <title>{`${s.label}: ${s.count}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="flex justify-between text-[10px] text-slate-400 tabular-nums">
        <span>{series[0]?.label}</span>
        <span>peak {peak}</span>
        <span>{series[series.length - 1]?.label}</span>
      </div>
    </div>
  );
}

/** The funnel as proportional bars — each stage relative to the one before it. */
function Funnel({ counts, rates }) {
  const steps = [
    { label: "Calls made", n: counts.calls, rate: null },
    { label: "Reached someone", n: counts.connects, rate: rates.connect, of: "of calls" },
    { label: "Lined up", n: counts.lineUps, rate: rates.lineUp, of: "of conversations" },
    { label: "Attended", n: counts.attended, rate: rates.show, of: "of line-ups" },
    { label: "Selected", n: counts.selected, rate: rates.select, of: "of attended" },
    { label: "Joined", n: counts.joined, rate: rates.join, of: "of selections" },
  ];
  const top = Math.max(1, counts.calls);

  return (
    <div className="space-y-2">
      {steps.map((s) => (
        <div key={s.label}>
          <div className="flex justify-between text-sm">
            <span className="text-chip-900">{s.label}</span>
            <span className="tabular-nums text-slate-600">
              {s.n}
              {s.rate != null && (
                <span className="text-slate-400"> · {pct(s.rate)} {s.of}</span>
              )}
            </span>
          </div>
          <div className="h-2.5 rounded-full bg-slate-100 overflow-hidden mt-0.5">
            <div
              className="h-full bg-chip-500"
              style={{ width: `${Math.max((s.n / top) * 100, s.n ? 2 : 0)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ReportsPage() {
  const [days, setDays] = useState(14);
  const [user, setUser] = useState("");
  const [d, setD] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const p = new URLSearchParams({ days: String(days) });
      if (user) p.set("user", user);
      const r = await fetch(`/api/reports?${p}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load reports.");
      setD(j);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [days, user]);

  useEffect(() => { load(); }, [load]);

  const t = d?.today || {};

  return (
    <Shell
      title="Reports"
      subtitle="Counted from the work itself — nothing on this page is typed in by anyone."
      actions={
        <div className="flex flex-wrap gap-2 justify-end">
          <Link href="/reports/daily" className="btn-ghost text-sm whitespace-nowrap">
            Daily report
          </Link>
          {d?.deskWide && (
            <select id="who" className="input w-auto" value={user}
              onChange={(e) => setUser(e.target.value)} aria-label="Recruiter">
              <option value="">Whole desk</option>
              {(d.users || []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          )}
          <select id="range" className="input w-auto" value={days}
            onChange={(e) => setDays(Number(e.target.value))} aria-label="Range">
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>
      }
    >
      {error && (
        <div role="alert" className="card border-red-200 bg-red-50 p-3 text-sm text-red-800 mb-4">
          {error}
        </div>
      )}

      {loading || !d ? (
        <div className="card p-10 text-center text-slate-400">Loading…</div>
      ) : (
        <>
          {/* Today — the old productivity row */}
          <div className="card p-4 mb-5">
            <div className="text-sm font-medium text-chip-900 mb-3">
              Today {d.focusId ? "" : "— whole desk"}
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
              {[
                ["Calls", t.calls], ["Connected", t.connects],
                ["Direct line-ups", t.directLineUps], ["Telephonic", t.telephonic],
                ["Attended", t.attended], ["Selects", t.selects],
              ].map(([label, n]) => (
                <div key={label}>
                  <div className="text-2xl font-semibold tabular-nums text-chip-800">{n ?? 0}</div>
                  <div className="text-[11px] text-slate-500 leading-tight">{label}</div>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-slate-400 mt-3">
              This is the &ldquo;Daily productivity&rdquo; row from the old workbook. It is
              no longer typed by anyone.
            </p>
            <Link
              href="/reports/daily"
              className="mt-3 block rounded border border-slate-200 px-3 py-2 text-sm text-chip-800 transition hover:border-chip-300 hover:bg-chip-50/40"
            >
              <b>Open the daily report</b>
              <span className="text-slate-500">
                {" "}— the same day broken out one row per telecaller, with yesterday and the
                day before a click away. This is the other workbook, the one read every evening.
              </span>
            </Link>
          </div>

          <div className="grid lg:grid-cols-2 gap-4 mb-5">
            <div className="card p-4">
              <div className="text-sm font-medium text-chip-900 mb-3">
                Funnel · last {d.days} days
              </div>
              <Funnel counts={d.overall.counts} rates={d.overall.rates} />
              <div className="mt-4 pt-3 border-t border-slate-200 flex items-baseline justify-between">
                <span className="text-sm text-slate-600">Placements per 100 calls</span>
                <span className="text-xl font-semibold tabular-nums text-chip-800">
                  {d.overall.placementsPerHundredCalls ?? "—"}
                </span>
              </div>
              {d.overall.weakest && (
                <div className="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  Weakest link: <b>{d.overall.weakest.label}</b> at {pct(d.overall.weakest.r)}.
                </div>
              )}
              {!d.overall.weakest && d.overall.counts.calls > 0 && (
                <p className="text-xs text-slate-400 mt-3">
                  Not enough volume yet to call out a weak stage — a single no-show out of
                  two is not a finding.
                </p>
              )}
            </div>

            <div className="space-y-4">
              <Bars series={d.series.calls} label="Calls per day" />
              <Bars series={d.series.interviews} label="Interviews scheduled" accent="#9a6b1f" />
            </div>
          </div>

          {d.deskWide && d.byUser?.length > 0 && (
            <div className="card overflow-x-auto">
              <div className="p-4 pb-2 text-sm font-medium text-chip-900">By recruiter</div>
              <table className="w-full text-sm min-w-[900px]">
                <thead>
                  <tr className="bg-slate-50 border-y border-slate-200 text-left">
                    <th className="px-4 py-2 font-medium text-slate-600">Recruiter</th>
                    <th className="px-4 py-2 font-medium text-slate-600 text-right">Calls</th>
                    <th className="px-4 py-2 font-medium text-slate-600 text-right">Connect</th>
                    <th className="px-4 py-2 font-medium text-slate-600 text-right">Line-ups</th>
                    <th className="px-4 py-2 font-medium text-slate-600 text-right">Show</th>
                    <th className="px-4 py-2 font-medium text-slate-600 text-right">Selects</th>
                    <th className="px-4 py-2 font-medium text-slate-600 text-right">Joined</th>
                    <th className="px-4 py-2 font-medium text-slate-600 text-right">Per 100 calls</th>
                    <th className="px-4 py-2 font-medium text-slate-600">Weakest link</th>
                  </tr>
                </thead>
                <tbody>
                  {d.byUser.map((u) => (
                    <tr key={u.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                      <td className="px-4 py-3">
                        <button onClick={() => setUser(u.id)} className="font-medium text-chip-800 hover:underline">
                          {u.name}
                        </button>
                        <div className="text-[11px] text-slate-400">{u.role}</div>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{u.counts.calls}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-600">{pct(u.rates.connect)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{u.counts.lineUps}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-600">{pct(u.rates.show)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{u.counts.selected}</td>
                      <td className="px-4 py-3 text-right tabular-nums font-medium">{u.counts.joined}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{u.placementsPerHundredCalls ?? "—"}</td>
                      <td className="px-4 py-3 text-xs text-slate-600">
                        {u.weakest ? `${u.weakest.label} (${pct(u.weakest.r)})` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-slate-500 p-4 pt-3 max-w-prose">
                Five rates, not one. Judge a desk on joinings alone and it learns to chase
                easy roles; judge it on calls alone and it learns to dial and hang up.
                &ldquo;Per 100 calls&rdquo; is the one that survives both.
                A blank weakest link means not enough volume to say anything yet.
              </p>
            </div>
          )}

          {d.deskWide && d.revenue != null && (
            <div className="card p-4 mt-4">
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-slate-600">Revenue from joinings in this period</span>
                <span className="text-2xl font-semibold tabular-nums text-chip-800">
                  {shortMoney(d.revenue)}
                </span>
              </div>
            </div>
          )}
        </>
      )}
    </Shell>
  );
}
