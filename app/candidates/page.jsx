"use client";
// The call screen — the one a recruiter has open all day.
//
// Everything needed to make a call and record it lives on this page: who to
// ring, what the client will refuse, what has not been asked yet, and one click
// per outcome. No navigating to a detail page and back forty times a day.
//
// The queues are the day's shape, in the order a desk actually works:
//   Callbacks due  — promised a time, the time has come. Breaking these is how
//                    candidates are lost.
//   Never called   — the top of the pile.
//   Going cold     — live candidates not spoken to in three days.
//   Everyone       — the search fallback.
//   History        — the people who said no, or were put aside. Not a bin: a
//                    destination, with every call still on the record and one
//                    button to bring them back.
//
// Every outcome is one click ON THE ROW. No dialog opens, nothing has to be
// typed, and the click both logs the call and moves the candidate — one
// request, because the second request is the one that fails.

import { useCallback, useEffect, useRef, useState } from "react";
import Shell from "@/components/Shell";
import { waMeLink, waWebLink, telLink, jobMessage, followUpMessage } from "@/lib/whatsapp";
import CandidateActions from "@/components/CandidateActions";
import LoadMore from "@/components/LoadMore";

const QUEUES = [
  { key: "due", label: "Callbacks due" },
  { key: "new", label: "Never called" },
  { key: "cold", label: "Going cold" },
  { key: "all", label: "Everyone" },
  { key: "history", label: "History" },
];

// Where "Ready for next" sends someone from where they are now. Mirrors
// ADVANCE_NEXT in app/api/candidates/[id]/calls/route.js, which is the one that
// decides; this copy only exists so the button can say where it is about to put
// them instead of making the recruiter guess.
const NEXT_STAGE = {
  new: "shortlisted",
  contacted: "shortlisted",
  shortlisted: "lined-up",
  "lined-up": "interviewed",
};

// The mechanical outcomes: the phone rang and nothing came of it. Written out
// as literal classes — a class name built from a variable is one Tailwind's
// scanner never sees, so it ships as an unstyled button.
const ROW_OUTCOMES = [
  { key: "no-answer", label: "No answer", done: "No answer" },
  { key: "busy", label: "Busy", done: "Busy" },
  // A number that reaches the wrong person is a number nobody should dial
  // again, so it leaves the working list with the rest of the history.
  { key: "wrong-number", label: "Wrong no.", archive: true, done: "Wrong number — in History" },
];

const STAGE_TONE = {
  new: "bg-slate-100 text-slate-700 border-slate-200",
  contacted: "bg-sky-50 text-sky-800 border-sky-200",
  shortlisted: "bg-chip-50 text-chip-800 border-chip-200",
  "lined-up": "bg-indigo-50 text-indigo-800 border-indigo-200",
  interviewed: "bg-violet-50 text-violet-800 border-violet-200",
  selected: "bg-emerald-50 text-emerald-800 border-emerald-200",
  joined: "bg-emerald-100 text-emerald-900 border-emerald-300",
  dropped: "bg-red-50 text-red-700 border-red-200",
};

const OUTCOMES = [
  { key: "connected", label: "Connected", tone: "bg-emerald-600 hover:bg-emerald-700 text-white" },
  { key: "no-answer", label: "No answer", tone: "bg-white border border-slate-300 hover:bg-slate-50" },
  { key: "busy", label: "Busy", tone: "bg-white border border-slate-300 hover:bg-slate-50" },
  { key: "callback", label: "Call back…", tone: "bg-white border border-slate-300 hover:bg-slate-50" },
  { key: "not-interested", label: "Not interested", tone: "bg-white border border-red-300 text-red-700 hover:bg-red-50" },
  { key: "wrong-number", label: "Wrong number", tone: "bg-white border border-slate-300 hover:bg-slate-50" },
];

// Where a hand-entered candidate came from. The same six the importer and the
// schema use — a seventh spelling here would quietly split every source report.
const SOURCES = ["referral", "walk-in", "naukri", "database", "linkedin", "whatsapp"];

// A blank Add row. Kept as a function rather than a shared object so clearing
// the row after a save cannot hand back the object the last save mutated.
function blankNew() {
  return {
    name: "", phone: "", designation: "", location: "",
    expMonths: "", currentCtc: "", expectedCtc: "", noticeDays: "",
    source: "", requirementId: "",
  };
}

const VERDICT = {
  blocked: { label: "Client will refuse", cls: "bg-red-100 text-red-800 border-red-300" },
  ask:     { label: "Questions to ask",   cls: "bg-sky-100 text-sky-800 border-sky-300" },
  check:   { label: "Worth raising",      cls: "bg-amber-100 text-amber-900 border-amber-300" },
  clear:   { label: "Clear",              cls: "bg-emerald-100 text-emerald-800 border-emerald-300" },
};

function months(m) {
  if (m == null) return "—";
  if (m === 0) return "fresher";
  if (m < 12) return `${m}mo`;
  const y = Math.floor(m / 12), r = m % 12;
  return r ? `${y}y ${r}m` : `${y}y`;
}
// Matches the short form used on Requirements, Placements and Reports. Without
// the lakh branch this screen showed "₹150k" for the figure every other screen
// rendered as "₹1.5L" — the same number, two scales, one desk.
function money(n) {
  if (n == null) return "—";
  const v = Math.round(n);
  if (Math.abs(v) >= 10000000) return `₹${trim(v / 10000000)}Cr`;
  if (Math.abs(v) >= 100000) return `₹${trim(v / 100000)}L`;
  if (Math.abs(v) >= 1000) return `₹${trim(v / 1000)}k`;
  return `₹${v}`;
}
function trim(x) {
  return (Math.round(x * 10) / 10).toString().replace(/\.0$/, "");
}
function ago(d) {
  if (!d) return "never";
  const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}
