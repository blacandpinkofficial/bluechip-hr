"use client";
// Submissions — which CV went to which client, when, and what came back.
//
// The column that earns this screen its place is "days silent". Everything else
// here could be reconstructed from someone's sent folder; that one could not,
// and it is the one that turns "I sent it last week" into "chase this today".
//
// Recording the client's reply is the one action this screen exists for, so it
// is one click on the row. The client says "we'll interview him" on the phone;
// by the time the recruiter has opened a form, chosen a status and saved, they
// have stopped doing it. The note and the full status list stay one click
// further in, inline under the row, for the times the reply needs words.

import { Fragment, useCallback, useEffect, useState } from "react";
import Shell from "@/components/Shell";

const TONE = {
  sent: "bg-slate-100 text-slate-700 border-slate-300",
  acknowledged: "bg-sky-50 text-sky-800 border-sky-200",
  shortlisted: "bg-violet-50 text-violet-800 border-violet-200",
  "interview-scheduled": "bg-amber-50 text-amber-900 border-amber-200",
  rejected: "bg-red-50 text-red-800 border-red-200",
  "no-response": "bg-slate-100 text-slate-500 border-slate-300",
};

// The ladder a submission climbs when things are going well. One step at a
// time, because that is how the client actually replies.
const NEXT = {
  sent: "acknowledged",
  acknowledged: "shortlisted",
  shortlisted: "interview-scheduled",
};

const LABEL = {
  sent: "Sent",
  acknowledged: "Acknowledged",
  shortlisted: "Shortlisted",
  "interview-scheduled": "Interview scheduled",
  rejected: "Rejected",
  "no-response": "No response",
};

// What each move says about the candidate, mirrored from the server so the
// confirmation can name it. The server is the authority; this is only wording.
const STAGE_NOTE = {
  shortlisted: "shortlisted",
  "interview-scheduled": "lined-up",
};

function dt(x) {
  return x ? new Date(x).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—";
}

/** The small square-shouldered button every row action is made of. */
function RowButton({ children, onClick, disabled, title, tone = "plain" }) {
  const tones = {
    plain: "bg-white text-slate-600 border-slate-300 hover:bg-slate-50 hover:text-chip-700",
    go: "bg-chip-50 text-chip-800 border-chip-300 hover:bg-chip-100",
    stop: "bg-white text-red-700 border-red-200 hover:bg-red-50",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={
        "text-[11px] px-2 py-0.5 rounded border transition disabled:opacity-40 disabled:cursor-not-allowed " +
        tones[tone]
      }
    >
      {children}
    </button>
  );
}

