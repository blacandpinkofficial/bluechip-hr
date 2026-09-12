"use client";
// Submissions — which CV went to which client, when, and what came back.
//
// The column that earns this screen its place is "days silent". Everything else
// here could be reconstructed from someone's sent folder; that one could not,
// and it is the one that turns "I sent it last week" into "chase this today".

import { useCallback, useEffect, useState } from "react";
import Shell from "@/components/Shell";

const TONE = {
  sent: "bg-slate-100 text-slate-700 border-slate-300",
  acknowledged: "bg-sky-50 text-sky-800 border-sky-200",
  shortlisted: "bg-violet-50 text-violet-800 border-violet-200",
  "interview-scheduled": "bg-amber-50 text-amber-900 border-amber-200",
  rejected: "bg-red-50 text-red-800 border-red-200",
  "no-response": "bg-slate-100 text-slate-500 border-slate-300",
};

function dt(x) {
  return x ? new Date(x).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—";
}

export default function SubmissionsPage() {
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/submissions${filter ? `?status=${filter}` : ""}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load submissions.");
      setData(j);
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  async function update(id, body) {
    try {
      const r = await fetch("/api/submissions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...body }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "That did not save.");
      setEditing(null);
      setFlash("Saved.");
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <Shell
      title="Submissions"
      subtitle="Every CV sent to a client, with the date it went and whether they ever replied."
      actions={
        <select className="input max-w-[13rem]" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All</option>
          {(data?.statuses || []).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      }
    >
      {error && <div role="alert" className="card border-red-200 bg-red-50 p-3 text-sm text-red-800 mb-4">{error}</div>}
      {flash && <div className="card border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 mb-4">{flash}</div>}

      {data && !data.mailConfigured && (
        <div className="card border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 mb-4">
          Email is not set up, so submissions can be recorded here but not sent from the app.
          Settings → Email.
        </div>
      )}

      {data?.silent > 0 && (
        <div className="card border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 mb-4">
          {data.silent} submission{data.silent === 1 ? " has" : "s have"} had no reply for four days or more.
          Chase them — the candidate is being placed by somebody else in the meantime.
        </div>
      )}

      {loading ? (
        <div className="card p-10 text-center text-slate-400">Loading…</div>
      ) : data.submissions.length === 0 ? (
        <div className="card p-10 text-center">
          <div className="text-chip-900 font-medium">Nothing sent yet.</div>
          <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
            Send a CV from the candidate&rsquo;s screen and it is recorded here — with the date,
            which matters if two agencies ever claim the same candidate.
          </p>
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm min-w-[820px]">
            <thead className="bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="p-3 font-medium">Candidate</th>
                <th className="p-3 font-medium">Client</th>
                <th className="p-3 font-medium">For</th>
                <th className="p-3 font-medium">Sent</th>
                <th className="p-3 font-medium text-right">Silent</th>
                <th className="p-3 font-medium">Status</th>
                <th className="p-3 font-medium">By</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {data.submissions.map((s) => (
                <tr key={s.id} className="border-t border-slate-100">
                  <td className="p-3">
                    <div className="font-medium text-chip-900">{s.candidate?.name}</div>
                    <div className="text-xs text-slate-500">{s.candidate?.phone}</div>
                  </td>
                  <td className="p-3">{s.client?.name}</td>
                  <td className="p-3 text-slate-600">{s.requirement?.designation}</td>
                  <td className="p-3 text-slate-500">{dt(s.sentAt)}</td>
                  <td className="p-3 text-right tabular-nums">
                    {s.daysSilent == null ? (
                      <span className="text-slate-300">—</span>
                    ) : (
                      <span className={s.daysSilent >= 4 ? "text-amber-800 font-medium" : "text-slate-500"}>
                        {s.daysSilent}d
                      </span>
                    )}
                  </td>
                  <td className="p-3">
                    {editing === s.id ? (
                      <select
                        className="input text-xs py-1"
                        defaultValue={s.status}
                        onChange={(e) => update(s.id, { status: e.target.value })}
                      >
                        {data.statuses.map((x) => <option key={x} value={x}>{x}</option>)}
                      </select>
                    ) : (
                      <span className={"text-[11px] px-2 py-0.5 rounded border " + (TONE[s.status] || TONE.sent)}>
                        {s.status}
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-slate-500">{s.sentBy?.name}</td>
                  <td className="p-3 text-right">
                    <button className="text-xs text-slate-400 hover:text-chip-700"
                      onClick={() => setEditing(editing === s.id ? null : s.id)}>
                      {editing === s.id ? "Close" : "Update"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-slate-500 mt-4 max-w-prose">
        Record what the client said as soon as they say it. A submission left on
        &ldquo;sent&rdquo; keeps appearing in your list as unanswered, and one that is really
        rejected crowds out the ones still worth chasing.
      </p>
    </Shell>
  );
}
