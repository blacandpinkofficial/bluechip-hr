"use client";
// Import candidates from a Naukri or Monster export.
//
// Preview first, always. The phone number is the identity in this database, and
// Excel quietly destroys phone numbers: a mobile column formatted as a number
// arrives as 9.19876E+11 with the last digits gone. The preview is where that
// is caught, by a person, before a hundred unreachable candidates are saved.

import { useState } from "react";
import Shell from "@/components/Shell";

const ACTION_TONE = {
  create: "bg-emerald-50 text-emerald-800 border-emerald-200",
  update: "bg-sky-50 text-sky-800 border-sky-200",
  skip: "bg-red-50 text-red-800 border-red-200",
};

export default function ImportCandidatesPage() {
  const [file, setFile] = useState(null);
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [approved, setApproved] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function runPreview(e) {
    e.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (source) fd.append("source", source);
      const r = await fetch("/api/import/candidates?mode=preview", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not read that file.");
      setPreview(j);
      // Everything usable starts ticked. Rows that cannot be saved are not
      // tickable at all, rather than ticked and silently dropped later.
      setApproved(new Set(j.rows.filter((x) => x.action !== "skip").map((x) => x.sourceRow)));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function runCommit() {
    if (!preview || busy) return;
    setBusy(true);
    setError("");
    try {
      const rows = preview.rows.filter((x) => approved.has(x.sourceRow) && x.action !== "skip");
      const r = await fetch("/api/import/candidates?mode=commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, filename: preview.filename }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "The import failed.");
      setResult(j);
      setPreview(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function toggle(n) {
    const next = new Set(approved);
    if (next.has(n)) next.delete(n); else next.add(n);
    setApproved(next);
  }

  return (
    <Shell
      title="Import candidates"
      subtitle="From the Excel file Naukri or Monster gives you when you download a shortlist."
    >
      {error && <div role="alert" className="card border-red-200 bg-red-50 p-3 text-sm text-red-800 mb-4">{error}</div>}

      {result && (
        <div className="card border-emerald-200 bg-emerald-50 p-5 mb-5">
          <div className="font-medium text-emerald-900">{result.message}</div>
          {result.failed > 0 && (
            <ul className="text-sm text-emerald-900/80 mt-2 space-y-0.5">
              {result.errors.map((e, i) => <li key={i}>Row {e.row}: {e.error}</li>)}
            </ul>
          )}
          <a href="/candidates" className="btn-primary mt-3 inline-flex">Start calling</a>
        </div>
      )}

      {!preview && (
        <form onSubmit={runPreview} className="card p-5 max-w-2xl">
          <label htmlFor="i-file" className="label">The export file</label>
          <input id="i-file" type="file" className="input" accept=".xlsx,.xls,.csv"
            onChange={(e) => { setFile(e.target.files?.[0] || null); setResult(null); }} />
          <div className="mt-3">
            <label htmlFor="i-source" className="label">Where it came from (optional)</label>
            <select id="i-source" className="input max-w-xs" value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">Work it out from the columns</option>
              <option value="naukri">Naukri</option>
              <option value="monster">Monster</option>
            </select>
          </div>
          <button type="submit" className="btn-primary mt-4" disabled={!file || busy}>
            {busy ? "Reading…" : "Read the file"}
          </button>
          <div className="text-xs text-slate-500 mt-4 max-w-prose space-y-2">
            <p>
              <strong>Before you export:</strong> set the mobile column to Text in the portal&rsquo;s
              download options if it offers one. A mobile column saved as a number loses its
              last digits, and those numbers cannot be recovered from the file afterwards.
            </p>
            <p>
              Nothing is saved until you have looked at the preview and pressed Import.
            </p>
          </div>
        </form>
      )}

      {preview && (
        <>
          <div className="card p-4 mb-4">
            <div className="grid sm:grid-cols-5 gap-3 text-sm">
              <div><span className="text-slate-500">Read from</span> <b>{preview.source}</b></div>
              <div><span className="text-slate-500">Rows</span> <b className="tabular-nums">{preview.summary.total}</b></div>
              <div><span className="text-slate-500">New people</span> <b className="tabular-nums text-emerald-700">{preview.summary.newPeople}</b></div>
              <div><span className="text-slate-500">Already on the books</span> <b className="tabular-nums text-sky-700">{preview.summary.alreadyOnBooks}</b></div>
              <div><span className="text-slate-500">Cannot be saved</span> <b className="tabular-nums text-red-700">{preview.summary.rejected}</b></div>
            </div>
            {preview.unmatchedHeaders?.length > 0 && (
              <p className="text-xs text-slate-500 mt-3">
                Columns not used: {preview.unmatchedHeaders.join(", ")}
              </p>
            )}
            <div className="flex gap-2 mt-4">
              <button className="btn-primary" onClick={runCommit} disabled={busy || approved.size === 0}>
                {busy ? "Importing…" : `Import ${approved.size} ${approved.size === 1 ? "person" : "people"}`}
              </button>
              <button className="btn-ghost" onClick={() => setPreview(null)}>Start again</button>
            </div>
          </div>

          <div className="card overflow-x-auto">
            <table className="w-full text-sm min-w-[900px]">
              <thead className="bg-slate-50 text-left text-slate-500">
                <tr>
                  <th className="p-3 w-10" />
                  <th className="p-3 font-medium">Row</th>
                  <th className="p-3 font-medium">Name</th>
                  <th className="p-3 font-medium">Phone</th>
                  <th className="p-3 font-medium">Now</th>
                  <th className="p-3 font-medium text-right">Exp</th>
                  <th className="p-3 font-medium">What happens</th>
                  <th className="p-3 font-medium">Problems</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.sourceRow} className={"border-t border-slate-100 " + (r.action === "skip" ? "opacity-60" : "")}>
                    <td className="p-3">
                      <input
                        type="checkbox"
                        aria-label={`Include row ${r.sourceRow}`}
                        disabled={r.action === "skip"}
                        checked={approved.has(r.sourceRow)}
                        onChange={() => toggle(r.sourceRow)}
                      />
                    </td>
                    <td className="p-3 tabular-nums text-slate-400">{r.sourceRow}</td>
                    <td className="p-3 font-medium text-chip-900">{r.candidate.name || "—"}</td>
                    <td className="p-3 tabular-nums">{r.candidate.phone || <span className="text-red-700">unreadable</span>}</td>
                    <td className="p-3 text-slate-600">
                      {r.candidate.designation || "—"}
                      {r.extra.employer && <span className="text-slate-400"> · {r.extra.employer}</span>}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {r.candidate.expMonths == null ? "—" : `${Math.floor(r.candidate.expMonths / 12)}y ${r.candidate.expMonths % 12}m`}
                    </td>
                    <td className="p-3">
                      <span className={"text-[11px] px-2 py-0.5 rounded border " + ACTION_TONE[r.action]}>
                        {r.action === "create" ? "new" : r.action === "update" ? "update" : "cannot save"}
                      </span>
                      {r.existing && (
                        <div className="text-[11px] text-slate-500 mt-1">
                          already here as {r.existing.name}
                          {r.existing.owner && ` · ${r.existing.owner}`} · {r.existing.stage}
                        </div>
                      )}
                    </td>
                    <td className="p-3">
                      {r.problems.length === 0 ? (
                        <span className="text-slate-300">—</span>
                      ) : (
                        <ul className="text-xs text-amber-800 space-y-0.5">
                          {r.problems.map((p, i) => <li key={i}>{p}</li>)}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-slate-500 mt-4 max-w-prose">
            Someone already on the books is updated, never duplicated — only empty fields are
            filled in, so what a recruiter learned on a call is never overwritten by a portal
            profile that has not been touched in months. Monthly take-home is left blank on
            purpose: the portal gives annual CTC, and take-home is what this desk negotiates on.
          </p>
        </>
      )}
    </Shell>
  );
}
