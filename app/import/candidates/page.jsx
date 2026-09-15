"use client";
// Import candidates from a Naukri or Monster export — against an opening.
//
// Preview first, always. The phone number is the identity in this database, and
// Excel quietly destroys phone numbers: a mobile column formatted as a number
// arrives as 9.19876E+11 with the last digits gone. The preview is where that
// is caught, by a person, before a hundred unreachable candidates are saved.
//
// The opening is asked for BEFORE the file, because that is the order the work
// happens in: a telecaller is handed a requirement, then goes and finds people
// for it. Choosing it first is also what lets the preview say, per row, whether
// this person is already being worked by somebody for something else.

import { useEffect, useState } from "react";
import Shell from "@/components/Shell";

const ACTION_TONE = {
  create: "bg-emerald-50 text-emerald-800 border-emerald-200",
  link: "bg-emerald-50 text-emerald-800 border-emerald-200",
  update: "bg-sky-50 text-sky-800 border-sky-200",
  conflict: "bg-amber-50 text-amber-900 border-amber-300",
  skip: "bg-red-50 text-red-800 border-red-200",
};

const ACTION_LABEL = {
  create: "new",
  link: "link to this opening",
  update: "update",
  conflict: "on another opening",
  skip: "cannot save",
};

export default function ImportCandidatesPage() {
  const [file, setFile] = useState(null);
  const [source, setSource] = useState("");
  const [reqId, setReqId] = useState("");
  const [assignToMe, setAssignToMe] = useState(true);
  const [requirements, setRequirements] = useState([]);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [approved, setApproved] = useState(new Set());
  const [moves, setMoves] = useState(new Set()); // rows told to change opening
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The openings still being recruited for. Closed ones are left out: importing
  // a hundred people against a role that is already filled is work nobody asked
  // for and nobody will do.
  useEffect(() => {
    let alive = true;
    fetch("/api/requirements?status=open")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!alive || !j) return;
        setRequirements(Array.isArray(j.requirements) ? j.requirements : []);
      })
      .catch(() => setError("Could not load the open requirements — pick the file and try again."));
    return () => { alive = false; };
  }, []);

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
      if (reqId) fd.append("requirementId", reqId);
      const r = await fetch("/api/import/candidates?mode=preview", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not read that file.");
      setPreview(j);
      setMoves(new Set());
      // Everything usable starts ticked, EXCEPT the people already sitting
      // against somebody else's opening. Rows that cannot be saved are not
      // tickable at all, rather than ticked and silently dropped later.
      const rows = Array.isArray(j.rows) ? j.rows : [];
      setApproved(
        new Set(
          rows
            .filter((x) => x.action !== "skip" && x.action !== "conflict")
            .map((x) => x.sourceRow)
        )
      );
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
      const all = Array.isArray(preview.rows) ? preview.rows : [];
      const rows = all
        .filter((x) => approved.has(x.sourceRow) && x.action !== "skip")
        .map((x) => ({ ...x, moveRequirement: moves.has(x.sourceRow) }));
      const r = await fetch("/api/import/candidates?mode=commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows,
          filename: preview.filename,
          requirementId: preview.requirement?.id || null,
          assignToMe,
        }),
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

  function toggleMove(n) {
    const next = new Set(moves);
    if (next.has(n)) next.delete(n); else next.add(n);
    setMoves(next);
    // Telling us to move somebody is telling us to import them.
    if (!moves.has(n) && !approved.has(n)) toggle(n);
  }

  const reqLabel = (r) =>
    [r.designation, r.clientName, r.location].filter(Boolean).join(" · ");

  return (
    <Shell
      title="Import candidates"
      subtitle="From the Excel file Naukri or Monster gives you — or from the sample sheet, filled in by hand."
    >
      {error && <div role="alert" className="card border-red-200 bg-red-50 p-3 text-sm text-red-800 mb-4">{error}</div>}

      {result && (
        <div className="card border-emerald-200 bg-emerald-50 p-5 mb-5">
          <div className="font-medium text-emerald-900">{result.message}</div>
          {result.keptOnTheirOpening > 0 && (
            <p className="text-sm text-emerald-900/80 mt-1">
              Nobody was taken off an opening they were already against.
            </p>
          )}
          {result.failed > 0 && Array.isArray(result.errors) && (
            <ul className="text-sm text-emerald-900/80 mt-2 space-y-0.5">
              {result.errors.map((e, i) => <li key={i}>Row {e.row}: {e.error}</li>)}
            </ul>
          )}
          <a
            href={result.requirementId ? `/candidates?requirement=${result.requirementId}` : "/candidates"}
            className="btn-primary mt-3 inline-flex"
          >
            Start calling
          </a>
        </div>
      )}

      {!preview && (
        <form onSubmit={runPreview} className="card p-5 max-w-2xl">
          <label htmlFor="i-req" className="label">Which opening are these for?</label>
          <select
            id="i-req"
            className="input"
            value={reqId}
            onChange={(e) => setReqId(e.target.value)}
          >
            <option value="">No opening — just add them to the database</option>
            {requirements.map((r) => (
              <option key={r.id} value={r.id}>{reqLabel(r)}</option>
            ))}
          </select>
          <p className="text-xs text-slate-500 mt-1">
            Everyone in this file is attached to this opening, so the call screen can screen
            them against the client&rsquo;s terms and tell you what to say.
          </p>

          <label className="flex items-start gap-2 cursor-pointer mt-3">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-chip-600"
              checked={assignToMe}
              onChange={(e) => setAssignToMe(e.target.checked)}
            />
            <span className="text-sm">
              <span className="font-medium text-chip-900">These are mine to call</span>
              <span className="block text-slate-500">
                Puts the batch in your list. Turn it off when you are topping up the database
                for the whole desk — nobody calls a list of a hundred that landed on them.
              </span>
            </span>
          </label>

          <div className="mt-4">
            <label htmlFor="i-file" className="label">The export file</label>
            <input id="i-file" type="file" className="input" accept=".xlsx,.xls,.csv"
              onChange={(e) => { setFile(e.target.files?.[0] || null); setResult(null); }} />
          </div>

          <div className="mt-3">
            <label htmlFor="i-source" className="label">Where it came from (optional)</label>
            <select id="i-source" className="input max-w-xs" value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">Work it out from the columns</option>
              <option value="naukri">Naukri</option>
              <option value="monster">Monster</option>
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-2 mt-4">
            <button type="submit" className="btn-primary" disabled={!file || busy}>
              {busy ? "Reading…" : "Read the file"}
            </button>
            <a
              className="btn-ghost"
              href="/api/import/candidates?template=1"
              download="sample-candidate-import.xlsx"
            >
              Download sample template
            </a>
          </div>

          <div className="text-xs text-slate-500 mt-4 max-w-prose space-y-2">
            <p>
              <strong>No file to export?</strong> Download the sample sheet, type your list into it
              and upload that. Its column names are the ones this screen understands, so nothing
              gets left behind.
            </p>
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
            <div className="flex flex-wrap items-center gap-2 mb-3">
              {preview.requirement ? (
                <span className="text-sm text-slate-600">
                  These rows land against{" "}
                  <b className="text-chip-800">{preview.requirement.designation}</b>
                  {preview.requirement.clientName ? ` at ${preview.requirement.clientName}` : ""}
                  {preview.requirement.location ? ` · ${preview.requirement.location}` : ""}
                  {preview.requirement.status && preview.requirement.status !== "open" && (
                    <span className="text-amber-700"> · this opening is {preview.requirement.status}</span>
                  )}
                </span>
              ) : (
                <span className="text-sm text-amber-700">
                  No opening chosen — these people go into the database unattached, and the call
                  screen will have nothing to screen them against.
                </span>
              )}
              <span className="text-sm text-slate-600 ml-auto">
                {assignToMe ? "Assigned to you." : "Left unassigned."}
              </span>
            </div>

            <div className="grid sm:grid-cols-6 gap-3 text-sm">
              <div><span className="text-slate-500">Read from</span> <b>{preview.source}</b></div>
              <div><span className="text-slate-500">Rows</span> <b className="tabular-nums">{preview.summary.total}</b></div>
              <div><span className="text-slate-500">New people</span> <b className="tabular-nums text-emerald-700">{preview.summary.newPeople}</b></div>
              <div><span className="text-slate-500">Already on the books</span> <b className="tabular-nums text-sky-700">{preview.summary.alreadyOnBooks}</b></div>
              <div><span className="text-slate-500">On another opening</span> <b className="tabular-nums text-amber-800">{preview.summary.conflicts || 0}</b></div>
              <div><span className="text-slate-500">Cannot be saved</span> <b className="tabular-nums text-red-700">{preview.summary.rejected}</b></div>
            </div>

            {Array.isArray(preview.unmatchedHeaders) && preview.unmatchedHeaders.length > 0 && (
              <p className="text-xs text-slate-500 mt-3">
                Columns not used: {preview.unmatchedHeaders.join(", ")}
              </p>
            )}

            {preview.summary.conflicts > 0 && (
              <p className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded px-3 py-2 mt-3 max-w-prose">
                <b className="tabular-nums">{preview.summary.conflicts}</b> of these people are already
                being worked for a different opening. They are left unticked. Tick one to fill in
                whatever the file adds; tick <b>Move</b> as well to take them off that opening and put
                them on this one — which is a decision, not a tidy-up, so it is never done for you.
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
            <table className="w-full text-sm min-w-[980px]">
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
                {(Array.isArray(preview.rows) ? preview.rows : []).map((r) => (
                  <tr
                    key={r.sourceRow}
                    className={
                      "border-t border-slate-100 " +
                      (r.action === "skip" ? "opacity-60 " : "") +
                      (r.action === "conflict" ? "bg-amber-50/40 " : "")
                    }
                  >
                    <td className="p-3">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-chip-600"
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
                      {r.extra?.employer && <span className="text-slate-400"> · {r.extra.employer}</span>}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {r.candidate.expMonths == null ? "—" : `${Math.floor(r.candidate.expMonths / 12)}y ${r.candidate.expMonths % 12}m`}
                    </td>
                    <td className="p-3">
                      <span className={"text-[11px] px-2 py-0.5 rounded border " + (ACTION_TONE[r.action] || ACTION_TONE.skip)}>
                        {ACTION_LABEL[r.action] || r.action}
                      </span>
                      {r.existing && (
                        <div className="text-[11px] text-slate-500 mt-1">
                          already here as {r.existing.name}
                          {r.existing.owner && ` · ${r.existing.owner}`} · {r.existing.stage}
                        </div>
                      )}
                      {r.action === "conflict" && (
                        <div className="mt-1 space-y-1">
                          <div className="text-[11px] text-amber-900">
                            On {r.existing?.requirementLabel || "another opening"}
                          </div>
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-chip-600"
                              checked={moves.has(r.sourceRow)}
                              onChange={() => toggleMove(r.sourceRow)}
                            />
                            <span className="text-[11px] font-medium text-amber-900">
                              Move to this opening
                            </span>
                          </label>
                        </div>
                      )}
                    </td>
                    <td className="p-3">
                      {!Array.isArray(r.problems) || r.problems.length === 0 ? (
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
            profile that has not been touched in months. Somebody who is not against any opening
            is linked to this one. Somebody already against a different opening keeps it unless
            you tick Move. Monthly take-home is left blank on purpose: the portal gives annual
            CTC, and take-home is what this desk negotiates on.
          </p>
        </>
      )}
    </Shell>
  );
}
