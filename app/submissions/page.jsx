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

import { Fragment, useCallback, useEffect, useState, useRef } from "react";
import Shell from "@/components/Shell";
import LoadMore from "@/components/LoadMore";

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

const MODES = [
  { key: "telephonic", label: "Telephonic" },
  { key: "direct", label: "In person" },
  { key: "video", label: "Video" },
];

// The outcome of an interview, once there is one, so this screen can say how it
// went rather than only that it was booked. Full class strings, one per
// outcome: a class name assembled from a variable is not in the stylesheet
// Tailwind builds and arrives at the browser as nothing at all.
const OUTCOME_TONE = {
  pending: "bg-slate-100 text-slate-600 border-slate-300",
  selected: "bg-emerald-50 text-emerald-800 border-emerald-200",
  rejected: "bg-red-50 text-red-800 border-red-200",
  "on-hold": "bg-amber-50 text-amber-900 border-amber-200",
  "no-show": "bg-slate-200 text-slate-600 border-slate-400",
};

const OUTCOME_LABEL = {
  pending: "Awaiting outcome",
  selected: "Selected",
  rejected: "Rejected at interview",
  "on-hold": "On hold",
  "no-show": "Did not attend",
};

function dt(x) {
  return x ? new Date(x).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—";
}

/** The date and the time, which is what an interview is actually made of. */
function dtTime(x) {
  if (!x) return "—";
  const d = new Date(x);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", {
    weekday: "short", day: "numeric", month: "short",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/**
 * The default slot: tomorrow at eleven. A blank box is one more thing to think
 * about while the client is still on the line, and almost every interview this
 * desk books is a day or two out in the late morning.
 */
function defaultSlot() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(11, 0, 0, 0);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * What the browser typed, as an unambiguous instant.
 *
 * "2026-09-15T10:30" carries no timezone, so the server would read it against
 * the SERVER's clock: an 11am interview booked in Chennai could be stored as
 * 11am UTC, which is half past four in the afternoon. Converting here means the
 * moment that travels is the moment the recruiter meant.
 */
function asInstant(localValue) {
  const d = new Date(localValue);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
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
  const [loadingMore, setLoadingMore] = useState(false);
  // What the SERVER says it served, not what is on screen — the two drift the
  // moment a duplicate is dropped, and an offset taken from the screen then
  // asks for a row it already has, forever.
  const [nextSkip, setNextSkip] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  // Which view the rows on screen belong to. A "load more" still in flight when
  // someone changes tab would otherwise append the old list's next page onto
  // the new one, and it would stay there.
  const viewRef = useRef(null);
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

  // The interview being booked, inline under its own row. One at a time, and
  // never a dialog: the client is on the phone saying "Thursday eleven", and a
  // box that covers the screen is a box the recruiter has to dismiss before
  // they can read the row they were looking at.
  // { id, at, mode, interviewer, location, round, saving, error, clash }
  const [sched, setSched] = useState(null);

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
        viewRef.current = filter;
        setNextSkip((j.page?.skip || 0) + (j.page?.returned || 0));
        setHasMore(!!j.page?.hasMore);
        setError("");
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    },
    [filter]
  );

  // The next page, merged into the payload already held. Everything else on
  // this screen reads from `data`, so the extra rows have to arrive inside it
  // rather than beside it — and the counts the server sends with them (silent,
  // orphaned) are for the whole set, not for the page, so the newer copy wins.
  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const mine = viewRef.current;
      const p = new URLSearchParams({ skip: String(nextSkip) });
      if (filter) p.set("status", filter);
      const r = await fetch(`/api/submissions?${p}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load more.");
      if (viewRef.current !== mine) return;
      setNextSkip((j.page?.skip || 0) + (j.page?.returned || 0));
      setHasMore(!!j.page?.hasMore);
      setData((d) => {
        const have = Array.isArray(d?.submissions) ? d.submissions : [];
        const seen = new Set(have.map((x) => x.id));
        const more = (Array.isArray(j.submissions) ? j.submissions : []).filter((x) => !seen.has(x.id));
        // ...j overwrites silent, scheduledWithoutInterview and totalCount with
        // the values that came back alongside this page. That is correct ONLY
        // because the server now counts those over every submission matching
        // the filter rather than over the page it is sending. If that ever goes
        // back to being per-page, this line starts blanking the banner.
        return { ...d, ...j, submissions: [...have, ...more] };
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingMore(false);
    }
  }, [filter, nextSkip]);

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
      const moved = j.candidateStage
        ? `Saved. ${name || "The candidate"} is now at ${j.candidateStage}.`
        : "Saved.";
      // Marking a submission "interview scheduled" by hand does not put anything
      // on the Interviews screen. Saying so here is the difference between the
      // desk thinking a slot is booked and the slot actually being booked.
      setFlash(
        j.interviewMissing
          ? `${moved} No interview is on the calendar for this yet — use Schedule interview to book the slot.`
          : moved
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId("");
      load(true);
    }
  }

  function openEditor(s) {
    setSched(null);
    setEditing(s.id);
    setDraft({ status: s.status, response: s.response || "" });
  }

  function toggleScheduler(s) {
    if (sched && sched.id === s.id) {
      setSched(null);
      return;
    }
    setEditing(null);
    setError("");
    setSched({
      id: s.id,
      at: defaultSlot(),
      mode: "telephonic",
      interviewer: "",
      location: s.requirement?.location || "",
      round: 1,
      saving: false,
      error: "",
      clash: null,
    });
  }

  // Editing anything clears the last complaint — but `fields` is spread LAST, so
  // a caller that is deliberately setting an error still gets to set it. With
  // the clear after the spread, the one place that reports a bad date silently
  // erased its own message and the Book button looked like it did nothing.
  function setSchedField(fields) {
    setSched((p) => (p ? { ...p, error: "", clash: null, ...fields } : p));
  }

  /**
   * Book the interview.
   *
   * One request, to /api/interviews, carrying this submission's id. That one
   * handler writes the interview row, sets this submission to
   * "interview-scheduled" and moves the candidate to lined-up, inside a single
   * transaction. Doing it as two calls from here — create the interview, then
   * patch the submission — is what leaves a booked interview against a
   * submission that still reads "shortlisted" when the second call fails.
   */
  async function book(s, { confirmDuplicate = false, round } = {}) {
    if (!sched || sched.id !== s.id || sched.saving) return;
    const at = asInstant(sched.at);
    if (!at) {
      setSchedField({ error: "Enter a valid date and time for the interview." });
      return;
    }
    const useRound = round || sched.round || 1;
    setSched((p) => (p ? { ...p, saving: true, error: "", clash: null } : p));
    try {
      const r = await fetch("/api/interviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          submissionId: s.id,
          candidateId: s.candidateId,
          requirementId: s.requirementId,
          scheduledAt: at,
          mode: sched.mode,
          round: useRound,
          interviewer: sched.interviewer || undefined,
          location: sched.location || undefined,
          confirmDuplicate: confirmDuplicate || undefined,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        // A 409 asking "this is already booked, did you mean to?" is a question,
        // not a failure. It comes back with the interview that already exists,
        // so the answer can be to open that one instead of making a second.
        if (j.needsConfirmation) {
          setSched((p) =>
            p ? { ...p, saving: false, error: j.error || "", clash: { ...j.existing, nextRound: j.nextRound } } : p
          );
          return;
        }
        setSched((p) => (p ? { ...p, saving: false, error: j.error || "Could not book the interview." } : p));
        return;
      }
      setSched(null);
      const nm = s.candidate?.name || "The candidate";
      setFlash(
        `Interview booked for ${nm} — ${dtTime(j.interview?.scheduledAt || at)}.` +
          (j.movedTo ? ` ${nm} is now at ${j.movedTo}.` : "") +
          " It is on the Interviews screen now."
      );
      load(true);
    } catch {
      setSched((p) => (p ? { ...p, saving: false, error: "Could not book it — check your connection." } : p));
    }
  }

  const statuses = data && Array.isArray(data.statuses) ? data.statuses : [];
  const submissions = data && Array.isArray(data.submissions) ? data.submissions : [];
  const canSchedule = !!(data && data.canScheduleInterview);
  const canSeeInterviews = !!(data && data.canSeeInterviews);

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

      {data?.scheduledWithoutInterview > 0 && (
        <div className="card border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 mb-4">
          {data.scheduledWithoutInterview} submission
          {data.scheduledWithoutInterview === 1 ? " says" : "s say"} an interview is scheduled, but there is
          no interview on the calendar for {data.scheduledWithoutInterview === 1 ? "it" : "them"}.
          Nobody will be reminded and it will not appear in the day&rsquo;s figures.
          Use <span className="font-medium">Schedule interview</span> on the row to book the slot properly.
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
                const busy = busyId === s.id;
                const name = s.candidate?.name || "";
                const iv = s.interview || null;
                const scheduling = !!sched && sched.id === s.id;
                // "Schedule interview" replaces the plain status button rather
                // than sitting beside it. The status on its own was the bug:
                // the row said an interview was scheduled and no interview
                // existed. Offered while the submission is still live, and once
                // there is already an interview the row points at that instead.
                const offerSchedule =
                  canSchedule && !iv && s.status !== "rejected" && s.status !== "no-response";
                const next = NEXT[s.status];
                // Suppress only the rung that used to lie. The rest of the
                // ladder is untouched, and someone without interview.write
                // keeps the plain button so the flow is not a dead end.
                const showNext = next && !(next === "interview-scheduled" && offerSchedule);
                return (
                  <Fragment key={s.id}>
                  <tr
                    className={
                      "border-t align-top " +
                      (scheduling || editing === s.id
                        ? "border-slate-200 bg-slate-50/70 "
                        : "border-slate-100 ") +
                      (busy ? "opacity-50" : "")
                    }
                  >
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
                        {showNext && (
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
                        {offerSchedule && (
                          <RowButton
                            tone="go"
                            disabled={busy}
                            onClick={() => toggleScheduler(s)}
                            title={`Book the slot, mark this interview-scheduled and move ${name || "the candidate"} to lined-up — all in one go`}
                          >
                            {scheduling ? "Close" : "Schedule interview"}
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
                      {/* The other half of the same event. Without this line,
                          someone reading this screen cannot tell whether the
                          interview it claims is scheduled actually exists. */}
                      {iv ? (
                        <div className="mt-1.5 text-xs text-slate-600">
                          <span className="font-medium text-chip-900">{dtTime(iv.scheduledAt)}</span>
                          <span className="text-slate-500">
                            {" · "}
                            {(MODES.find((m) => m.key === iv.mode) || {}).label || iv.mode}
                            {(iv.round || 1) > 1 ? ` · round ${iv.round}` : ""}
                            {iv.interviewer ? ` · ${iv.interviewer}` : ""}
                          </span>
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            {iv.outcome && iv.outcome !== "pending" && (
                              <span
                                className={
                                  "text-[11px] px-2 py-0.5 rounded border " +
                                  (OUTCOME_TONE[iv.outcome] || OUTCOME_TONE.pending)
                                }
                              >
                                {OUTCOME_LABEL[iv.outcome] || iv.outcome}
                              </span>
                            )}
                            <a href="/interviews" className="text-[11px] text-chip-700 underline hover:text-chip-800">
                              Open on Interviews
                            </a>
                          </div>
                        </div>
                      ) : (
                        s.status === "interview-scheduled" &&
                        canSeeInterviews && (
                          <div className="mt-1.5 text-[11px] text-amber-800">
                            Marked scheduled, but no interview is on the calendar
                            {canSchedule ? " — book the slot above." : "."}
                          </div>
                        )
                      )}
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

                  {scheduling && (
                    <tr className="border-t border-slate-200 bg-slate-50/70">
                      <td colSpan={8} className="p-3">
                        <div className="text-xs text-slate-500 mb-2">
                          Books the interview, marks this submission interview-scheduled and moves{" "}
                          {name || "the candidate"} to lined-up — one save, all three.
                        </div>

                        <div className="flex flex-wrap items-end gap-3">
                          <div>
                            <label className="label" htmlFor={`iv-at-${s.id}`}>Date &amp; time</label>
                            <input
                              id={`iv-at-${s.id}`}
                              type="datetime-local"
                              className="input w-auto"
                              value={sched.at}
                              onChange={(e) => setSchedField({ at: e.target.value })}
                            />
                          </div>
                          <div className="w-40">
                            <label className="label" htmlFor={`iv-mode-${s.id}`}>How</label>
                            <select
                              id={`iv-mode-${s.id}`}
                              className="input"
                              value={sched.mode}
                              onChange={(e) => setSchedField({ mode: e.target.value })}
                            >
                              {MODES.map((m) => (
                                <option key={m.key} value={m.key}>{m.label}</option>
                              ))}
                            </select>
                          </div>
                          <div className="w-44">
                            <label className="label" htmlFor={`iv-by-${s.id}`}>Who is taking it</label>
                            <input
                              id={`iv-by-${s.id}`}
                              className="input"
                              placeholder={s.client?.hrName || "HR name (optional)"}
                              value={sched.interviewer}
                              onChange={(e) => setSchedField({ interviewer: e.target.value })}
                            />
                          </div>
                          <div className="w-44">
                            <label className="label" htmlFor={`iv-where-${s.id}`}>Where</label>
                            <input
                              id={`iv-where-${s.id}`}
                              className="input"
                              placeholder="Office, or the client's address"
                              value={sched.location}
                              onChange={(e) => setSchedField({ location: e.target.value })}
                            />
                          </div>
                          <button
                            type="button"
                            className="btn-primary"
                            disabled={sched.saving}
                            onClick={() => book(s)}
                          >
                            {sched.saving ? "Booking…" : "Book it"}
                          </button>
                          <button
                            type="button"
                            className="btn-ghost"
                            disabled={sched.saving}
                            onClick={() => setSched(null)}
                          >
                            Cancel
                          </button>
                        </div>

                        {/* An interview already exists for this candidate on
                            this opening at this round. Offered rather than
                            refused: open the one that exists, book the next
                            round, or say that a second really is meant. */}
                        {sched.clash ? (
                          <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
                            <div>{sched.error || "That interview is already booked."}</div>
                            <div className="mt-1 text-xs">
                              Round {sched.clash.round || 1} is at{" "}
                              <span className="font-medium">{dtTime(sched.clash.scheduledAt)}</span>
                              {sched.clash.interviewer ? ` with ${sched.clash.interviewer}` : ""}.
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <a href="/interviews" className="btn-ghost text-xs px-2 py-1">
                                Open it on Interviews
                              </a>
                              {sched.clash.nextRound > (sched.clash.round || 1) && (
                                <RowButton
                                  tone="go"
                                  disabled={sched.saving}
                                  onClick={() => {
                                    setSchedField({ round: sched.clash.nextRound });
                                    book(s, { round: sched.clash.nextRound });
                                  }}
                                >
                                  Book round {sched.clash.nextRound} instead
                                </RowButton>
                              )}
                              <RowButton
                                disabled={sched.saving}
                                onClick={() => book(s, { confirmDuplicate: true })}
                                title="There really are two separate panels at this round"
                              >
                                Book a second one anyway
                              </RowButton>
                            </div>
                          </div>
                        ) : sched.error ? (
                          <div role="alert" className="mt-3 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-800">
                            {sched.error}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  )}

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
      <p className="text-xs text-slate-500 mt-2 max-w-prose">
        When the client gives you a slot, use <span className="font-medium">Schedule interview</span> rather
        than the status on its own. It writes the interview, this row and the candidate&rsquo;s stage
        together — so the interview appears on the Interviews screen and in the day&rsquo;s figures
        instead of existing only as a word on this one.
      </p>
      {/* The true count and the next page. Until this existed the list simply
          stopped at the server's take and said nothing about it. */}
      <LoadMore
        shown={data?.submissions?.length || 0}
        total={data?.totalCount || 0}
        hasMore={hasMore}
        busy={loadingMore}
        onMore={loadMore}
        noun="submissions"
      />
    </Shell>
  );
}
