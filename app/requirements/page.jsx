"use client";
// Requirements — the job description sheet, as a screen.
//
// The knockout criteria (relieving, arrears, education) are shown on every row
// rather than hidden behind a detail view. In the spreadsheet they were prose
// in a cell nobody read, which is why candidates get rejected in week two for
// something knowable in minute one. Putting them where the recruiter is already
// looking is most of the fix.

import { useEffect, useState, useCallback } from "react";
import Shell from "@/components/Shell";

const STATUSES = [
  { key: "open", label: "Open" },
  { key: "hold", label: "On hold" },
  { key: "filled", label: "Filled" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
];

function money(n) {
  if (n == null) return null;
  const v = Number(n);
  if (v >= 100000) return "₹" + (v / 100000).toFixed(1).replace(/\.0$/, "") + "L";
  if (v >= 1000) return "₹" + Math.round(v / 1000) + "k";
  return "₹" + v;
}

function payRange(r) {
  const lo = money(r.takeHomeMin);
  const hi = money(r.takeHomeMax);
  if (lo && hi) return lo === hi ? lo : `${lo}–${hi}`;
  if (hi) return `up to ${hi}`;
  if (lo) return `from ${lo}`;
  return "—";
}

function expRange(r) {
  const f = (m) => (m == null ? null : m < 12 ? `${m}m` : `${Math.round((m / 12) * 10) / 10}y`);
  const lo = f(r.expMinMonths);
  const hi = f(r.expMaxMonths);
  if (r.expMinMonths === 0 && r.expMaxMonths === 0) return "Fresher";
  if (lo && hi) return lo === hi ? lo : `${lo}–${hi}`;
  if (lo) return `${lo}+`;
  return "—";
}

function Pill({ children, tone = "slate" }) {
  const tones = {
    slate: "bg-slate-100 text-slate-600",
    red: "bg-red-50 text-red-700 border border-red-200",
    amber: "bg-amber-50 text-amber-800 border border-amber-200",
    green: "bg-emerald-50 text-emerald-700 border border-emerald-200",
    chip: "bg-chip-50 text-chip-700 border border-chip-200",
  };
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] leading-tight ${tones[tone]}`}>
      {children}
    </span>
  );
}

export default function RequirementsPage() {
  const [rows, setRows] = useState([]);
  const [canSeeFees, setCanSeeFees] = useState(false);
  const [status, setStatus] = useState("open");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ status });
      if (q.trim()) params.set("q", q.trim());
      const r = await fetch(`/api/requirements?${params}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load requirements.");
      setRows(j.requirements || []);
      setCanSeeFees(!!j.canSeeFees);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [status, q]);

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  async function togglePublish(r) {
    const next = !r.publishOnline;
    setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, publishOnline: next } : x)));
    try {
      const res = await fetch(`/api/requirements/${r.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publishOnline: next }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error || "Could not change that.");
        load();
      }
    } catch {
      setError("Could not change that — check your connection.");
      load();
    }
  }

  const totalOpenings = rows.reduce((n, r) => n + (r.openings || 0), 0);
  const unbillable = rows.filter((r) => !r.hasFee).length;

  return (
    <Shell
      title="Requirements"
      subtitle="Every open position, with the criteria that decide a candidate before anyone books a slot."
    >
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {STATUSES.map((s) => (
          <button
            key={s.key}
            onClick={() => setStatus(s.key)}
            className={
              "rounded-full px-3 py-1 text-sm transition " +
              (status === s.key
                ? "bg-chip-700 text-white"
                : "bg-white border border-slate-300 text-slate-600 hover:bg-slate-50")
            }
          >
            {s.label}
          </button>
        ))}
        <input
          id="req-search"
          className="input max-w-xs ml-auto"
          placeholder="Search designation, domain, process…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {/* Summary */}
      {!loading && rows.length > 0 && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-600 mb-4">
          <span>
            <b className="text-chip-800 tabular-nums">{rows.length}</b> requirement
            {rows.length === 1 ? "" : "s"}
          </span>
          <span>
            <b className="text-chip-800 tabular-nums">{totalOpenings}</b> position
            {totalOpenings === 1 ? "" : "s"} to fill
          </span>
          {unbillable > 0 && (
            <span className="text-amber-700">
              <b className="tabular-nums">{unbillable}</b> with no commercials set — these cannot be billed
            </span>
          )}
        </div>
      )}

      {error && (
        <div role="alert" className="card border-red-200 bg-red-50 p-4 text-sm text-red-800 mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <div className="card p-10 text-center text-slate-400">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="card p-10 text-center">
          <div className="text-slate-600">Nothing here yet.</div>
          <p className="text-sm text-slate-500 mt-1">
            Import the job description sheet and every opening in it lands here.
          </p>
          <a href="/import" className="btn-primary mt-4 inline-flex">Import the sheet</a>
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm min-w-[900px]">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-left">
                <th className="px-4 py-2 font-medium text-slate-600">Role</th>
                <th className="px-4 py-2 font-medium text-slate-600">Client</th>
                <th className="px-4 py-2 font-medium text-slate-600">Location</th>
                <th className="px-4 py-2 font-medium text-slate-600 text-right">Open</th>
                <th className="px-4 py-2 font-medium text-slate-600">Experience</th>
                <th className="px-4 py-2 font-medium text-slate-600">Take home</th>
                <th className="px-4 py-2 font-medium text-slate-600">Must have</th>
                <th className="px-4 py-2 font-medium text-slate-600">Careers page</th>
                {canSeeFees && <th className="px-4 py-2 font-medium text-slate-600">Fee</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 last:border-0 align-top hover:bg-slate-50/60">
                  <td className="px-4 py-3">
                    <div className="font-medium text-chip-900">{r.designation}</div>
                    <div className="text-xs text-slate-500">
                      {[r.processType, r.domain].filter(Boolean).join(" · ") || "—"}
                    </div>
                  </td>
                  <td className="px-4 py-3">{r.clientName}</td>
                  <td className="px-4 py-3">{r.location || "—"}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium">{r.openings}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{expRange(r)}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{payRange(r)}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {r.relievingRequired && <Pill tone="red">Relieving letter</Pill>}
                      {!r.arrearsAllowed && <Pill tone="red">No arrears</Pill>}
                      {r.educationMin && <Pill tone="slate">{r.educationMin}</Pill>}
                      {r.cabFacility !== "none" && (
                        <Pill tone="green">{r.cabFacility === "twoway" ? "Cab both ways" : "Cab one way"}</Pill>
                      )}
                      {!r.relievingRequired && r.arrearsAllowed && !r.educationMin && r.cabFacility === "none" && (
                        <span className="text-xs text-slate-400">No constraints recorded</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {/* Publishing an opening puts the client's name and pay
                        range on a public page, so it is an explicit choice per
                        opening rather than a global setting. */}
                    <button
                      onClick={() => togglePublish(r)}
                      className={
                        "text-[11px] px-2 py-0.5 rounded border transition " +
                        (r.publishOnline
                          ? "bg-emerald-50 text-emerald-800 border-emerald-300"
                          : "bg-white text-slate-500 border-slate-300 hover:bg-slate-50")
                      }
                      title={r.publishOnline ? "Visible on the careers page" : "Internal only"}
                    >
                      {r.publishOnline ? "Public" : "Internal"}
                    </button>
                  </td>
                  {canSeeFees && (
                    <td className="px-4 py-3 whitespace-nowrap">
                      {r.hasFee ? (
                        <>
                          <div>{r.feeLabel}</div>
                          {r.feeSource === "client" && (
                            <div className="text-[11px] text-slate-400">client default</div>
                          )}
                        </>
                      ) : (
                        <Pill tone="amber">Not set</Pill>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}