function pad2(n) {
  return String(n).padStart(2, "0");
}
// The default a callback picker opens on: tomorrow morning. Nine times in ten
// that is the answer, so the whole thing is two clicks — "Call back", "Set".
// <input type="datetime-local"> wants the user's own clock, not an ISO instant.
function tomorrowMorning() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  return localInput(d);
}
// An instant as <input type="datetime-local"> wants it: the user's own clock,
// no timezone suffix. Empty for anything unparseable, so a bad stored value
// shows an empty picker rather than the words "Invalid Date" inside the box.
function localInput(d) {
  if (!d) return "";
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return "";
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}T${pad2(x.getHours())}:${pad2(x.getMinutes())}`;
}
// The short Indian format every other date on this screen already uses.
function whenShort(d) {
  if (!d) return "";
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return "";
  return x.toLocaleString("en-IN", {
    day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true,
  });
}

/** One tri-state answer, captured in a single click while on the call. */
function TriState({ label, value, onChange, yesLabel = "Yes", noLabel = "No" }) {
  const btn = (v, text) => (
    <button
      type="button"
      onClick={() => onChange(value === v ? null : v)}
      className={
        "px-2.5 py-1 text-xs rounded border transition " +
        (value === v
          ? "bg-chip-700 text-white border-chip-700"
          : "bg-white border-slate-300 text-slate-600 hover:bg-slate-50")
      }
    >
      {text}
    </button>
  );
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-slate-600 min-w-[7.5rem]">{label}</span>
      {btn(true, yesLabel)}
      {btn(false, noLabel)}
    </div>
  );
}

export default function CandidatesPage() {
  const [queue, setQueue] = useState("due");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [total, setTotal] = useState(0);
  // What the SERVER says it served, not what is on screen. The two drift the
  // moment a duplicate is dropped, and an offset taken from the screen then
  // asks for a row it already has, forever.
  const [nextSkip, setNextSkip] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState(null);
  // Set by the import screen's "Start calling" link, so a telecaller lands on
  // exactly the batch they just imported instead of the whole database.
  const [requirementId, setRequirementId] = useState("");

  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState("");
  const [callbackAt, setCallbackAt] = useState("");
  const [logged, setLogged] = useState(0); // calls logged in this sitting
  const [history, setHistory] = useState([]); // remarks on the open candidate
  const [historyFor, setHistoryFor] = useState(null);
  // Forces a re-read of the open candidate's remarks without pretending a call
  // was made. See saveNote.
  const [historyTick, setHistoryTick] = useState(0);
  const [script, setScript] = useState(null);
  const [scriptBusy, setScriptBusy] = useState(false);
  // The row currently being written to. Per-row rather than one flag for the
  // page: disabling every button on the screen because one is saving makes a
  // fast list feel broken.
  const [busyId, setBusyId] = useState(null);
  const [cbRow, setCbRow] = useState(null);   // row whose callback picker is open
  const [cbAt, setCbAt] = useState("");

  // The openings a candidate can be called against. Fetched once for the page
  // and shared by the Add row and every row's opening picker — forty rows each
  // fetching the same list is forty requests for one answer.
  const [openings, setOpenings] = useState([]);

  // The after-the-call strip. One row at a time, one control at a time: three
  // inputs open on every row at once is a wall, and a telecaller who has just
  // put the phone down is looking for one thing.
  const [actRow, setActRow] = useState(null);   // { id, kind: "note"|"follow"|"opening" }
  const [noteText, setNoteText] = useState("");
  const [followAt, setFollowAt] = useState("");

  // The Add row.
  const [nf, setNf] = useState(blankNew());
  const [addMore, setAddMore] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addErr, setAddErr] = useState("");
  const [added, setAdded] = useState(null);     // { id, name, phone } just created
  const [dupe, setDupe] = useState(null);       // { id, name, phone, message, archived }
  const setF = (k, v) => setNf((f) => ({ ...f, [k]: v }));
  // Setting state is not immediate, so two quick clicks on the same button both
  // see busyId as null and log the call twice. A ref changes now. This matters
  // more than it looks: the call count IS the day's productivity figure.
  const writing = useRef(false);

  // The reminders screen links here as /candidates?open=<id>. Nothing read it,
  // so clicking "Open" on an overdue callback landed on the default queue with
  // the person nowhere in sight and no hint as to why. Read from
  // window.location in an effect rather than useSearchParams, because
  // useSearchParams forces the whole route into dynamic rendering and has
  // already broken this build once.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const req = sp.get("requirement");
    // Arriving from "Start calling" on an imported batch: the Add row defaults
    // to that same opening, because a referral picked up while working a batch
    // is almost always for that batch.
    if (req) {
      setRequirementId(req);
      setQueue("new");
      setNf((f) => ({ ...f, requirementId: req }));
    }
    const want = sp.get("open");
    if (!want) return;
    setOpenId(want);
    // "all" so the person is found even when they are not in today's due queue,
    // which is the usual case for a callback that slipped.
    setQueue("all");
  }, []);

  // Which filter the rows on screen belong to. A "load more" still in flight
  // when someone changes queue or types in the search box would otherwise
  // append the old list's next page onto the new list, and it would stay there.
  //
  // Declared HERE, below every useState, and not up with the other paging
  // state: it reads requirementId, which is declared further down, and a const
  // read above its own declaration is a ReferenceError when the component
  // renders rather than something the parser refuses. The build said "Cannot
  // access 'V' before initialization" against a minified name, which is what
  // that mistake looks like by the time it reaches you.
  const viewKey = `${queue}|${q}|${requirementId}`;
  const viewRef = useRef(viewKey);
  useEffect(() => { viewRef.current = viewKey; }, [viewKey]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const p = new URLSearchParams({ queue });
      if (requirementId) p.set("requirement", requirementId);
      // A search widens to everyone — except in History, where widening would
      // quietly drop the very people the search is for.
      if (q.trim()) {
        p.set("q", q.trim());
        if (queue !== "history") p.set("queue", "all");
      }
      const r = await fetch(`/api/candidates?${p}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load the list.");
      setRows(Array.isArray(j.candidates) ? j.candidates : []);
      setTotal(Number(j.totalCount) || 0);
      setNextSkip((j.page?.skip || 0) + (j.page?.returned || 0));
      setHasMore(!!j.page?.hasMore);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [queue, q, requirementId]);

  // The next page, appended rather than swapped in. Changing a filter calls
  // load() and starts again from the top; this only ever adds to what is
  // already on screen, so a callback somebody is part-way through typing into
  // does not vanish underneath them.
  //
  // skip is taken from what is actually on screen, not from a page number.
  // Page numbers and an insert between two requests disagree; a length does
  // not, beyond repeating one row at worst.
  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const mine = viewRef.current;
      const p = new URLSearchParams({ queue, skip: String(nextSkip) });
      if (requirementId) p.set("requirement", requirementId);
      if (q.trim()) {
        p.set("q", q.trim());
        if (queue !== "history") p.set("queue", "all");
      }
      const r = await fetch(`/api/candidates?${p}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load more.");
      if (viewRef.current !== mine) return; // the view moved on while this was in flight
      const more = Array.isArray(j.candidates) ? j.candidates : [];
      // Guard against a duplicate: a row added by someone else between the two
      // requests shifts the offset by one and would otherwise arrive twice,
      // and React would then warn about two children with the same key.
      setRows((rs) => {
        const seen = new Set(rs.map((x) => x.id));
        return [...rs, ...more.filter((x) => !seen.has(x.id))];
      });
      setTotal(Number(j.totalCount) || 0);
      setNextSkip((j.page?.skip || 0) + (j.page?.returned || 0));
      setHasMore(!!j.page?.hasMore);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingMore(false);
    }
  }, [queue, q, requirementId, nextSkip]);

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  // Every recruiter holds requirement.read, so this is the same list for
  // everyone on the desk. A failure is silent on purpose: the openings picker
  // is a convenience, and a red banner across the call list because a dropdown
  // could not be filled would stop the day for no reason.
  useEffect(() => {
    let alive = true;
    fetch("/api/requirements?status=open&take=500")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!alive || !j) return;
        setOpenings(Array.isArray(j.requirements) ? j.requirements : []);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  async function patch(id, body) {
    // Optimistic: the answer appears the instant it is clicked, because the
    // candidate is on the phone and a spinner mid-sentence is worse than a
    // rare correction afterwards.
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...body } : r)));
    try {
      const res = await fetch(`/api/candidates/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error || "That change did not save.");
        load();
      }
    } catch {
      setError("That change did not save — check your connection.");
      load();
    }
  }

  /**
   * One round trip: the call is logged and the candidate is moved, together.
   *
   * The row is NOT taken off the screen afterwards and the list is NOT
   * refetched. It is greyed where it sits with a line saying what just
   * happened, so a recruiter working down a queue never loses their place and
   * never watches a list jump under the cursor mid-sentence. Changing queue,
   * searching or pressing Refresh brings a clean list.
   */
  async function logCall(id, outcome, opts = {}) {
    if (writing.current) return null;
    writing.current = true;
    setBusyId(id);
    setError("");
    try {
      const r = await fetch(`/api/candidates/${id}/calls`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outcome,
          notes: opts.notes || undefined,
          followUpAt: opts.followUpAt || undefined,
          ...(opts.advance ? { advance: true } : {}),
          ...(typeof opts.archive === "boolean" ? { archive: opts.archive } : {}),
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not log the call.");
      setLogged((n) => n + 1);
      setRows((rs) =>
        rs.map((row) =>
          row.id === id
            ? {
                ...row,
                stage: j.stage || row.stage,
                archived: !!j.archived,
                callCount: (row.callCount || 0) + 1,
                lastContactedAt: new Date().toISOString(),
                // Only a connected call means anybody was actually reached.
                lastConnectedAt:
                  outcome === "connected" ? new Date().toISOString() : row.lastConnectedAt,
                // The server sets the candidate's callback to this call's time
                // and CLEARS it when there isn't one. Mirroring that here is
                // what stops the row claiming a callback is still pending
                // thirty seconds after it was made.
                nextFollowUpAt: opts.followUpAt || null,
                // So the note box knows there is now a call to write against,
                // without refetching the list and losing the reader's place.
                lastCall: {
                  calledAt: new Date().toISOString(),
                  outcome,
                  notes: opts.notes || null,
                  followUpAt: opts.followUpAt || null,
                },
                justDid: opts.done || `Logged — ${outcome}`,
              }
            : row
        )
      );
      return j;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      writing.current = false;
      setBusyId(null);
    }
  }

  /** The panel's outcome buttons — same write, with the typed note attached. */
  async function logFromPanel(id, outcome) {
    if (outcome === "callback" && !callbackAt) {
      setError("Pick when to call back — otherwise it is a note nobody sees again.");
      return;
    }
    setBusy(true);
    const j = await logCall(id, outcome, {
      notes: notes.trim(),
      followUpAt: outcome === "callback" ? new Date(callbackAt).toISOString() : undefined,
      archive: outcome === "wrong-number" ? true : undefined,
    });
    setBusy(false);
    if (j) {
      setNotes("");
      setCallbackAt("");
      setOpenId(null);
    }
  }

  /** "Ready for next" — connected, and move them along, in one click. */
  function readyForNext(c) {
    const to = NEXT_STAGE[c.stage];
    return logCall(c.id, "connected", {
      advance: true,
      done: to ? `Moved on — ${to}` : "Logged — connected",
    });
  }

  /** "Not now" — logged, dropped, and into History where they stay reachable. */
  function notNow(c) {
    return logCall(c.id, "not-interested", { done: "Not now — moved to History" });
  }

  /** Back into play from History. Reversible, so nothing is confirmed first. */
  async function bringBack(c) {
    if (writing.current) return;
    writing.current = true;
    setBusyId(c.id);
    setError("");
    try {
      const body = { archived: false, ...(c.stage === "dropped" ? { stage: "contacted" } : {}) };
      const res = await fetch(`/api/candidates/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Could not bring them back.");
      }
      setRows((rs) =>
        rs.map((row) =>
          row.id === c.id
            ? { ...row, archived: false, stage: body.stage || row.stage, justDid: "Back in play" }
            : row
        )
      );
    } catch (e) {
      setError(e.message);
    } finally {
      writing.current = false;
      setBusyId(null);
    }
  }

  /**
   * Add a candidate by hand, from the calling list.
   *
   * Everybody else arrives by bulk import. A referral or a walk-in does not,
   * and until this existed the only way to get one onto the list was to build
   * a spreadsheet for one person and import it.
   *
   * The phone number is the identity. If it is already here the server answers
   * 409 with who it is, and this offers to open them — never a second row for
   * the same human being, and never a silent overwrite of what the last
   * recruiter learned about them.
   */
  async function addCandidate() {
    if (addBusy) return;
    const name = nf.name.trim();
    const phone = nf.phone.replace(/[^\d]/g, "").slice(-10);
    if (!name) { setAddErr("Type the candidate's name."); setDupe(null); return; }
    if (phone.length !== 10) { setAddErr("Type the 10-digit mobile number."); setDupe(null); return; }

    setAddBusy(true);
    setAddErr("");
    setDupe(null);
    setAdded(null);
    try {
      const r = await fetch("/api/candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...nf, name, phone }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 409 && j.duplicate) {
        setDupe({
          id: j.candidateId || "",
          name: j.name || "",
          phone: j.phone || phone,
          message: j.error || "That number is already on the list.",
          archived: !!j.archived || j.stage === "dropped",
        });
        return;
      }
      if (!r.ok) throw new Error(j.error || "Could not save the candidate.");
      setNf(blankNew());
      setAddMore(false);
      setAdded({ id: j.candidate?.id || "", name: j.candidate?.name || name, phone });
      // Brings them onto the list when the current queue would show them
      // (Never called, Everyone). When it would not, the line above still
      // offers a button that goes straight to them.
      load();
    } catch (e) {
      setAddErr(e.message);
    } finally {
      setAddBusy(false);
    }
  }

  /**
   * Jump to one person by number, wherever they are — including History, which
   * a search of the working queues would never reach. The opening filter comes
   * off too: the whole point is to land on this person, and a filter left on is
   * how "open them" shows an empty list.
   */
  function openExisting(id, phone, archived) {
    setRequirementId("");
    setQueue(archived ? "history" : "all");
    setQ(phone || "");
    setOpenId(id || null);
    setDupe(null);
    setAdded(null);
    setActRow(null);
  }

  /**
   * The remark, written against the call that has just been made.
   *
   * Not a new call row: the call count is the desk's productivity figure, and
   * typing out what somebody said is not a second dial.
   */
  async function saveNote(c) {
    if (writing.current) return;
    writing.current = true;
    setBusyId(c.id);
    setError("");
    try {
      const res = await fetch(`/api/candidates/${c.id}/calls`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: noteText }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "That note did not save.");
      const saved = j.call?.notes ?? null;
      setRows((rs) =>
        rs.map((row) =>
          row.id === c.id
            ? {
                ...row,
                lastCall: row.lastCall ? { ...row.lastCall, notes: saved } : row.lastCall,
                justDid: saved ? "Note saved" : "Note cleared",
              }
            : row
        )
      );
      // The open panel reads the full history from the server, so it has to be
      // asked again to show the edited remark. Deliberately NOT by bumping
      // `logged`: that number is "calls logged in this sitting", and counting a
      // typed remark as a call is exactly the padding this screen exists to
      // make unnecessary.
      if (openId === c.id) setHistoryTick((n) => n + 1);
      setActRow(null);
      setNoteText("");
    } catch (e) {
      setError(e.message);
    } finally {
      writing.current = false;
      setBusyId(null);
    }
  }

  /** Set or clear the one outstanding callback, without logging a dial. */
  function setFollowUp(c, iso) {
    patch(c.id, { nextFollowUpAt: iso });
    setRows((rs) =>
      rs.map((row) =>
        row.id === c.id
          ? { ...row, justDid: iso ? `Follow-up set for ${whenShort(iso)}` : "Follow-up cleared" }
          : row
      )
    );
    setActRow(null);
    setFollowAt("");
  }

  /**
   * Change which opening this person is being called for.
   *
   * Screening is worked out on the server against the requirement's criteria,
   * so the old verdict is dropped rather than left on screen claiming to
   * describe the new opening. It comes back on the next refresh.
   */
  function setOpening(c, id) {
    const chosen = Array.isArray(openings) ? openings.find((o) => o.id === id) : null;
    patch(c.id, { requirementId: id || null });
    setRows((rs) =>
      rs.map((row) =>
        row.id === c.id
          ? {
              ...row,
              requirementId: id || null,
              requirement: chosen
                ? {
                    id: chosen.id,
                    designation: chosen.designation,
                    location: chosen.location,
                    clientName: chosen.clientName,
                    takeHomeMin: chosen.takeHomeMin,
                    takeHomeMax: chosen.takeHomeMax,
                    relievingRequired: chosen.relievingRequired,
                    arrearsAllowed: chosen.arrearsAllowed,
                    educationMin: chosen.educationMin,
                    expMinMonths: chosen.expMinMonths,
                    expMaxMonths: chosen.expMaxMonths,
                  }
                : null,
              screening: null,
              justDid: chosen
                ? `Now calling for ${chosen.designation} — refresh to re-check the client's criteria`
                : "Opening cleared",
            }
          : row
      )
    );
    setActRow(null);
  }

  // Every remark ever left on the open candidate. Loaded on expand rather than
  // with the list: forty candidates' call histories is a lot of rows to fetch
  // for the one a recruiter is actually looking at.
  useEffect(() => {
    setScript(null);
    if (!openId) { setHistory([]); setHistoryFor(null); return; }
    let alive = true;
    fetch(`/api/candidates/${openId}/calls`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!alive || !j) return;
        setHistory(Array.isArray(j.calls) ? j.calls : []);
        setHistoryFor(openId);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [openId, logged, historyTick]);


  async function loadScript(id, withAi) {
    if (scriptBusy) return;
    setScriptBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/candidates/${id}/script${withAi ? "?ai=1" : ""}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not build a script.");
      setScript(j);
    } catch (e) {
      setError(e.message);
    } finally {
      setScriptBusy(false);
    }
  }

  // Read in three places, and never trusted to be an array: a failed fetch or a
  // changed response shape must leave the pickers empty, not break the list
  // somebody is working.
  const openList = Array.isArray(openings) ? openings : [];

  return (
    <Shell
      title="Calls"
      subtitle="Who to ring, what the client will refuse, and what is still unanswered."
    >
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {QUEUES.map((qq) => (
          <button
            key={qq.key}
            onClick={() => { setQueue(qq.key); setQ(""); setOpenId(null); setCbRow(null); setActRow(null); }}
            className={
              "rounded-full px-3 py-1 text-sm transition " +
              (queue === qq.key && !q
                ? "bg-chip-700 text-white"
                : "bg-white border border-slate-300 text-slate-600 hover:bg-slate-50")
            }
          >
            {qq.label}
          </button>
        ))}
        <input
          id="cand-search"
          className="input max-w-xs ml-auto"
          placeholder="Search name, phone, skill…"
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpenId(null); setActRow(null); }}
        />
      </div>

      {/* Add a candidate without leaving the calling list. A strip, not a
          dialog: a referral comes up in the middle of another call and the
          number has to go down somewhere in the next ten seconds. */}
      <div className="card p-3 mb-4">
        <div className="flex flex-wrap items-end gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 pb-2">
            Add a candidate
          </span>
          <input
            className="input flex-1 min-w-[10rem]"
            placeholder="Name"
            aria-label="New candidate's name"
            value={nf.name}
            onChange={(e) => setF("name", e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addCandidate(); }}
          />
          <input
            className="input tabular-nums w-36 min-w-[9rem]"
            placeholder="Mobile"
            inputMode="numeric"
            aria-label="New candidate's mobile number"
            value={nf.phone}
            onChange={(e) => setF("phone", e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addCandidate(); }}
          />
          <input
            className="input flex-1 min-w-[10rem]"
            placeholder="Doing what now"
            aria-label="New candidate's designation"
            value={nf.designation}
            onChange={(e) => setF("designation", e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addCandidate(); }}
          />
          <button
            className="btn bg-chip-600 text-white hover:bg-chip-700 px-4 py-2"
            disabled={addBusy}
            onClick={addCandidate}
          >
            {addBusy ? "Adding…" : "Add"}
          </button>
          <button
            type="button"
            className="btn bg-white border border-slate-300 hover:bg-slate-50 px-2.5 py-2 text-xs"
            onClick={() => setAddMore((v) => !v)}
          >
            {addMore ? "Fewer details" : "More details"}
          </button>
        </div>

        {addMore && (
          <div className="grid sm:grid-cols-3 lg:grid-cols-4 gap-2 mt-3">
            <div>
              <label htmlFor="new-loc" className="label">Where they are</label>
              <input id="new-loc" className="input" placeholder="Chennai"
                value={nf.location} onChange={(e) => setF("location", e.target.value)} />
            </div>
            <div>
              <label htmlFor="new-exp" className="label">Experience (months)</label>
              <input id="new-exp" className="input" inputMode="numeric" placeholder="0 for fresher"
                value={nf.expMonths} onChange={(e) => setF("expMonths", e.target.value)} />
            </div>
            <div>
              <label htmlFor="new-cur" className="label">Current take-home</label>
              <input id="new-cur" className="input" placeholder="18k"
                value={nf.currentCtc} onChange={(e) => setF("currentCtc", e.target.value)} />
            </div>
            <div>
              <label htmlFor="new-exp2" className="label">Expecting</label>
              <input id="new-exp2" className="input" placeholder="22k"
                value={nf.expectedCtc} onChange={(e) => setF("expectedCtc", e.target.value)} />
            </div>
            <div>
              <label htmlFor="new-not" className="label">Notice (days)</label>
              <input id="new-not" className="input" inputMode="numeric" placeholder="0 if immediate"
                value={nf.noticeDays} onChange={(e) => setF("noticeDays", e.target.value)} />
            </div>
            <div>
              <label htmlFor="new-src" className="label">Where from</label>
              <select id="new-src" className="input" value={nf.source}
                onChange={(e) => setF("source", e.target.value)}>
                <option value="">Not said</option>
                {SOURCES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="new-req" className="label">Calling them for</label>
              <select id="new-req" className="input" value={nf.requirementId}
                onChange={(e) => setF("requirementId", e.target.value)}>
                <option value="">No opening yet</option>
                {openList.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.designation} — {o.clientName} · {o.location}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {addErr && (
          <div role="alert" className="mt-2 text-sm text-red-800 bg-red-50 border border-red-200 rounded px-3 py-2">
            {addErr}
          </div>
        )}

        {/* The number is already here. Never a second row for the same person,
            and never an overwrite of what the last recruiter learned — just a
            way through to them. */}
        {dupe && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-amber-900 bg-amber-50 border border-amber-300 rounded px-3 py-2">
            <span>{dupe.message} Nothing was changed.</span>
            {dupe.id && (
              <button
                className="btn bg-chip-600 text-white hover:bg-chip-700 px-3 py-1.5 text-xs"
                onClick={() => openExisting(dupe.id, dupe.phone, dupe.archived)}
              >
                Open {dupe.name || "them"}
              </button>
            )}
            <button
              className="btn bg-white border border-slate-300 hover:bg-slate-50 px-2.5 py-1.5 text-xs"
              onClick={() => setDupe(null)}
            >
              Dismiss
            </button>
          </div>
        )}

        {added && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded px-3 py-2">
            <span><b>{added.name}</b> is on the list, waiting to be called.</span>
            {added.id && (
              <button
                className="btn bg-white border border-slate-300 hover:bg-slate-50 px-2.5 py-1.5 text-xs"
                onClick={() => openExisting(added.id, added.phone, false)}
              >
                Open them
              </button>
            )}
            <button
              className="btn bg-white border border-slate-300 hover:bg-slate-50 px-2.5 py-1.5 text-xs"
              onClick={() => setAdded(null)}
            >
              Dismiss
            </button>
          </div>
        )}
      </div>

      {requirementId && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-chip-800 bg-chip-50 border border-chip-200 rounded px-3 py-2 mb-4">
          <span>
            Showing only the people against{" "}
            <b>{rows.find((r) => r.requirement)?.requirement?.designation || "one opening"}</b>.
          </span>
          <button className="btn-ghost text-xs py-1" onClick={() => { setRequirementId(""); setOpenId(null); }}>
            Show everyone
          </button>
        </div>
      )}

      {logged > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded px-3 py-2 mb-4">
          <span>
            <b className="tabular-nums">{logged}</b> call{logged === 1 ? "" : "s"} logged in this sitting —
            counted automatically, nothing to tally at the end of the day.
          </span>
          <button className="btn-ghost text-xs py-1 ml-auto" onClick={() => { setOpenId(null); setCbRow(null); setActRow(null); load(); }}>
            Refresh the list
          </button>
        </div>
      )}

      {error && (
        <div role="alert" className="card border-red-200 bg-red-50 p-3 text-sm text-red-800 mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <div className="card p-10 text-center text-slate-400">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="card p-10 text-center">
          <div className="text-chip-900 font-medium">
            {queue === "due" ? "No callbacks due." :
             queue === "new" ? "Nobody waiting to be called." :
             queue === "cold" ? "Nobody has gone cold. Good." :
             queue === "history" ? "Nobody has been set aside yet." :
             "No candidates yet."}
          </div>
          <p className="text-sm text-slate-500 mt-1">
            {queue === "all"
              ? "Candidates get added from the call list as the desk works."
              : queue === "history"
              ? "People you mark Not now, or whose number is wrong, wait here — with every call still on the record."
              : "Try another queue."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((c) => {
            const isOpen = c.id === openId;
            const v = c.screening ? VERDICT[c.screening.verdict] : null;
            const inHistory = queue === "history";
            const rowBusy = busyId === c.id;
            const nextStage = NEXT_STAGE[c.stage];
            // Which after-the-call control this row currently has open, if any.
            const act = actRow && actRow.id === c.id ? actRow : null;
            const lastNote = c.lastCall && c.lastCall.notes ? c.lastCall.notes : "";
            // Openings this person applied to that are NOT the one they are
            // currently being worked for. Before Application rows existed a
            // second application wrote nothing at all, so this line is the
            // only place the second one has ever been visible.
            const applied = Array.isArray(c.applications) ? c.applications : [];
            const otherApplications = applied.filter(
              (a) => a.requirementId && a.requirementId !== c.requirementId
            );
            return (
              <div
                key={c.id}
                className={
                  "card " +
                  (isOpen ? "ring-2 ring-chip-500/40 " : "") +
                  (c.justDid ? "bg-slate-50/80 " : "")
                }
              >
                {/* Row. The details are one big target that opens the panel;
                    the outcome buttons sit beside it, because a recruiter on
                    the phone should never have to open anything at all. */}
                <div className="flex flex-wrap items-start">
                  <button
                    onClick={() => { setOpenId(isOpen ? null : c.id); setNotes(""); setCallbackAt(""); }}
                    className="flex-1 min-w-[18rem] text-left p-4 flex flex-wrap items-start gap-x-4 gap-y-1 hover:bg-slate-50/70 transition rounded-l-lg"
                  >
                    <div className="min-w-[11rem] flex-1">
                      <div className="font-medium text-chip-900">{c.name}</div>
                      <div className="text-xs text-slate-500">
                        {[c.designation, c.location].filter(Boolean).join(" · ") || "No details yet"}
                      </div>
                    </div>
                    <div className="text-sm tabular-nums text-slate-700 min-w-[7rem]">{c.phone}</div>
                    <div className="text-xs text-slate-500 min-w-[9rem]">
                      {months(c.expMonths)} · {money(c.expectedCtc)} wanted
                      {c.noticeDays != null && ` · ${c.noticeDays}d notice`}
                    </div>
                    {/* How often this person has been called, and — separately
                        — when anybody last actually got through. Three
                        no-answers move "dialled" every time and mean nobody has
                        spoken to them at all, which is the difference between
                        opening with "following up on our chat" and introducing
                        yourself from scratch. */}
                    <div className="text-xs text-slate-500 min-w-[9rem]">
                      <div>
                        <b className="tabular-nums text-slate-700">{c.callCount}</b>
                        {" "}call{c.callCount === 1 ? "" : "s"} · dialled {ago(c.lastContactedAt)}
                      </div>
                      <div className={c.lastConnectedAt ? "text-emerald-700" : "text-amber-700"}>
                        {c.lastConnectedAt ? `reached ${ago(c.lastConnectedAt)}` : "never reached"}
                      </div>
                    </div>
                    <span
                      className={
                        "text-[11px] px-2 py-0.5 rounded border self-center " +
                        (STAGE_TONE[c.stage] || STAGE_TONE.new)
                      }
                    >
                      {c.stage}
                    </span>
                    {v && (
                      <span className={"text-[11px] px-2 py-0.5 rounded border self-center " + v.cls}>
                        {v.label}
                      </span>
                    )}
                  </button>

                  {/* One click, one outcome. No dialog, no confirmation: every
                      one of these is undone by bringing the person back. */}
                  <div className="p-3 flex flex-wrap items-center gap-1.5 justify-end">
                    <a
                      href={telLink(c.phone)}
                      className="btn bg-chip-600 text-white hover:bg-chip-700 px-3 py-2"
                    >
                      📞 Call
                    </a>

                    {inHistory ? (
                      <>
                        <span className="text-xs text-slate-500 px-1">
                          {c.archived ? "Set aside" : "Said no"}
                        </span>
                        <button
                          disabled={rowBusy}
                          onClick={() => bringBack(c)}
                          className="btn bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-2"
                        >
                          {rowBusy ? "…" : "Bring back"}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          disabled={rowBusy || !nextStage}
                          onClick={() => readyForNext(c)}
                          title={
                            nextStage
                              ? `Logs a connected call and moves them to ${nextStage}.`
                              : "Nothing further from here — book an interview or record the placement."
                          }
                          className="btn bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-2"
                        >
                          {rowBusy ? "…" : nextStage ? `Ready → ${nextStage}` : "Ready for next"}
                        </button>
                        <button
                          disabled={rowBusy}
                          onClick={() => notNow(c)}
                          className="btn bg-white border border-red-300 text-red-700 hover:bg-red-50 px-3 py-2"
                        >
                          Not now
                        </button>

                        {ROW_OUTCOMES.map((o) => (
                          <button
                            key={o.key}
                            disabled={rowBusy}
                            onClick={() =>
                              logCall(c.id, o.key, {
                                done: o.done,
                                archive: o.archive === true ? true : undefined,
                              })
                            }
                            className="btn bg-white border border-slate-300 hover:bg-slate-50 px-2.5 py-2 text-xs"
                          >
                            {o.label}
                          </button>
                        ))}

                        {cbRow === c.id ? (
                          <span className="flex items-center gap-1.5">
                            <input
                              type="datetime-local"
                              className="input w-auto py-1.5"
                              value={cbAt}
                              onChange={(e) => setCbAt(e.target.value)}
                              aria-label={`Call ${c.name} back at`}
                            />
                            <button
                              disabled={rowBusy || !cbAt}
                              className="btn bg-chip-600 text-white hover:bg-chip-700 px-3 py-2 text-xs"
                              onClick={async () => {
                                const j = await logCall(c.id, "callback", {
                                  followUpAt: new Date(cbAt).toISOString(),
                                  done: `Calling back ${new Date(cbAt).toLocaleString("en-IN", {
                                    day: "numeric", month: "short", hour: "numeric",
                                    minute: "2-digit", hour12: true,
                                  })}`,
                                });
                                if (j) { setCbRow(null); setCbAt(""); }
                              }}
                            >
                              Set
                            </button>
                            <button
                              className="btn bg-white border border-slate-300 hover:bg-slate-50 px-2 py-2 text-xs"
                              onClick={() => { setCbRow(null); setCbAt(""); }}
                            >
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            disabled={rowBusy}
                            onClick={() => { setCbRow(c.id); setCbAt(tomorrowMorning()); }}
                            className="btn bg-white border border-slate-300 hover:bg-slate-50 px-2.5 py-2 text-xs"
                          >
                            Call back…
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {/* What just happened, where it happened. The row stays put so
                    nobody loses their place halfway down a queue. */}
                {c.justDid && (
                  <div className="px-4 pb-3 -mt-1 text-xs text-emerald-800">
                    ✓ {c.justDid}
                  </div>
                )}

                {/* The step AFTER a good call, on the row itself.
                    The left half is the standing facts — what they are being
                    called for, whether a callback is promised, the last thing
                    they said. The right half changes those three things in
                    place. Nothing here opens a dialog and nothing navigates
                    away, because all of it happens in the few seconds after the
                    phone goes down and before the next number is dialled. */}
                {!inHistory && (
                  <div className="border-t border-slate-100 px-4 py-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
                    <span className="text-slate-500">
                      {c.requirement ? (
                        <>
                          For <b className="text-chip-800">{c.requirement.designation}</b>
                          {c.requirement.clientName ? ` · ${c.requirement.clientName}` : ""}
                        </>
                      ) : (
                        <span className="text-amber-700">No opening yet</span>
                      )}
                    </span>
                    {otherApplications.length > 0 && (
                      <span
                        className="text-violet-700 truncate max-w-[22rem]"
                        title={otherApplications
                          .map((a) => a.designation || "an opening")
                          .join(", ")}
                      >
                        Also applied:{" "}
                        {otherApplications
                          .slice(0, 3)
                          .map((a) => a.designation || "an opening")
                          .join(", ")}
                        {otherApplications.length > 3
                          ? ` +${otherApplications.length - 3} more`
                          : ""}
                      </span>
                    )}
                    <span className={c.nextFollowUpAt ? "text-sky-700" : "text-slate-400"}>
                      {c.nextFollowUpAt
                        ? `Call back ${whenShort(c.nextFollowUpAt)}`
                        : "No callback set"}
                    </span>
                    {lastNote && (
                      <span className="text-slate-500 truncate max-w-[20rem]" title={lastNote}>
                        &ldquo;{lastNote}&rdquo;
                      </span>
                    )}

                    {act && act.kind === "note" ? (
                      <span className="flex flex-wrap items-center gap-1.5 ml-auto">
                        <input
                          className="input w-auto min-w-[16rem] py-1.5 text-xs"
                          placeholder="What they said — you read this before the next call."
                          aria-label={`Note on the last call with ${c.name}`}
                          value={noteText}
                          onChange={(e) => setNoteText(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") saveNote(c); }}
                        />
                        <button
                          disabled={rowBusy}
                          className="btn bg-chip-600 text-white hover:bg-chip-700 px-3 py-1.5 text-xs"
                          onClick={() => saveNote(c)}
                        >
                          {rowBusy ? "…" : "Save note"}
                        </button>
                        <button
                          className="btn bg-white border border-slate-300 hover:bg-slate-50 px-2 py-1.5 text-xs"
                          onClick={() => { setActRow(null); setNoteText(""); }}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : act && act.kind === "follow" ? (
                      <span className="flex flex-wrap items-center gap-1.5 ml-auto">
                        <input
                          type="datetime-local"
                          className="input w-auto py-1.5 text-xs"
                          aria-label={`Follow up with ${c.name} on`}
                          value={followAt}
                          onChange={(e) => setFollowAt(e.target.value)}
                        />
                        <button
                          disabled={rowBusy || !followAt}
                          className="btn bg-chip-600 text-white hover:bg-chip-700 px-3 py-1.5 text-xs"
                          onClick={() => setFollowUp(c, new Date(followAt).toISOString())}
                        >
                          Set
                        </button>
                        {c.nextFollowUpAt && (
                          <button
                            disabled={rowBusy}
                            className="btn bg-white border border-slate-300 hover:bg-slate-50 px-2.5 py-1.5 text-xs"
                            onClick={() => setFollowUp(c, null)}
                          >
                            Clear it
                          </button>
                        )}
                        <button
                          className="btn bg-white border border-slate-300 hover:bg-slate-50 px-2 py-1.5 text-xs"
                          onClick={() => { setActRow(null); setFollowAt(""); }}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : act && act.kind === "opening" ? (
                      <span className="flex flex-wrap items-center gap-1.5 ml-auto">
                        <select
                          className="input w-auto max-w-[22rem] py-1.5 text-xs"
                          aria-label={`Which opening ${c.name} is being called for`}
                          value={c.requirementId || ""}
                          onChange={(e) => setOpening(c, e.target.value)}
                        >
                          <option value="">No opening</option>
                          {openList.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.designation} — {o.clientName} · {o.location}
                            </option>
                          ))}
                          {/* An opening that has since been closed is still the
                              one this person is against. Leaving it out would
                              make the picker show somebody else's opening as if
                              it were theirs. */}
                          {c.requirement && !openList.some((o) => o.id === c.requirement.id) && (
                            <option value={c.requirement.id}>
                              {c.requirement.designation} — {c.requirement.clientName} (closed)
                            </option>
                          )}
                        </select>
                        <button
                          className="btn bg-white border border-slate-300 hover:bg-slate-50 px-2 py-1.5 text-xs"
                          onClick={() => setActRow(null)}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <span className="flex flex-wrap items-center gap-1.5 ml-auto">
                        <button
                          disabled={rowBusy || !c.lastCall}
                          title={
                            c.lastCall
                              ? "Write a remark against the call just made."
                              : "Log a call first — remarks are kept against the call."
                          }
                          className="btn bg-white border border-slate-300 hover:bg-slate-50 px-2.5 py-1.5 text-xs"
                          onClick={() => {
                            setActRow({ id: c.id, kind: "note" });
                            setNoteText(lastNote);
                          }}
                        >
                          {lastNote ? "Edit note" : "Add note"}
                        </button>
                        <button
                          disabled={rowBusy}
                          className="btn bg-white border border-slate-300 hover:bg-slate-50 px-2.5 py-1.5 text-xs"
                          onClick={() => {
                            setActRow({ id: c.id, kind: "follow" });
                            setFollowAt(localInput(c.nextFollowUpAt) || tomorrowMorning());
                          }}
                        >
                          {c.nextFollowUpAt ? "Change follow-up" : "Set follow-up"}
                        </button>
                        <button
                          disabled={rowBusy}
                          className="btn bg-white border border-slate-300 hover:bg-slate-50 px-2.5 py-1.5 text-xs"
                          onClick={() => setActRow({ id: c.id, kind: "opening" })}
                        >
                          {c.requirement ? "Change opening" : "Pick opening"}
                        </button>
                      </span>
                    )}
                  </div>
                )}

                {/* Call panel */}
                {isOpen && (
                  <div className="border-t border-slate-200 p-4 space-y-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <a href={telLink(c.phone)} className="btn-primary">📞 Call {c.phone}</a>
                      {(() => {
                        // The message is built here so both links carry it and
                        // nothing has to be retyped. A candidate with no role
                        // attached gets the short nudge instead of a job pitch
                        // full of blanks.
                        const msg = c.requirement
                          ? jobMessage({ candidate: c, requirement: c.requirement })
                          : followUpMessage({ candidate: c });
                        const web = waWebLink(c.phone, msg);
                        const app = waMeLink(c.phone, msg);
                        if (!web && !app) {
                          return <span className="text-xs text-amber-700">Number too short for WhatsApp</span>;
                        }
                        return (
                          <>
                            {/* Two links, not one. wa.me redirects and asks
                                first; web.whatsapp.com opens straight into an
                                already-signed-in desktop session, which over a
                                hundred messages a day is the whole difference. */}
                            <a href={web} target="_blank" rel="noopener noreferrer" className="btn-ghost">
                              WhatsApp Web
                            </a>
                            <a href={app} target="_blank" rel="noopener noreferrer" className="btn-ghost">
                              WhatsApp app
                            </a>
                          </>
                        );
                      })()}
                      {c.requirement ? (
                        <span className="text-sm text-slate-600">
                          For <b className="text-chip-800">{c.requirement.designation}</b> at{" "}
                          {c.requirement.clientName} · {c.requirement.location}
                          {c.requirement.takeHomeMax != null &&
                            ` · up to ${money(c.requirement.takeHomeMax)}`}
                        </span>
                      ) : (
                        <span className="text-sm text-amber-700">
                          Not matched to an opening yet — screening can&rsquo;t run without one.
                        </span>
                      )}
                    </div>

                    {/* Screening */}
                    {c.screening && (
                      <div className="grid md:grid-cols-3 gap-3">
                        {c.screening.blockers.length > 0 && (
                          <div className="rounded border border-red-300 bg-red-50 p-3">
                            <div className="text-xs font-semibold uppercase tracking-wide text-red-800 mb-1">
                              Will be refused
                            </div>
                            <ul className="space-y-1">
                              {c.screening.blockers.map((b, i) => (
                                <li key={i} className="text-sm text-red-900">
                                  <b>{b.label}</b>
                                  <div className="text-[12px] text-red-800/80">{b.detail}</div>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {c.screening.unknowns.length > 0 && (
                          <div className="rounded border border-sky-300 bg-sky-50 p-3">
                            <div className="text-xs font-semibold uppercase tracking-wide text-sky-800 mb-1">
                              Ask on this call
                            </div>
                            <ul className="space-y-1">
                              {c.screening.unknowns.map((u, i) => (
                                <li key={i} className="text-sm text-sky-900">
                                  <b>{u.label}</b>
                                  {u.detail && u.detail !== "Not asked yet" && (
                                    <div className="text-[12px] text-sky-800/80">{u.detail}</div>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {c.screening.warnings.length > 0 && (
                          <div className="rounded border border-amber-300 bg-amber-50 p-3">
                            <div className="text-xs font-semibold uppercase tracking-wide text-amber-900 mb-1">
                              Raise it
                            </div>
                            <ul className="space-y-1">
                              {c.screening.warnings.map((w, i) => (
                                <li key={i} className="text-sm text-amber-950">
                                  <b>{w.label}</b>
                                  <div className="text-[12px] text-amber-900/80">{w.detail}</div>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}

                    {/* What to say. Built from the role and this candidate;
                        works with no AI configured, and says so. */}
                    <div className="rounded border border-chip-200 bg-chip-50/40 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <button className="btn-ghost text-sm" disabled={scriptBusy}
                          onClick={() => loadScript(c.id, false)}>
                          {scriptBusy && !script ? "Building…" : "What do I say?"}
                        </button>
                        {script?.aiAvailable && (
                          <button className="btn-ghost text-sm" disabled={scriptBusy}
                            onClick={() => loadScript(c.id, true)}>
                            {scriptBusy ? "Asking AI…" : "Rewrite with AI"}
                          </button>
                        )}
                        {script?.aiError && (
                          <span className="text-xs text-amber-700">
                            AI unavailable ({script.aiError}) — this is the built-in script.
                          </span>
                        )}
                      </div>

                      {script?.script && (
                        <div className="mt-3 grid md:grid-cols-2 gap-4">
                          <div className="space-y-3">
                            <div>
                              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Open with</div>
                              {script.script.opener.map((l, i) => (
                                <p key={i} className="text-sm text-chip-900 mt-1">{l}</p>
                              ))}
                            </div>
                            <div>
                              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Then say</div>
                              <ul className="mt-1 space-y-1">
                                {script.script.pitch.map((l, i) => (
                                  <li key={i} className="text-sm text-slate-700">• {l}</li>
                                ))}
                              </ul>
                            </div>
                            <div>
                              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                                Ask, in this order ({script.script.checklist.remaining} left)
                              </div>
                              <ul className="mt-1 space-y-1">
                                {script.script.checklist.items.map((it) => (
                                  <li key={it.key} className={"text-sm " + (it.done ? "text-slate-400 line-through" : it.critical ? "text-red-800 font-medium" : "text-slate-700")}>
                                    {it.done ? "✓" : "○"} {it.ask}
                                    {!it.done && <span className="block text-[11px] text-slate-500 ml-4">{it.why}</span>}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          </div>

                          <div className="space-y-3">
                            <div>
                              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                                Where this job leads
                              </div>
                              <ol className="mt-1 space-y-1">
                                {script.script.career.steps.map((st, i) => (
                                  <li key={i} className="text-sm text-slate-700">
                                    <b className="text-chip-900">{st.title}</b>
                                    <span className="text-slate-500"> — {st.when}</span>
                                    <span className="block text-[11px] text-slate-500">{st.note}</span>
                                  </li>
                                ))}
                              </ol>
                              {script.script.career.note && (
                                <p className="text-[11px] text-slate-500 mt-1">{script.script.career.note}</p>
                              )}
                            </div>
                            <div>
                              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">If they say…</div>
                              <ul className="mt-1 space-y-2">
                                {script.script.objections.slice(0, 4).map((o, i) => (
                                  <li key={i} className="text-sm">
                                    <span className="text-slate-500">&ldquo;{o.says}&rdquo;</span>
                                    <span className="block text-slate-700">{o.answer}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          </div>

                          {script.script.ai && (
                            <div className="md:col-span-2 rounded border border-slate-200 bg-white p-3">
                              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">
                                AI version
                              </div>
                              <pre className="whitespace-pre-wrap text-sm text-slate-700 font-sans">{script.script.ai}</pre>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Answers captured mid-call */}
                    <div className="rounded border border-slate-200 bg-slate-50 p-3 space-y-2">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Record answers as they come
                      </div>
                      <div className="flex flex-wrap gap-x-6 gap-y-2">
                        <TriState
                          label="Relieving letter"
                          value={c.hasRelieving}
                          onChange={(v) => patch(c.id, { hasRelieving: v })}
                          yesLabel="Has it" noLabel="Doesn't"
                        />
                        <TriState
                          label="Arrears"
                          value={c.hasArrears}
                          onChange={(v) => patch(c.id, { hasArrears: v })}
                          yesLabel="Has some" noLabel="None"
                        />
                      </div>
                      <div className="grid sm:grid-cols-4 gap-2">
                        <div>
                          <label htmlFor={`exp-${c.id}`} className="label">Experience (months)</label>
                          <input id={`exp-${c.id}`} className="input" defaultValue={c.expMonths ?? ""}
                            onBlur={(e) => e.target.value !== String(c.expMonths ?? "") && patch(c.id, { expMonths: e.target.value })} />
                        </div>
                        <div>
                          <label htmlFor={`cur-${c.id}`} className="label">Current take-home</label>
                          <input id={`cur-${c.id}`} className="input" placeholder="18k" defaultValue={c.currentCtc ?? ""}
                            onBlur={(e) => e.target.value !== String(c.currentCtc ?? "") && patch(c.id, { currentCtc: e.target.value })} />
                        </div>
                        <div>
                          <label htmlFor={`exp2-${c.id}`} className="label">Expecting</label>
                          <input id={`exp2-${c.id}`} className="input" placeholder="22k" defaultValue={c.expectedCtc ?? ""}
                            onBlur={(e) => e.target.value !== String(c.expectedCtc ?? "") && patch(c.id, { expectedCtc: e.target.value })} />
                        </div>
                        <div>
                          <label htmlFor={`not-${c.id}`} className="label">Notice (days)</label>
                          <input id={`not-${c.id}`} className="input" defaultValue={c.noticeDays ?? ""}
                            onBlur={(e) => e.target.value !== String(c.noticeDays ?? "") && patch(c.id, { noticeDays: e.target.value })} />
                        </div>
                      </div>
                      <div>
                        <label htmlFor={`edu-${c.id}`} className="label">Qualification</label>
                        <input id={`edu-${c.id}`} className="input" defaultValue={c.education ?? ""}
                          onBlur={(e) => e.target.value !== (c.education ?? "") && patch(c.id, { education: e.target.value })} />
                      </div>
                    </div>

                    {/* Outcome */}
                    <div>
                      <label htmlFor={`notes-${c.id}`} className="label">How did it go?</label>
                      <textarea
                        id={`notes-${c.id}`}
                        className="input h-16"
                        placeholder="What they said — this is what you'll read before the next call."
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                      />
                      <div className="flex flex-wrap items-center gap-2 mt-2">
                        {/* The same one-click move as on the row, but carrying
                            whatever was typed above — the note and the stage
                            move go in together or not at all. */}
                        {nextStage && (
                          <button
                            disabled={busy || rowBusy}
                            onClick={async () => {
                              setBusy(true);
                              const j = await logCall(c.id, "connected", {
                                advance: true,
                                notes: notes.trim(),
                                done: `Moved on — ${nextStage}`,
                              });
                              setBusy(false);
                              if (j) { setNotes(""); setCallbackAt(""); setOpenId(null); }
                            }}
                            className="btn bg-emerald-600 hover:bg-emerald-700 text-white"
                          >
                            Ready → {nextStage}
                          </button>
                        )}
                        {OUTCOMES.map((o) => (
                          <button
                            key={o.key}
                            disabled={busy || rowBusy}
                            onClick={() => logFromPanel(c.id, o.key)}
                            className={"btn " + o.tone}
                          >
                            {o.label}
                          </button>
                        ))}
                        <input
                          id={`cb-${c.id}`}
                          type="datetime-local"
                          className="input w-auto"
                          value={callbackAt}
                          onChange={(e) => setCallbackAt(e.target.value)}
                          aria-label="Call back at"
                        />
                      </div>
                    </div>

                    {/* What happens AFTER the call. Until this existed, a
                        recruiter could log a call and nothing else — the
                        interviews, submissions and placements screens had no way
                        of ever being filled. */}
                    <CandidateActions
                      candidate={c}
                      onDone={() => { setLogged((n) => n + 1); load(); }}
                    />

                    {/* Every remark, oldest at the bottom. This is what a
                        recruiter reads before dialling, and what makes a
                        handover to a colleague possible at all. */}
                    {historyFor === c.id && history.length > 0 && (
                      <div className="rounded border border-slate-200 bg-white">
                        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 px-3 pt-3">
                          Call history
                        </div>
                        <ul className="divide-y divide-slate-100 max-h-56 overflow-y-auto">
                          {history.map((h) => (
                            <li key={h.id} className="px-3 py-2 text-sm">
                              <div className="flex items-baseline justify-between gap-3">
                                <span className="font-medium text-chip-900">{h.outcome}</span>
                                <span className="text-[11px] text-slate-400 whitespace-nowrap">
                                  {new Date(h.calledAt).toLocaleString("en-IN", {
                                    day: "numeric", month: "short", hour: "numeric",
                                    minute: "2-digit", hour12: true,
                                  })}
                                  {h.user?.name ? ` · ${h.user.name}` : ""}
                                </span>
                              </div>
                              {h.notes && <div className="text-slate-600 mt-0.5">{h.notes}</div>}
                              {h.followUpAt && (
                                <div className="text-[11px] text-sky-700 mt-0.5">
                                  Call back {new Date(h.followUpAt).toLocaleString("en-IN", {
                                    day: "numeric", month: "short", hour: "numeric",
                                    minute: "2-digit", hour12: true,
                                  })}
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {historyFor === c.id && history.length === 0 && (
                      <p className="text-xs text-slate-400">No calls logged yet.</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {/* The true count and the next page. Until this existed the list simply
          stopped at the server's take and said nothing about it. */}
      <LoadMore
        shown={rows.length}
        total={total}
        hasMore={hasMore}
        busy={loadingMore}
        onMore={loadMore}
        noun="candidates"
      />
    </Shell>
  );
}
