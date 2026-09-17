"use client";
// One person's desk — what they closed, what is live, where they lose people.
//
// The same page whoever opens it. A recruiter opening their own sees everything;
// a recruiter opening a colleague's URL gets their own figures back with a line
// saying so, because the server decides the scope, not the address bar.

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Shell from "@/components/Shell";
import { roleName } from "@/lib/roles";
import { recentMonths, monthLabel } from "@/lib/day";

function inr(n) {
  if (n == null) return "—";
  return `₹${Number(n).toLocaleString("en-IN")}`;
}
function pct(r) {
  // rate() returns null for 0/0, which means "no data", not "zero percent".
  // Printing 0% for an untried stage is the difference between "they are bad at
  // this" and "they have not done it yet".
  return r == null ? "—" : `${r}%`;
}
function dt(x) {
  return x ? new Date(x).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—";
}
function dtime(x) {
  return x ? new Date(x).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "—";
}

export default function PersonPage() {
  const params = useParams();
  const [month, setMonth] = useState(recentMonths(1)[0]);
  const [d, setD] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/people/${params.id}?month=${month}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load this person.");
      setD(j);
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [params.id, month]);

  useEffect(() => { load(); }, [load]);

  return (
    <Shell
      title={d?.person?.name || "Desk"}
      subtitle={d ? `${roleName(d.person.role)} · joined ${dt(d.person.createdAt)}` : ""}
      actions={
        <select aria-label="Month" className="input max-w-[11rem]" value={month} onChange={(e) => setMonth(e.target.value)}>
          {recentMonths(12).map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </select>
      }
    >
      {error && <div role="alert" className="card border-red-200 bg-red-50 p-3 text-sm text-red-800 mb-4">{error}</div>}

      {d?.scopedToSelf && (
        <div className="card border-slate-300 bg-slate-50 p-3 text-sm text-slate-700 mb-4">
          You are seeing your own figures. Only a manager can open someone else&rsquo;s desk.
        </div>
      )}

      {loading ? (
        <div className="card p-10 text-center text-slate-400">Loading…</div>
      ) : !d ? null : (
        <>
          {/* ── the headline pair ──────────────────────────────────────────── */}
          <div className="grid sm:grid-cols-4 gap-3 mb-5">
            <Stat label={`Joined in ${monthLabel(month)}`} value={d.counts.joined} strong />
            <Stat label="Joined all time" value={d.allTime.joinings} />
            <Stat label="Live line-ups" value={d.lineUps.length} />
            <Stat label="Follow-ups due" value={d.counts.followUpsDue}
              tone={d.counts.followUpsDue > 0 ? "text-amber-700" : undefined} />
          </div>

          {/* ── the funnel ─────────────────────────────────────────────────── */}
          <div className="card p-5 mb-5">
            <div className="font-medium text-chip-900 mb-3">Where the month went</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[620px]">
                <thead className="text-left text-slate-500">
                  <tr>
                    <th className="pb-2 font-medium">Calls</th>
                    <th className="pb-2 font-medium">Reached</th>
                    <th className="pb-2 font-medium">Lined up</th>
                    <th className="pb-2 font-medium">Attended</th>
                    <th className="pb-2 font-medium">Selected</th>
                    <th className="pb-2 font-medium">Joined</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="text-lg tabular-nums text-chip-900">
                    <td className="py-1">{d.counts.calls}</td>
                    <td className="py-1">{d.counts.connects}</td>
                    <td className="py-1">{d.counts.lineUps}</td>
                    <td className="py-1">{d.counts.attended}</td>
                    <td className="py-1">{d.counts.selected}</td>
                    <td className="py-1 font-semibold">{d.counts.joined}</td>
                  </tr>
                  <tr className="text-xs text-slate-500">
                    <td className="pt-1" />
                    <td className="pt-1">{pct(d.funnel.rates.connect)}</td>
                    <td className="pt-1">{pct(d.funnel.rates.lineUp)}</td>
                    <td className="pt-1">{pct(d.funnel.rates.show)}</td>
                    <td className="pt-1">{pct(d.funnel.rates.select)}</td>
                    <td className="pt-1">{pct(d.funnel.rates.join)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            {d.weakest && (
              <p className="text-sm text-amber-800 mt-3 max-w-prose">
                Weakest stage: <b>{d.weakest.label}</b> at {pct(d.weakest.r)}. That is where the
                month is being lost, and it is the one worth practising.
              </p>
            )}
            {d.funnel.placementsPerHundredCalls != null && (
              <p className="text-xs text-slate-500 mt-2">
                {d.funnel.placementsPerHundredCalls} joinings per hundred calls. Volume and
                conversion together — a single stage rate hides one of them.
              </p>
            )}
          </div>

          {/* ── live line-ups ──────────────────────────────────────────────── */}
          <div className="card p-5 mb-5">
            <div className="font-medium text-chip-900 mb-2">Lined up</div>
            {d.lineUps.length === 0 ? (
              <p className="text-sm text-slate-500">Nothing in the diary.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {d.lineUps.map((i) => (
                    <tr key={i.id} className="border-t border-slate-100">
                      <td className="py-2">
                        <a href={`/candidates?open=${i.candidateId}`} className="font-medium text-chip-900 hover:underline">
                          {i.candidate}
                        </a>
                        <div className="text-xs text-slate-500">{i.phone}</div>
                      </td>
                      <td className="py-2 text-slate-600">{i.designation}{i.client ? ` · ${i.client}` : ""}</td>
                      <td className="py-2 text-slate-500">{i.mode}</td>
                      <td className="py-2 text-right whitespace-nowrap">{dtime(i.scheduledAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* ── closed ─────────────────────────────────────────────────────── */}
          <div className="card p-5">
            <div className="font-medium text-chip-900 mb-2">Closed in {monthLabel(month)}</div>
            {d.closed.length === 0 ? (
              <p className="text-sm text-slate-500">Nothing closed this month.</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {d.closed.map((p) => (
                    <tr key={p.id} className="border-t border-slate-100">
                      <td className="py-2 font-medium text-chip-900">{p.candidate}</td>
                      <td className="py-2 text-slate-600">{p.designation} · {p.client}</td>
                      <td className="py-2 text-slate-500">
                        selected {dt(p.selectedOn)}
                        {p.joinedOn ? ` · joined ${dt(p.joinedOn)}` : " · not joined yet"}
                        {p.droppedOn && <span className="text-red-700"> · dropped</span>}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {p.revenue == null ? "" : inr(p.revenue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {d.allTime.revenue != null && (
              <p className="text-xs text-slate-500 mt-3">
                All time: {d.allTime.joinings} joinings, {inr(d.allTime.revenue)} billed. A
                selection that never joined is not counted here — it earned the business nothing.
              </p>
            )}
          </div>
        </>
      )}
    </Shell>
  );
}

function Stat({ label, value, strong, tone }) {
  return (
    <div className="card p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={"mt-1 tabular-nums " + (tone || "text-chip-900") + (strong ? " text-2xl font-semibold" : " text-xl")}>
        {value}
      </div>
    </div>
  );
}
