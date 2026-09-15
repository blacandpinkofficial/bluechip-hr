"use client";
// Interviews — the "Interview Schedules" tab, with the productivity counts
// taken care of.
//
// The four numbers along the top are the ones the old workbook asked someone to
// type into a separate tab every evening: direct line-ups, telephonic line-ups,
// interviews attended, selects. Here they are counts of the rows below. Nobody
// tallies them, so nobody can round them.
//
// Everything on this screen happens on the row itself. The one exception is
// recording a placement, which is a whole record rather than a single field and
// so gets a panel down the right-hand side.

import { useCallback, useEffect, useState } from "react";
import Shell from "@/components/Shell";

const WHEN = [
  { key: "today", label: "Today" },
  { key: "upcoming", label: "Upcoming" },
  { key: "past", label: "Past" },
];

const MODES = ["telephonic", "direct", "video"];

const OUTCOME_TONE = {
  pending: "bg-slate-100 text-slate-700 border-slate-300",
  selected: "bg-emerald-100 text-emerald-800 border-emerald-300",
  rejected: "bg-red-100 text-red-800 border-red-300",
  "on-hold": "bg-amber-100 text-amber-900 border-amber-300",
  "no-show": "bg-slate-200 text-slate-700 border-slate-400",
};

// The pressed state of each outcome button. Written out in full, one complete
// class string per outcome, because a class name assembled from a variable is
// not in the stylesheet Tailwind builds and arrives at the browser as nothing.
const OUTCOME_ACTIVE = {
  pending: "bg-slate-500 text-white border-slate-500",
  selected: "bg-emerald-600 text-white border-emerald-600",
  rejected: "bg-red-600 text-white border-red-600",
  "on-hold": "bg-amber-500 text-white border-amber-500",
  "no-show": "bg-slate-600 text-white border-slate-600",
};

const OUTCOME_LABEL = {
  pending: "Pending",
  selected: "Selected",
  rejected: "Rejected",
  "on-hold": "On hold",
  "no-show": "No-show",
};

// The three a recruiter presses after the call. "No-show" lives with the
// attendance marks, where it belongs, and "pending" is the clear link.
const OUTCOME_BUTTONS = ["selected", "rejected", "on-hold"];

const IDLE = "bg-white border-slate-300 text-slate-600 hover:bg-slate-50";

// Where the submission that produced this interview stands. Full class strings,
// one per status, for the same reason the outcome maps above are written out.
const SUB_TONE = {
  sent: "bg-slate-100 text-slate-700 border-slate-300",
  acknowledged: "bg-sky-50 text-sky-800 border-sky-200",
  shortlisted: "bg-violet-50 text-violet-800 border-violet-200",
  "interview-scheduled": "bg-amber-50 text-amber-900 border-amber-200",
  rejected: "bg-red-50 text-red-800 border-red-200",
  "no-response": "bg-slate-100 text-slate-500 border-slate-300",
};

const SUB_LABEL = {
  sent: "Sent",
  acknowledged: "Acknowledged",
  shortlisted: "Shortlisted",
  "interview-scheduled": "Interview scheduled",
  rejected: "Rejected",
  "no-response": "No response",
};

