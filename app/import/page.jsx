"use client";
// Import — the job description sheet, reviewed before it lands.
//
// The preview is the whole point of this screen. The workbook is maintained by
// hand, "COMMERCIALS" holds a flat fee in some rows and a percentage in others,
// and a silent import that guesses wrong produces a hundred openings that look
// correct and bill incorrectly. So: upload, look, then approve.

import { useState } from "react";
import Shell from "@/components/Shell";

function feeLabel(r) {
  const q = r.requirement || {};
  if (q.feeType === "percent" && q.feeBps != null) {
    return (q.feeBps / 100).toFixed(2).replace(/\.00$/, "") + "%";
  }
  if (q.feeType === "flat" && q.feeFlat != null) {
    return "₹" + Number(q.feeFlat).toLocaleString("en-IN");
  }
  return null;
}

export default function ImportPage() {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [skipped, setSkipped] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  async function doPreview(e) {
    e.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/import/requirements?mode=preview", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not read that file.");
      setPreview(j);
      setSkipped(new Set());
    } catch (err) {
      setError(err.message);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  async function doCommit() {
    if (!preview || busy) return;
    const rows = preview.rows.filter((r) => !skipped.has(r.sourceRow));
    if (rows.length === 0) {
      setError("Every row is skipped — nothing to import.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/import/requirements?mode=commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, filename: file?.name || "workbook.xlsx" }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "The import failed. Nothing was saved.");
      setResult(j);
      setPreview(null);
      setFile(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function toggle(sourceRow) {
    setSkipped((prev) => {
      const next = new Set(prev);
      next.has(sourceRow) ? next.delete(sourceRow) : next.add(sourceRow);
      return next;
    });
  }

  const willImport = preview ? preview.rows.length - skipped.size : 0;

  return (
    <Shell
      title="Import the job description sheet"
      subtitle="Nothing is saved until you approve it below."
      actions={
        <a href="/import/candidates" className="btn-ghost">
          Import candidates instead
        </a>
      }
    >
      {result && (
        <div className="card border-emerald-200 bg-emerald-50 p-4 mb-6">
          <div className="font-medium text-emerald-900">Imported.</div>
          <ul className="text-sm text-emerald-800 mt-2 space-y-0.5">
            <li>{result.requirementsCreated} openings added</li>
            <li>{result.clientsCreated} new clients created</li>
            {result.skipped > 0 && <li>{result.skipped} rows could not be saved</li>}
            {!result.feesImported && (
              <li className="text-amber-800">
                Commercials were not imported — only an owner account can set them.
              </li>
            )}
          </ul>
          <a href="/requirements" className="btn-primary mt-3 inline-flex">See the requirements</a>
        </div>
      )}

      {error && (
        <div role="alert" className="card border-red-200 bg-red-50 p-4 text-sm text-red-800 mb-4">
          {error}
        </div>
      )}

      {!preview && (
        <form onSubmit={doPreview} className="card p-6 max-w-xl">
          <label htmlFor="sheet" className="label">Workbook (.xlsx)</label>
          <input
            id="sheet"
            type="file"
            accept=".xlsx,.xls"
            className="input"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
          <p className="text-xs text-slate-500 mt-2">
            The first sheet is read. Columns are matched by name, so the order
            does not matter — and the two columns both called &ldquo;PROCESS&rdquo;
            are kept apart by position.
          </p>
          <button type="submit" className="btn-primary mt-4" disabled={!file || busy}>
            {busy ? "Reading…" : "Read the file"}
          </button>
        </form>
      )}

      {preview && (
        <>
          <div className="card p-4 mb-4">
            <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
              <div><span className="text-slate-500">Sheet</span> <b>{preview.sheetName}</b></div>
              <div><span className="text-slate-500">Rows read</span> <b className="tabular-nums">{preview.summary.total}</b></div>
              <div><span className="text-slate-500">Clean</span> <b className="tabular-nums text-emerald-700">{preview.summary.ok}</b></div>
              <div><span className="text-slate-500">Need a look</span> <b className="tabular-nums text-amber-700">{preview.summary.withProblems}</b></div>
              <div><span className="text-slate-500">New clients</span> <b className="tabular-nums">{preview.summary.newClients}</b></div>
            </div>

            {preview.unmatchedColumns?.length > 0 && (
              <div className="mt-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                These columns were not recognised and will be ignored:{" "}
                <b>{preview.unmatchedColumns.map((c) => c.header).join(", ")}</b>. If one of them
                matters, tell me the name and I&rsquo;ll add it.
              </div>
            )}

            {!preview.canSetFees && (
              <div className="mt-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                You are signed in as a manager, so the commercials column will not be
                imported. Openings will arrive with no fee set. An owner can import
                the same file to bring them in.
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 mb-3">
            <button className="btn-primary" onClick={doCommit} disabled={busy || willImport === 0}>
              {busy ? "Importing…" : `Import ${willImport} row${willImport === 1 ? "" : "s"}`}
            </button>
            <button className="btn-ghost" onClick={() => { setPreview(null); setError(""); }} disabled={busy}>
              Cancel
            </button>
            {skipped.size > 0 && (
              <span className="text-sm text-slate-500">{skipped.size} skipped</span>
            )}
          </div>

          <div className="card overflow-x-auto">
            <table className="w-full text-sm min-w-[860px]">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-left">
                  <th className="px-3 py-2 font-medium text-slate-600">Import</th>
                  <th className="px-3 py-2 font-medium text-slate-600">Row</th>
                  <th className="px-3 py-2 font-medium text-slate-600">Client</th>
                  <th className="px-3 py-2 font-medium text-slate-600">Role</th>
                  <th className="px-3 py-2 font-medium text-slate-600">Location</th>
                  <th className="px-3 py-2 font-medium text-slate-600 text-right">Pos.</th>
                  <th className="px-3 py-2 font-medium text-slate-600">Fee</th>
                  <th className="px-3 py-2 font-medium text-slate-600">Needs a look</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => {
                  const skip = skipped.has(r.sourceRow);
                  const fee = feeLabel(r);
                  return (
                    <tr
                      key={r.sourceRow}
                      className={
                        "border-b border-slate-100 last:border-0 align-top " +
                        (skip ? "opacity-40" : r.problems.length ? "bg-amber-50/40" : "")
                      }
                    >
                      <td className="px-3 py-2">
                        <input
                          id={`row-${r.sourceRow}`}
                          type="checkbox"
                          checked={!skip}
                          onChange={() => toggle(r.sourceRow)}
                          className="h-4 w-4 accent-chip-600"
                          aria-label={`Import row ${r.sourceRow}`}
                        />
                      </td>
                      <td className="px-3 py-2 tabular-nums text-slate-400">{r.sourceRow}</td>
                      <td className="px-3 py-2">
                        {r.client.name}
                        {!r.clientExists && (
                          <span className="ml-1 text-[11px] text-chip-600">new</span>
                        )}
                      </td>
                      <td className="px-3 py-2">{r.requirement.designation}</td>
                      <td className="px-3 py-2">{r.requirement.location || "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.requirement.openings}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {fee || <span className="text-amber-700">not set</span>}
                      </td>
                      <td className="px-3 py-2">
                        {r.problems.length === 0 ? (
                          <span className="text-slate-300">—</span>
                        ) : (
                          <ul className="text-[12px] text-amber-800 space-y-0.5">
                            {r.problems.map((p, i) => <li key={i}>{p}</li>)}
                          </ul>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-slate-500 mt-3 max-w-prose">
            Flagged rows still import — the flag means a value could not be read from
            the sheet, not that the row is unusable. Untick anything you would rather
            enter by hand. The whole import runs as one transaction: if it fails
            partway, nothing is saved.
          </p>
        </>
      )}
    </Shell>
  );
}