export default function SubmissionsPage() {
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Cleared on a timer. Without one the green "Saved." banner stayed on screen
  // for the rest of the session, so it stopped meaning anything.
  const [flash, setFlash] = useState("");
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(""), 3000);
    return () => clearTimeout(t);
  }, [flash]);
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState({ status: "", response: "" });
  const [busyId, setBusyId] = useState("");

  // `quiet` refreshes without blanking the table. A one-click action that
  // replaces the list with "Loading…" reads as the page breaking.
  const load = useCallback(
    async (quiet) => {
      if (!quiet) setLoading(true);
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
    },
    [filter]
  );

  useEffect(() => { load(); }, [load]);

  async function update(id, body, { close = false, name = "" } = {}) {
    setBusyId(id);
    setError("");
    // Optimistic, so the row changes under the cursor rather than after a
    // round trip. The reload below is what makes it true.
    setData((d) => {
      if (!d || !Array.isArray(d.submissions)) return d;
      return {
        ...d,
        submissions: d.submissions.map((s) => (s.id === id ? { ...s, ...body } : s)),
      };
    });
    try {
      const r = await fetch("/api/submissions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...body }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "That did not save.");
      if (close) setEditing(null);
      // Say when the candidate moved too. The recruiter did not ask for it and
      // would otherwise find out days later on another screen.
      setFlash(
        j.candidateStage
          ? `Saved. ${name || "The candidate"} is now at ${j.candidateStage}.`
          : "Saved."
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId("");
      load(true);
    }
  }

  function openEditor(s) {
    setEditing(s.id);
    setDraft({ status: s.status, response: s.response || "" });
  }

  const statuses = data && Array.isArray(data.statuses) ? data.statuses : [];
  const submissions = data && Array.isArray(data.submissions) ? data.submissions : [];

  return (
    <Shell
      title="Submissions"
      subtitle="Every CV sent to a client, with the date it went and whether they ever replied."
      actions={
        <select aria-label="Filter by status" className="input max-w-[13rem]" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All</option>
          {statuses.map((s) => <option key={s} value={s}>{LABEL[s] || s}</option>)}
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

      {/* `!data` as well as `loading`. These screens set `data` only on success,
          so a 500 or a dropped connection left it null while `loading` went
          false — and the very next line dereferenced it, replacing the whole
          page with a React render error. The error banner above is what should
          be showing at that moment. */}
      {loading ? (
        <div className="card p-10 text-center text-slate-400">Loading…</div>
      ) : !data ? null : submissions.length === 0 ? (
        <div className="card p-10 text-center">
          <div className="text-chip-900 font-medium">Nothing sent yet.</div>
          <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
            Send a CV from the candidate&rsquo;s screen and it is recorded here — with the date,
            which matters if two agencies ever claim the same candidate.
          </p>
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm min-w-[980px]">
            <thead className="bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="p-3 font-medium">Candidate</th>
                <th className="p-3 font-medium">Client</th>
                <th className="p-3 font-medium">For</th>
                <th className="p-3 font-medium">Sent</th>
                <th className="p-3 font-medium text-right">Silent</th>
                <th className="p-3 font-medium">Where it stands</th>
                <th className="p-3 font-medium">By</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {submissions.map((s) => {
                const next = NEXT[s.status];
                const busy = busyId === s.id;
                const name = s.candidate?.name || "";
                return (
                  <Fragment key={s.id}>
                  <tr className={"border-t border-slate-100 align-top " + (busy ? "opacity-50" : "")}>
                    <td className="p-3">
                      <div className="font-medium text-chip-900">{name}</div>
                      <div className="text-xs text-slate-500">{s.candidate?.phone}</div>
                    </td>
                    <td className="p-3">{s.client?.name}</td>
                    <td className="p-3 text-slate-600">{s.requirement?.designation}</td>
                    <td className="p-3 text-slate-500 whitespace-nowrap">{dt(s.sentAt)}</td>
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
                      {/* Status, and the replies that can come next. No dialog:
                          the client said it on the phone, this records it
                          before they have hung up. */}
                      <div className="flex flex-wrap items-center gap-1">
                        <span className={"text-[11px] px-2 py-0.5 rounded border " + (TONE[s.status] || TONE.sent)}>
                          {LABEL[s.status] || s.status}
                        </span>
                        {next && (
                          <RowButton
                            tone="go"
                            disabled={busy}
                            onClick={() => update(s.id, { status: next }, { name })}
                            title={
                              STAGE_NOTE[next]
                                ? `Record this reply, and move ${name || "the candidate"} to ${STAGE_NOTE[next]}`
                                : "Record this reply"
                            }
                          >
                            {LABEL[next]}
                          </RowButton>
                        )}
                        {s.status !== "rejected" && (
                          <RowButton
                            tone="stop"
                            disabled={busy}
                            onClick={() => update(s.id, { status: "rejected" }, { name })}
                            title="The client passed on this candidate for this opening"
                          >
                            Rejected
                          </RowButton>
                        )}
                        {s.status === "sent" && (
                          <RowButton
                            disabled={busy}
                            onClick={() => update(s.id, { status: "no-response" }, { name })}
                            title="Chased and got nothing back"
                          >
                            No reply
                          </RowButton>
                        )}
                      </div>
                      {s.respondedAt && (
                        <div className="text-[11px] text-slate-400 mt-1">Replied {dt(s.respondedAt)}</div>
                      )}
                      {s.response && (
                        <div className="text-xs text-slate-500 mt-1 max-w-xs">{s.response}</div>
                      )}
                    </td>
                    <td className="p-3 text-slate-500">{s.sentBy?.name}</td>
                    <td className="p-3 text-right">
                      <button
                        type="button"
                        className="text-xs text-slate-400 hover:text-chip-700"
                        onClick={() => (editing === s.id ? setEditing(null) : openEditor(s))}
                      >
                        {editing === s.id ? "Close" : s.response ? "Edit note" : "Add note"}
                      </button>
                    </td>
                  </tr>

                  {editing === s.id && (
                    <tr className="border-t border-slate-100 bg-slate-50/70">
                      <td colSpan={8} className="p-3">
                        <div className="flex flex-wrap items-end gap-3">
                          <div className="w-52">
                            <label className="label" htmlFor={`st-${s.id}`}>Status</label>
                            <select
                              id={`st-${s.id}`}
                              className="input"
                              value={draft.status}
                              onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value }))}
                            >
                              {statuses.map((x) => (
                                <option key={x} value={x}>{LABEL[x] || x}</option>
                              ))}
                            </select>
                          </div>
                          <div className="flex-1 min-w-[16rem]">
                            <label className="label" htmlFor={`rs-${s.id}`}>What the client said</label>
                            <input
                              id={`rs-${s.id}`}
                              className="input"
                              placeholder="Interview Thursday 11am, ask him to carry the relieving letter"
                              value={draft.response}
                              onChange={(e) => setDraft((d) => ({ ...d, response: e.target.value }))}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  update(s.id, { status: draft.status, response: draft.response }, { close: true, name });
                                }
                              }}
                            />
                          </div>
                          <button
                            type="button"
                            className="btn-primary"
                            disabled={busy}
                            onClick={() =>
                              update(s.id, { status: draft.status, response: draft.response }, { close: true, name })
                            }
                          >
                            Save
                          </button>
                          <button type="button" className="btn-ghost" onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-slate-500 mt-4 max-w-prose">
        Record what the client said as soon as they say it. A submission left on
        &ldquo;sent&rdquo; keeps appearing in your list as unanswered, and one that is really
        rejected crowds out the ones still worth chasing. Marking one shortlisted or
        interview-scheduled also moves the candidate along on their own screen, so the
        two never disagree.
      </p>
    </Shell>
  );
}
