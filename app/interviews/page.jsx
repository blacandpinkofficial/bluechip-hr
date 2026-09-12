"use client";
// Interviews — the "Interview Schedules" tab, with the productivity counts
// taken care of.
//
// The four numbers along the top are the ones the old workbook asked someone to
// type into a separate tab every evening: direct line-ups, telephonic line-ups,
// interviews attended, selects. Here they are counts of the rows below. Nobody
// tallies them, so nobody can round them.

import { useCallback, useEffect, useState } from "react";
import Shell from "@/components/Shell";

const WHEN = [
  { key: "today", label: "Today" },
  { key: "upcoming", label: "Upcoming" },
  { key: "past", label: "Past" },
];

const OUTCOMES = ["pending", "selected", "rejected", "on-hold", "no-show"];
const MODES = ["telephonic", "direct", "video"];

const OUTCOME_TONE = {
  pending: "bg-slate-100 text-slate-700 border-slate-300",
  selected: "bg-emerald-100 text-emerald-800 border-emerald-300",
  rejected: "bg-red-100 text-red-800 border-red-300",
  "on-hold": "bg-amber-100 text-amber-900 border-amber-300",
  "no-show": "bg-slate-200 text-slate-700 border-slate-400",
};

function when(dt) {
  const d = new Date(dt);
  return d.toLocaleString("en-IN", {
    weekday: "short", day: "numeric", month: "short",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

function Stat({ label, value, note }) {
  return (
    <div className="card p-4">
      <div className="text-2xl font-semibold tabular-nums text-chip-800">{value}</div>
      <div className="text-sm text-chip-900">{label}</div>
      {note && <div className="text-[11px] text-slate-500 mt-0.5">{note}</div>}
    </div>
  );
}

export default function InterviewsPage() {
  const [tab, setTab] = useState("today");
  const [data, setData] = useState({ interviews: [], counts: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const r = await fetch(`/api/interviews?when=${tab}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load interviews.");
      setData(j);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => { load(); }, [load]);

  async function patch(id, body) {
    setData((d) => ({
      ...d,
      interviews: d.interviews.map((i) => (i.id === id ? { ...i, ...body } : i)),
    }));
    try {
      const r = await fetch("/api/interviews", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...body }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.error || "That change did not save.");
      }
      load();
    } catch {
      setError("That change did not save — check your connection.");
      load();
    }
  }

  const c = data.counts || {};

  return (
    <Shell
      title="Interviews"
      subtitle="Scheduled, attended and the outcome — the productivity figures follow from these rows."
    >
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {WHEN.map((w) => (
          <button
            key={w.key}
            onClick={() => setTab(w.key)}
            className={
              "rounded-full px-3 py-1 text-sm transition " +
              (tab === w.key
                ? "bg-chip-700 text-white"
                : "bg-white border border-slate-300 text-slate-600 hover:bg-slate-50")
            }
          >
            {w.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <Stat label="Direct line-ups" value={c.direct ?? 0} note="counted, not typed" />
        <Stat label="Telephonic" value={c.telephonic ?? 0} />
        <Stat label="Attended" value={c.attended ?? 0} />
        <Stat label="Selected" value={c.selected ?? 0} />
      </div>

      {error && (
        <div role="alert" className="card border-red-200 bg-red-50 p-3 text-sm text-red-800 mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <div className="card p-10 text-center text-slate-400">Loading…</div>
      ) : data.interviews.length === 0 ? (
        <div className="card p-10 text-center">
          <div className="text-chip-900 font-medium">
            {tab === "today" ? "Nothing scheduled today." : tab === "past" ? "No past interviews." : "Nothing scheduled yet."}
          </div>
          <p className="text-sm text-slate-500 mt-1">
            Interviews are booked from a candidate on the Calls screen.
          </p>
          <a href="/candidates" className="btn-primary mt-4 inline-flex">Go to Calls</a>
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm min-w-[900px]">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-left">
                <th className="px-4 py-2 font-medium text-slate-600">When</th>
                <th className="px-4 py-2 font-medium text-slate-600">Candidate</th>
                <th className="px-4 py-2 font-medium text-slate-600">Role &amp; client</th>
                <th className="px-4 py-2 font-medium text-slate-600">Mode</th>
                <th className="px-4 py-2 font-medium text-slate-600">Attended</th>
                <th className="px-4 py-2 font-medium text-slate-600">Outcome</th>
                <th className="px-4 py-2 font-medium text-slate-600">Feedback</th>
              </tr>
            </thead>
            <tbody>
              {data.interviews.map((i) => (
                <tr key={i.id} className="border-b border-slate-100 last:border-0 align-top hover:bg-slate-50/60">
                  <td className="px-4 py-3 whitespace-nowrap">{when(i.scheduledAt)}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-chip-900">{i.candidate?.name}</div>
                    <a href={`tel:${i.candidate?.phone}`} className="text-xs text-chip-600 tabular-nums">
                      {i.candidate?.phone}
                    </a>
                  </td>
                  <td className="px-4 py-3">
                    <div>{i.requirement?.designation}</div>
                    <div className="text-xs text-slate-500">
                      {[i.requirement?.clientName, i.requirement?.location].filter(Boolean).join(" · ")}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <select
                      id={`mode-${i.id}`}
                      className="input py-1 text-xs w-auto"
                      value={i.mode}
                      onChange={(e) => patch(i.id, { mode: e.target.value })}
                      aria-label="Interview mode"
                    >
                      {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      <button
                        onClick={() => patch(i.id, { attended: i.attended === true ? null : true })}
                        className={
                          "px-2 py-1 text-xs rounded border transition " +
                          (i.attended === true
                            ? "bg-emerald-600 text-white border-emerald-600"
                            : "bg-white border-slate-300 text-slate-600 hover:bg-slate-50")
                        }
                      >
                        Came
                      </button>
                      <button
                        onClick={() =>
                          // Clearing the mark must clear the outcome too. Sending
                          // outcome:"no-show" on the way back out left the
                          // interview with no attendance mark but still recorded
                          // as a no-show, which then fed the show rate in Reports.
                          i.attended === false
                            ? patch(i.id, { attended: null, outcome: "pending" })
                            : patch(i.id, { attended: false, outcome: "no-show" })
                        }
                        className={
                          "px-2 py-1 text-xs rounded border transition " +
                          (i.attended === false
                            ? "bg-slate-600 text-white border-slate-600"
                            : "bg-white border-slate-300 text-slate-600 hover:bg-slate-50")
                        }
                      >
                        No-show
                      </button>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <select
                      id={`out-${i.id}`}
                      className={"input py-1 text-xs w-auto border " + (OUTCOME_TONE[i.outcome] || "")}
                      value={i.outcome || "pending"}
                      onChange={(e) => patch(i.id, { outcome: e.target.value })}
                      aria-label="Interview outcome"
                    >
                      {OUTCOMES.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-3 min-w-[14rem]">
                    <input
                      id={`fb-${i.id}`}
                      className="input py-1 text-xs"
                      placeholder="What the client said"
                      defaultValue={i.feedback || ""}
                      onBlur={(e) => e.target.value !== (i.feedback || "") && patch(i.id, { feedback: e.target.value })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-slate-500 mt-3 max-w-prose">
        Recording an outcome marks the interview attended automatically — except
        a no-show, which marks the opposite. The candidate moves with it, forward
        only: a selected candidate is never dragged back by a later stray edit.
      </p>
    </Shell>
  );
}
