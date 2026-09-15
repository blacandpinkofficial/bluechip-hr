"use client";
// Requirements — the job description sheet, as a screen.
//
// The knockout criteria (relieving, arrears, education) are shown on every row
// rather than hidden behind a detail view. In the spreadsheet they were prose
// in a cell nobody read, which is why candidates get rejected in week two for
// something knowable in minute one. Putting them where the recruiter is already
// looking is most of the fix.
//
// The row actions follow the same idea. Putting a role on hold, marking it
// filled, or taking it off the careers page are the things that happen ten
// times a day, and every one of them used to mean opening a form. They are one
// click on the row now. The full editor is a side panel rather than a dialog
// that covers the list: you can still see which opening you are editing.

import { useEffect, useState, useCallback } from "react";
import Shell from "@/components/Shell";

const STATUSES = [
  { key: "open", label: "Open" },
  { key: "hold", label: "On hold" },
  { key: "filled", label: "Filled" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
];

// The four real statuses — the filter bar above has an extra "all" pill that is
// a view, not a state an opening can be in.
const WORK_STATUSES = [
  { key: "open", label: "Open" },
  { key: "hold", label: "On hold" },
  { key: "filled", label: "Filled" },
  { key: "closed", label: "Closed" },
];

const STATUS_LABEL = {
  open: "Open",
  hold: "On hold",
  filled: "Filled",
  closed: "Closed",
};

// Written out in full rather than built from the status name, because Tailwind
// reads these files as text: a class it cannot see spelled out is a class it
// does not put in the stylesheet, and the colour silently goes missing in the
// production build only.
const STATUS_TONE = {
  open: "bg-emerald-50 text-emerald-700 border-emerald-200",
  hold: "bg-amber-50 text-amber-900 border-amber-200",
  filled: "bg-sky-50 text-sky-800 border-sky-200",
  closed: "bg-slate-100 text-slate-500 border-slate-300",
};

// Which one-click moves make sense from where you are. Marking an opening
// filled is not the same as closing it — filled means the client took someone,
// closed means the client stopped hiring — so both are offered.
const QUICK_MOVES = {
  open: [
    { to: "hold", label: "Hold" },
    { to: "filled", label: "Filled" },
    { to: "closed", label: "Close" },
  ],
  hold: [
    { to: "open", label: "Re-open" },
    { to: "filled", label: "Filled" },
    { to: "closed", label: "Close" },
  ],
  filled: [
    { to: "open", label: "Re-open" },
    { to: "closed", label: "Close" },
  ],
  closed: [{ to: "open", label: "Re-open" }],
};

const CAB_OPTIONS = [
  { key: "none", label: "No cab" },
  { key: "oneway", label: "Cab one way" },
  { key: "twoway", label: "Cab both ways" },
];

const PRIORITY_OPTIONS = [
  { key: "low", label: "Low" },
  { key: "normal", label: "Normal" },
  { key: "high", label: "High" },
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

/** The small square-shouldered button the row actions are all made of. */
function RowButton({ children, onClick, disabled, title, active }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={
        "text-[11px] px-2 py-0.5 rounded border transition disabled:opacity-40 disabled:cursor-not-allowed " +
        (active
          ? "bg-chip-50 text-chip-800 border-chip-300"
          : "bg-white text-slate-600 border-slate-300 hover:bg-slate-50 hover:text-chip-700")
      }
    >
      {children}
    </button>
  );
}

export default function RequirementsPage() {
  const [rows, setRows] = useState([]);
  const [canSeeFees, setCanSeeFees] = useState(false);
  const [canWrite, setCanWrite] = useState(false);
  const [status, setStatus] = useState("open");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Cleared on a timer. A confirmation that never goes away stops being a
  // confirmation and becomes furniture.
  const [flash, setFlash] = useState("");
  const [busyId, setBusyId] = useState("");
  const [editId, setEditId] = useState("");

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(""), 2500);
    return () => clearTimeout(t);
  }, [flash]);

  // `quiet` reloads the data without blanking the table. A one-click action
  // that replaces the whole list with "Loading…" for half a second reads as the
  // page breaking, not as the change landing.
  const load = useCallback(
    async (quiet) => {
      if (!quiet) setLoading(true);
      if (!quiet) setError("");
      try {
        const params = new URLSearchParams({ status });
        if (q.trim()) params.set("q", q.trim());
        const r = await fetch(`/api/requirements?${params}`);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Could not load requirements.");
        // A failed or unexpected payload can hand back an object here, and
        // .map on an object is a blank page with a stack trace behind it.
        setRows(Array.isArray(j.requirements) ? j.requirements : []);
        setCanSeeFees(!!j.canSeeFees);
        setCanWrite(!!j.canWrite);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    },
    [status, q]
  );

  useEffect(() => {
    const t = setTimeout(() => load(), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  /** One PATCH, optimistic on the row, reconciled from the server afterwards. */
  async function patchRow(r, body, { optimistic, success }) {
    setBusyId(r.id);
    setError("");
    if (optimistic) {
      setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, ...optimistic } : x)));
    }
    try {
      const res = await fetch(`/api/requirements/${r.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "Could not change that.");
      if (success) setFlash(success);
      return true;
    } catch (e) {
      setError(e.message || "Could not change that — check your connection.");
      return false;
    } finally {
      setBusyId("");
      // Always re-read. The server has its own rules about this row — closing
      // an opening also takes it off the careers page — and the screen should
      // show what is actually stored, not what we guessed.
      load(true);
    }
  }

  function setRowStatus(r, to) {
    if (r.status === to) return;
    return patchRow(
      r,
      { status: to },
      {
        // Mirrors the server rule: anything that is not open leaves the
        // careers page at the same moment.
        optimistic: { status: to, publishOnline: to === "open" ? r.publishOnline : false },
        success: `${r.designation} — ${STATUS_LABEL[to] || to}.`,
      }
    );
  }

  function togglePublish(r) {
    const next = !r.publishOnline;
    return patchRow(
      r,
      { publishOnline: next },
      {
        optimistic: { publishOnline: next },
        success: next
          ? `${r.designation} is on the careers page.`
          : `${r.designation} is off the careers page.`,
      }
    );
  }

  const totalOpenings = rows.reduce((n, r) => n + (r.openings || 0), 0);
  const unbillable = rows.filter((r) => !r.hasFee).length;
  const editing = rows.find((r) => r.id === editId) || null;

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
      {flash && (
        <div className="card border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 mb-4">
          {flash}
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
          <table className="w-full text-sm min-w-[1180px]">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-left">
                <th className="px-4 py-2 font-medium text-slate-600">Role</th>
                <th className="px-4 py-2 font-medium text-slate-600">Client</th>
                <th className="px-4 py-2 font-medium text-slate-600">Location</th>
                <th className="px-4 py-2 font-medium text-slate-600 text-right">Open</th>
                <th className="px-4 py-2 font-medium text-slate-600">Experience</th>
                <th className="px-4 py-2 font-medium text-slate-600">Take home</th>
                <th className="px-4 py-2 font-medium text-slate-600">Must have</th>
                <th className="px-4 py-2 font-medium text-slate-600">Status</th>
                <th className="px-4 py-2 font-medium text-slate-600">Careers page</th>
                {canSeeFees && <th className="px-4 py-2 font-medium text-slate-600">Fee</th>}
                {canWrite && <th className="px-4 py-2 font-medium text-slate-600 text-right">Edit</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={
                    "border-b border-slate-100 last:border-0 align-top hover:bg-slate-50/60 " +
                    (busyId === r.id ? "opacity-50" : "")
                  }
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-chip-900">{r.designation}</div>
                    <div className="text-xs text-slate-500">
                      {[r.processType, r.domain].filter(Boolean).join(" · ") || "—"}
                    </div>
                    {r.priority === "high" && (
                      <div className="mt-1"><Pill tone="red">High priority</Pill></div>
                    )}
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
                    {/* Where the opening stands, and the moves that make sense
                        from there — no form, no dialog, one click each. */}
                    <div className="flex flex-wrap items-center gap-1">
                      <span
                        className={
                          "text-[11px] px-2 py-0.5 rounded border " +
                          (STATUS_TONE[r.status] || STATUS_TONE.closed)
                        }
                      >
                        {STATUS_LABEL[r.status] || r.status}
                      </span>
                      {canWrite &&
                        (QUICK_MOVES[r.status] || []).map((m) => (
                          <RowButton
                            key={m.to}
                            disabled={busyId === r.id}
                            onClick={() => setRowStatus(r, m.to)}
                            title={`Move to ${STATUS_LABEL[m.to] || m.to}`}
                          >
                            {m.label}
                          </RowButton>
                        ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {/* Publishing an opening puts the client's name and pay
                        range on a public page, so it is an explicit choice per
                        opening rather than a global setting. */}
                    <button
                      type="button"
                      onClick={() => togglePublish(r)}
                      disabled={!canWrite || busyId === r.id || (!r.publishOnline && r.status !== "open")}
                      className={
                        "text-[11px] px-2 py-0.5 rounded border transition disabled:opacity-40 disabled:cursor-not-allowed " +
                        (r.publishOnline
                          ? "bg-emerald-50 text-emerald-800 border-emerald-300"
                          : "bg-white text-slate-500 border-slate-300 hover:bg-slate-50")
                      }
                      title={
                        !canWrite
                          ? "You cannot change openings"
                          : !r.publishOnline && r.status !== "open"
                          ? "Only an open requirement can go on the careers page"
                          : r.publishOnline
                          ? "Visible on the careers page — click to make it internal"
                          : "Internal only — click to publish"
                      }
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
                  {canWrite && (
                    <td className="px-4 py-3 text-right">
                      <RowButton
                        active={editId === r.id}
                        onClick={() => setEditId(editId === r.id ? "" : r.id)}
                        title="Open the full editor"
                      >
                        Edit
                      </RowButton>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canWrite && editing && (
        <EditPanel
          key={editing.id}
          row={editing}
          canSeeFees={canSeeFees}
          onClose={() => setEditId("")}
          onSaved={(msg) => {
            setEditId("");
            setFlash(msg);
            load(true);
          }}
        />
      )}
    </Shell>
  );
}

/**
 * The full editor, as a panel beside the list rather than a dialog on top of
 * it. You can still read the row you are editing, which is the whole argument
 * for it over a modal.
 */
function EditPanel({ row, canSeeFees, onClose, onSaved }) {
  const [f, setF] = useState(() => ({
    designation: row.designation || "",
    location: row.location || "",
    openings: row.openings == null ? 1 : row.openings,
    expMinMonths: row.expMinMonths == null ? "" : String(row.expMinMonths),
    expMaxMonths: row.expMaxMonths == null ? "" : String(row.expMaxMonths),
    takeHomeMin: row.takeHomeMin == null ? "" : String(row.takeHomeMin),
    takeHomeMax: row.takeHomeMax == null ? "" : String(row.takeHomeMax),
    shift: row.shift || "",
    status: row.status || "open",
    priority: row.priority || "normal",
    educationMin: row.educationMin || "",
    cabFacility: row.cabFacility || "none",
    relievingRequired: !!row.relievingRequired,
    arrearsAllowed: row.arrearsAllowed !== false,
    notes: row.notes || "",
  }));

  // A fee shown against this opening may be the client's house rate rather than
  // anything set here. Pre-filling the boxes with it and saving would silently
  // copy that rate onto this one opening and freeze it, so the boxes start
  // empty and the inherited rate is stated instead.
  const ownFee = row.feeSource === "requirement";
  const [fee, setFee] = useState(() => ({
    feeType: ownFee && row.feeType ? row.feeType : "",
    feePercent:
      ownFee && row.feeType === "percent" && row.feeBps != null ? String(row.feeBps / 100) : "",
    feeFlat: ownFee && row.feeType === "flat" && row.feeFlat != null ? String(row.feeFlat) : "",
  }));
  // Fee fields are only sent if they were touched. Sending them on every save
  // would turn "I fixed the location" into "I also rewrote the commercials".
  const [feeTouched, setFeeTouched] = useState(false);

  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState("");

  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const setFeeField = (k, v) => {
    setFeeTouched(true);
    setFee((s) => ({ ...s, [k]: v }));
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  async function save() {
    if (!f.designation.trim()) return setProblem("The designation cannot be empty.");
    if (!f.location.trim()) return setProblem("The location cannot be empty.");
    setProblem("");
    setSaving(true);

    const body = {
      designation: f.designation.trim(),
      location: f.location.trim(),
      openings: f.openings,
      expMinMonths: f.expMinMonths === "" ? null : f.expMinMonths,
      expMaxMonths: f.expMaxMonths === "" ? null : f.expMaxMonths,
      takeHomeMin: f.takeHomeMin === "" ? null : f.takeHomeMin,
      takeHomeMax: f.takeHomeMax === "" ? null : f.takeHomeMax,
      shift: f.shift,
      status: f.status,
      priority: f.priority,
      educationMin: f.educationMin,
      cabFacility: f.cabFacility,
      relievingRequired: f.relievingRequired,
      arrearsAllowed: f.arrearsAllowed,
      notes: f.notes,
    };

    if (canSeeFees && feeTouched) {
      if (fee.feeType === "percent") {
        body.feeType = "percent";
        body.feePercent = fee.feePercent;
      } else if (fee.feeType === "flat") {
        body.feeType = "flat";
        body.feeFlat = fee.feeFlat;
      } else {
        // Explicit null is how this route is told to clear the terms.
        body.feeType = null;
      }
    }

    try {
      const res = await fetch(`/api/requirements/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "Could not save the change.");
      onSaved(`${body.designation} saved.`);
    } catch (e) {
      setProblem(e.message || "Could not save the change.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-slate-900/20" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${row.designation}`}
        className="absolute right-0 top-0 h-full w-full max-w-xl bg-white border-l border-slate-200 shadow-xl flex flex-col"
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div>
            <div className="font-medium text-chip-900">{row.designation}</div>
            <div className="text-xs text-slate-500">
              {row.clientName} · {row.location || "no location"}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-slate-400 hover:text-chip-700"
          >
            Close
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {problem && (
            <div role="alert" className="card border-red-200 bg-red-50 p-3 text-sm text-red-800 mb-4">
              {problem}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="label" htmlFor="ed-designation">Designation</label>
              <input
                id="ed-designation"
                className="input"
                value={f.designation}
                onChange={(e) => set("designation", e.target.value)}
              />
            </div>

            <div>
              <label className="label" htmlFor="ed-location">Location</label>
              <input
                id="ed-location"
                className="input"
                value={f.location}
                onChange={(e) => set("location", e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="ed-openings">Openings</label>
              <input
                id="ed-openings"
                className="input"
                type="number"
                min="1"
                value={f.openings}
                onChange={(e) => set("openings", e.target.value)}
              />
            </div>

            <div>
              <label className="label" htmlFor="ed-expmin">Experience from (months)</label>
              <input
                id="ed-expmin"
                className="input"
                type="number"
                min="0"
                placeholder="0 for fresher"
                value={f.expMinMonths}
                onChange={(e) => set("expMinMonths", e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="ed-expmax">Experience to (months)</label>
              <input
                id="ed-expmax"
                className="input"
                type="number"
                min="0"
                placeholder="leave blank for no cap"
                value={f.expMaxMonths}
                onChange={(e) => set("expMaxMonths", e.target.value)}
              />
            </div>

            <div>
              <label className="label" htmlFor="ed-paymin">Take home from</label>
              <input
                id="ed-paymin"
                className="input"
                placeholder="18k"
                value={f.takeHomeMin}
                onChange={(e) => set("takeHomeMin", e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="ed-paymax">Take home to</label>
              <input
                id="ed-paymax"
                className="input"
                placeholder="25k"
                value={f.takeHomeMax}
                onChange={(e) => set("takeHomeMax", e.target.value)}
              />
            </div>
            <p className="col-span-2 -mt-1 text-xs text-slate-500">
              Monthly, the way it is quoted on the call. &ldquo;18k&rdquo; and &ldquo;1.8L&rdquo; are both understood.
            </p>

            <div>
              <label className="label" htmlFor="ed-shift">Shift</label>
              <input
                id="ed-shift"
                className="input"
                placeholder="Day / Rotational / US"
                value={f.shift}
                onChange={(e) => set("shift", e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="ed-education">Minimum education</label>
              <input
                id="ed-education"
                className="input"
                placeholder="Any degree"
                value={f.educationMin}
                onChange={(e) => set("educationMin", e.target.value)}
              />
            </div>

            <div>
              <label className="label" htmlFor="ed-status">Status</label>
              <select
                id="ed-status"
                className="input"
                value={f.status}
                onChange={(e) => set("status", e.target.value)}
              >
                {WORK_STATUSES.map((s) => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="ed-priority">Priority</label>
              <select
                id="ed-priority"
                className="input"
                value={f.priority}
                onChange={(e) => set("priority", e.target.value)}
              >
                {PRIORITY_OPTIONS.map((p) => (
                  <option key={p.key} value={p.key}>{p.label}</option>
                ))}
              </select>
            </div>

            <div className="col-span-2">
              <label className="label" htmlFor="ed-cab">Cab facility</label>
              <select
                id="ed-cab"
                className="input"
                value={f.cabFacility}
                onChange={(e) => set("cabFacility", e.target.value)}
              >
                {CAB_OPTIONS.map((c) => (
                  <option key={c.key} value={c.key}>{c.label}</option>
                ))}
              </select>
            </div>

            <div className="col-span-2 flex flex-wrap gap-x-6 gap-y-2 pt-1">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={f.relievingRequired}
                  onChange={(e) => set("relievingRequired", e.target.checked)}
                />
                Relieving letter required
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={f.arrearsAllowed}
                  onChange={(e) => set("arrearsAllowed", e.target.checked)}
                />
                Arrears allowed
              </label>
            </div>

            <div className="col-span-2">
              <label className="label" htmlFor="ed-notes">Notes</label>
              <textarea
                id="ed-notes"
                className="input"
                rows={3}
                placeholder="Anything the recruiter needs before the first call."
                value={f.notes}
                onChange={(e) => set("notes", e.target.value)}
              />
            </div>
          </div>

          {canSeeFees && (
            <div className="mt-6 border-t border-slate-200 pt-4">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-2">
                Commercials for this opening
              </div>
              {!ownFee && row.feeSource === "client" && (
                <p className="text-xs text-slate-500 mb-3">
                  Nothing set here, so this opening bills at the client&rsquo;s usual rate
                  {row.feeLabel ? ` — ${row.feeLabel}` : ""}. Fill this in only for a one-off rate.
                </p>
              )}
              {row.feeSource === "none" && (
                <p className="text-xs text-amber-700 mb-3">
                  No terms anywhere for this opening. A placement made against it cannot be billed.
                </p>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label" htmlFor="ed-feetype">Fee type</label>
                  <select
                    id="ed-feetype"
                    className="input"
                    value={fee.feeType}
                    onChange={(e) => setFeeField("feeType", e.target.value)}
                  >
                    <option value="">Use the client&rsquo;s rate</option>
                    <option value="percent">Percentage of CTC</option>
                    <option value="flat">Flat amount</option>
                  </select>
                </div>
                {fee.feeType === "percent" && (
                  <div>
                    <label className="label" htmlFor="ed-feepercent">Percentage</label>
                    <input
                      id="ed-feepercent"
                      className="input"
                      placeholder="8.33"
                      value={fee.feePercent}
                      onChange={(e) => setFeeField("feePercent", e.target.value)}
                    />
                  </div>
                )}
                {fee.feeType === "flat" && (
                  <div>
                    <label className="label" htmlFor="ed-feeflat">Amount</label>
                    <input
                      id="ed-feeflat"
                      className="input"
                      placeholder="8000"
                      value={fee.feeFlat}
                      onChange={(e) => setFeeField("feeFlat", e.target.value)}
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          <p className="text-xs text-slate-500 mt-6">
            The careers page switch stays on the row — an opening goes public one
            deliberate click at a time, and closing it here takes it down anyway.
          </p>
        </div>

        <div className="border-t border-slate-200 px-5 py-3 flex items-center justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