function day(x) {
  if (!x) return "";
  const d = new Date(x);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function when(dt) {
  const d = new Date(dt);
  return d.toLocaleString("en-IN", {
    weekday: "short", day: "numeric", month: "short",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/** A date-time as the value a datetime-local input wants, in the reader's clock. */
function localInput(dt) {
  const d = dt ? new Date(dt) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Today as a date input wants it — from the local calendar, never from UTC. */
function todayInput() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * What the browser typed, as an unambiguous instant.
 *
 * "2026-09-15T10:30" carries no timezone, so the server would read it against
 * the SERVER's clock: a 10:30 interview booked in Chennai could be stored as
 * 10:30 UTC, which is four in the afternoon. Converting here means the moment
 * that travels is the moment the recruiter meant.
 */
function asInstant(localValue) {
  const d = new Date(localValue);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
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
  const [data, setData] = useState({ interviews: [], counts: {}, me: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  // Which row has its reschedule drawer open, and what is typed into it.
  const [sched, setSched] = useState(null); // { id, at, nextRound }

  // The placement panel: the interview it was opened from, plus the form.
  const [place, setPlace] = useState(null); // { interview, form, saving, error }

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

  function flash(msg) {
    setNote(msg);
    setTimeout(() => setNote(""), 4000);
  }

  async function patch(id, body, said) {
    setError("");
    setData((d) => ({
      ...d,
      interviews: (Array.isArray(d.interviews) ? d.interviews : []).map((i) =>
        i.id === id ? { ...i, ...body } : i
      ),
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
      } else if (said) {
        flash(said);
      }
      load();
    } catch {
      setError("That change did not save — check your connection.");
      load();
    }
  }

  function toggleReschedule(i) {
    setSched(
      sched && sched.id === i.id
        ? null
        : { id: i.id, at: localInput(i.scheduledAt), nextRound: false }
    );
  }

  async function saveReschedule(i) {
    if (!sched || sched.id !== i.id) return;
    const at = asInstant(sched.at);
    if (!at) {
      setError("Enter a valid date and time for the interview.");
      return;
    }
    const nextRound = !!sched.nextRound;
    const round = (Number(i.round) || 1) + 1;
    setSched(null);
    await patch(
      i.id,
      { scheduledAt: at, ...(nextRound ? { round } : {}) },
      nextRound
        ? `Round ${round} booked for ${i.candidate?.name || "the candidate"}.`
        : `Moved to ${when(at)}.`
    );
  }

  function openPlacement(i) {
    setPlace({
      interview: i,
      saving: false,
      error: "",
      form: {
        selectedOn: todayInput(),
        ctcOfferedAnnual: "",
        takeHomeMonthly: "",
        employeeId: "",
        joinedOn: "",
      },
    });
  }

  function setForm(fields) {
    setPlace((p) => (p ? { ...p, form: { ...p.form, ...fields }, error: "" } : p));
  }

  async function savePlacement(e) {
    e.preventDefault();
    if (!place || place.saving) return;
    const i = place.interview;
    const f = place.form;
    if (!String(f.ctcOfferedAnnual || "").trim()) {
      setPlace((p) => (p ? { ...p, error: "Enter the annual CTC offered — the fee is worked out from it." } : p));
      return;
    }
    setPlace((p) => (p ? { ...p, saving: true, error: "" } : p));
    try {
      const r = await fetch("/api/placements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidateId: i.candidateId,
          requirementId: i.requirementId,
          selectedOn: f.selectedOn || undefined,
          ctcOfferedAnnual: f.ctcOfferedAnnual,
          takeHomeMonthly: f.takeHomeMonthly || undefined,
          employeeId: f.employeeId || undefined,
          joinedOn: f.joinedOn || undefined,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        // 409 with an explanation is the useful case: no commercials on the
        // opening, or this placement already exists. The server's words are
        // better than anything this screen could invent, so they are shown.
        setPlace((p) => (p ? { ...p, saving: false, error: j.error || "Could not record the placement." } : p));
        load();
        return;
      }
      setPlace(null);
      flash(`Placement recorded for ${i.candidate?.name || "the candidate"} — it is on the Placements screen now.`);
      load();
    } catch {
      setPlace((p) => (p ? { ...p, saving: false, error: "Could not save — check your connection." } : p));
    }
  }

  const rows = Array.isArray(data.interviews) ? data.interviews : [];
  const c = data.counts || {};
  const me = data.me || {};
  const canWrite = me.canWrite !== false;

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
      {note && (
        <div role="status" className="card border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 mb-4">
          {note}
        </div>
      )}

      {loading ? (
        <div className="card p-10 text-center text-slate-400">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="card p-10 text-center">
          <div className="text-chip-900 font-medium">
            {tab === "today" ? "Nothing scheduled today." : tab === "past" ? "No past interviews." : "Nothing scheduled yet."}
          </div>
          <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
            Interviews are booked from a candidate on the Calls screen, or from the
            submission the client replied to — whichever you are looking at when
            they give you the slot.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <a href="/candidates" className="btn-primary inline-flex">Go to Calls</a>
            <a href="/submissions" className="btn-ghost inline-flex">Go to Submissions</a>
          </div>
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm min-w-[1100px]">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-left">
                <th className="px-4 py-2 font-medium text-slate-600">When</th>
                <th className="px-4 py-2 font-medium text-slate-600">Candidate</th>
                <th className="px-4 py-2 font-medium text-slate-600">Role &amp; client</th>
                <th className="px-4 py-2 font-medium text-slate-600">Mode</th>
                <th className="px-4 py-2 font-medium text-slate-600">Attended</th>
                <th className="px-4 py-2 font-medium text-slate-600">Outcome</th>
                <th className="px-4 py-2 font-medium text-slate-600">Feedback</th>
                <th className="px-4 py-2 font-medium text-slate-600">Next step</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => {
                const open = !!sched && sched.id === i.id;
                const outcome = i.outcome || "pending";
                return [
                  <tr
                    key={i.id}
                    className={
                      "border-b align-top " +
                      (open
                        ? "border-slate-200 bg-slate-50"
                        : "border-slate-100 last:border-0 hover:bg-slate-50/60")
                    }
                  >
                    <td className="px-4 py-3 whitespace-nowrap">
                      {when(i.scheduledAt)}
                      <div className="text-[11px] text-slate-500">
                        Round {i.round || 1}
                        {i.interviewer ? ` · ${i.interviewer}` : ""}
                      </div>
                    </td>
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
                      {/* The other half of the same event: the CV that got them
                          here. Without it, nobody reading this row can tell
                          whether the client ever received a CV, who sent it, or
                          what the client wrote back. */}
                      {i.submission ? (
                        <div className="mt-1.5 flex flex-wrap items-center gap-1">
                          <span
                            className={
                              "rounded border px-1.5 py-0.5 text-[11px] " +
                              (SUB_TONE[i.submission.status] || SUB_TONE.sent)
                            }
                          >
                            {SUB_LABEL[i.submission.status] || i.submission.status}
                          </span>
                          <a
                            href="/submissions"
                            className="text-[11px] text-chip-700 underline hover:text-chip-800"
                          >
                            CV sent {day(i.submission.sentAt)}
                            {i.submission.sentByName ? ` by ${i.submission.sentByName}` : ""}
                          </a>
                        </div>
                      ) : (
                        <div className="mt-1.5 text-[11px] text-slate-400">
                          No CV submission recorded for this opening.
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <select
                        id={`mode-${i.id}`}
                        className="input py-1 text-xs w-auto"
                        value={i.mode}
                        disabled={!canWrite}
                        onChange={(e) => patch(i.id, { mode: e.target.value })}
                        aria-label="Interview mode"
                      >
                        {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        <button
                          disabled={!canWrite}
                          onClick={() => patch(i.id, { attended: i.attended === true ? null : true })}
                          className={
                            "px-2 py-1 text-xs rounded border transition disabled:opacity-50 " +
                            (i.attended === true ? "bg-emerald-600 text-white border-emerald-600" : IDLE)
                          }
                        >
                          Came
                        </button>
                        <button
                          disabled={!canWrite}
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
                            "px-2 py-1 text-xs rounded border transition disabled:opacity-50 " +
                            (i.attended === false ? "bg-slate-600 text-white border-slate-600" : IDLE)
                          }
                        >
                          No-show
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {OUTCOME_BUTTONS.map((o) => (
                          <button
                            key={o}
                            disabled={!canWrite}
                            aria-pressed={outcome === o}
                            onClick={() => patch(i.id, { outcome: o }, `${i.candidate?.name || "Candidate"}: ${OUTCOME_LABEL[o].toLowerCase()}.`)}
                            className={
                              "px-2 py-1 text-xs rounded border transition disabled:opacity-50 " +
                              (outcome === o ? OUTCOME_ACTIVE[o] : IDLE)
                            }
                          >
                            {OUTCOME_LABEL[o]}
                          </button>
                        ))}
                      </div>
                      {outcome !== "pending" && (
                        <div className="mt-1 flex items-center gap-2">
                          <span
                            className={
                              "inline-block rounded border px-1.5 py-0.5 text-[11px] " +
                              (OUTCOME_TONE[outcome] || OUTCOME_TONE.pending)
                            }
                          >
                            {OUTCOME_LABEL[outcome] || outcome}
                          </span>
                          {canWrite && (
                            <button
                              onClick={() => patch(i.id, { outcome: "pending" })}
                              className="text-[11px] text-slate-500 underline hover:text-slate-700"
                            >
                              clear
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 min-w-[14rem]">
                      <input
                        id={`fb-${i.id}`}
                        className="input py-1 text-xs"
                        placeholder="What the client said"
                        defaultValue={i.feedback || ""}
                        disabled={!canWrite}
                        onBlur={(e) =>
                          e.target.value !== (i.feedback || "") &&
                          patch(i.id, { feedback: e.target.value }, "Feedback saved.")
                        }
                      />
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex flex-col items-start gap-1">
                        {canWrite && (
                          <button
                            onClick={() => toggleReschedule(i)}
                            className={"px-2 py-1 text-xs rounded border transition " + IDLE}
                          >
                            {open ? "Close" : "Reschedule"}
                          </button>
                        )}
                        {outcome === "selected" && (
                          i.placement ? (
                            <a
                              href="/placements"
                              className="inline-block rounded border border-emerald-300 bg-emerald-100 px-2 py-1 text-[11px] text-emerald-800"
                            >
                              {i.placement.dropped
                                ? "Placement dropped"
                                : i.placement.joined
                                ? "Placed · joined"
                                : "Placement recorded"}
                            </a>
                          ) : me.canPlace ? (
                            <button
                              onClick={() => openPlacement(i)}
                              className="btn-primary px-2 py-1 text-xs"
                            >
                              Record placement
                            </button>
                          ) : null
                        )}
                      </div>
                    </td>
                  </tr>,

                  open ? (
                    <tr key={`${i.id}-when`} className="border-b border-slate-200 bg-slate-50">
                      <td colSpan={8} className="px-4 pb-4 pt-0">
                        <div className="flex flex-wrap items-end gap-4">
                          <div>
                            <label className="label" htmlFor={`at-${i.id}`}>New date &amp; time</label>
                            <input
                              id={`at-${i.id}`}
                              type="datetime-local"
                              className="input w-auto"
                              value={sched.at}
                              onChange={(e) => setSched((s) => ({ ...s, at: e.target.value }))}
                            />
                          </div>
                          <label className="flex items-start gap-2 text-sm pb-1" htmlFor={`nr-${i.id}`}>
                            <input
                              id={`nr-${i.id}`}
                              type="checkbox"
                              className="h-4 w-4 mt-0.5"
                              checked={!!sched.nextRound}
                              onChange={(e) => setSched((s) => ({ ...s, nextRound: e.target.checked }))}
                            />
                            <span>
                              This is the next round, not a move
                              <span className="block text-[11px] text-slate-500">
                                Round {i.round || 1} &rarr; {(Number(i.round) || 1) + 1}. The attendance
                                mark and the outcome start again.
                              </span>
                            </span>
                          </label>
                          <button onClick={() => saveReschedule(i)} className="btn-primary mb-0.5">
                            Save
                          </button>
                          <button onClick={() => setSched(null)} className="btn-ghost mb-0.5">
                            Cancel
                          </button>
                        </div>
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-slate-500 mt-3 max-w-prose">
        Recording an outcome marks the interview attended automatically — except
        a no-show, which marks the opposite. The candidate moves with it, forward
        only: a selected candidate is never dragged back by a later stray edit.
        A selection becomes a placement from the last column, once.
      </p>

      {place && (
        <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-label="Record placement">
          <div
            className="absolute inset-0 bg-slate-900/20"
            onClick={() => !place.saving && setPlace(null)}
          />
          <form
            onSubmit={savePlacement}
            className="relative z-10 h-full w-full max-w-md overflow-y-auto border-l border-slate-200 bg-white p-5 shadow-xl"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-chip-900">Record placement</h2>
                <p className="text-sm text-slate-500">
                  The selection becomes a billable placement. The fee is worked out
                  from the rate on file for this client and then frozen.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPlace(null)}
                className="text-slate-400 hover:text-slate-600 text-xl leading-none"
                aria-label="Close"
              >
                &times;
              </button>
            </div>

            <div className="card mt-4 p-3 text-sm">
              <div className="font-medium text-chip-900">{place.interview.candidate?.name}</div>
              <div className="text-xs text-slate-500 tabular-nums">{place.interview.candidate?.phone}</div>
              <div className="mt-2">{place.interview.requirement?.designation}</div>
              <div className="text-xs text-slate-500">
                {[place.interview.requirement?.clientName, place.interview.requirement?.location]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>

            {place.error && (
              <div role="alert" className="card border-red-200 bg-red-50 p-3 text-sm text-red-800 mt-4">
                {place.error}
              </div>
            )}

            <div className="mt-4 space-y-4">
              <div>
                <label className="label" htmlFor="p-selected">Selected on</label>
                <input
                  id="p-selected"
                  type="date"
                  className="input"
                  value={place.form.selectedOn}
                  onChange={(e) => setForm({ selectedOn: e.target.value })}
                />
              </div>

              <div>
                <label className="label" htmlFor="p-ctc">Annual CTC offered</label>
                <input
                  id="p-ctc"
                  className="input"
                  placeholder="3.6L, or 360000"
                  value={place.form.ctcOfferedAnnual}
                  onChange={(e) => setForm({ ctcOfferedAnnual: e.target.value })}
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  The fee is worked out from this figure, so it has to be the annual
                  one, not the monthly.
                </p>
              </div>

              <div>
                <label className="label" htmlFor="p-takehome">Take-home per month (optional)</label>
                <input
                  id="p-takehome"
                  className="input"
                  placeholder="25k"
                  value={place.form.takeHomeMonthly}
                  onChange={(e) => setForm({ takeHomeMonthly: e.target.value })}
                />
              </div>

              <div>
                <label className="label" htmlFor="p-empid">Employee ID (optional)</label>
                <input
                  id="p-empid"
                  className="input"
                  placeholder="Given by the client after joining"
                  value={place.form.employeeId}
                  onChange={(e) => setForm({ employeeId: e.target.value })}
                />
              </div>

              <div>
                <label className="label" htmlFor="p-joined">Joining date (leave blank until they actually join)</label>
                <input
                  id="p-joined"
                  type="date"
                  className="input"
                  value={place.form.joinedOn}
                  onChange={(e) => setForm({ joinedOn: e.target.value })}
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  A selection is a promise; only a joining can be invoiced. It is
                  marked on the Placements screen the day it happens.
                </p>
              </div>
            </div>

            <div className="mt-6 flex gap-2">
              <button type="submit" className="btn-primary" disabled={place.saving}>
                {place.saving ? "Saving…" : "Record placement"}
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setPlace(null)}
                disabled={place.saving}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </Shell>
  );
}
