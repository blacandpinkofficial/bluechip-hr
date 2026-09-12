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

import { useCallback, useEffect, useState } from "react";
import Shell from "@/components/Shell";

const QUEUES = [
  { key: "due", label: "Callbacks due" },
  { key: "new", label: "Never called" },
  { key: "cold", label: "Going cold" },
  { key: "all", label: "Everyone" },
];

const OUTCOMES = [
  { key: "connected", label: "Connected", tone: "bg-emerald-600 hover:bg-emerald-700 text-white" },
  { key: "no-answer", label: "No answer", tone: "bg-white border border-slate-300 hover:bg-slate-50" },
  { key: "busy", label: "Busy", tone: "bg-white border border-slate-300 hover:bg-slate-50" },
  { key: "callback", label: "Call back…", tone: "bg-white border border-slate-300 hover:bg-slate-50" },
  { key: "not-interested", label: "Not interested", tone: "bg-white border border-red-300 text-red-700 hover:bg-red-50" },
  { key: "wrong-number", label: "Wrong number", tone: "bg-white border border-slate-300 hover:bg-slate-50" },
];

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
function money(n) {
  if (n == null) return "—";
  return n >= 1000 ? `₹${Math.round(n / 1000)}k` : `₹${n}`;
}
function ago(d) {
  if (!d) return "never";
  const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
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
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState("");
  const [callbackAt, setCallbackAt] = useState("");
  const [logged, setLogged] = useState(0); // calls logged in this sitting

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const p = new URLSearchParams({ queue });
      if (q.trim()) { p.set("q", q.trim()); p.set("queue", "all"); }
      const r = await fetch(`/api/candidates?${p}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load the list.");
      setRows(j.candidates || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [queue, q]);

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

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

  async function logCall(id, outcome) {
    if (busy) return;
    if (outcome === "callback" && !callbackAt) {
      setError("Pick when to call back — otherwise it is a note nobody sees again.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/candidates/${id}/calls`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outcome,
          notes: notes.trim() || undefined,
          followUpAt: outcome === "callback" ? new Date(callbackAt).toISOString() : undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not log the call.");
      setLogged((n) => n + 1);
      setNotes("");
      setCallbackAt("");
      setOpenId(null);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const open = rows.find((r) => r.id === openId);

  return (
    <Shell
      title="Calls"
      subtitle="Who to ring, what the client will refuse, and what is still unanswered."
    >
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {QUEUES.map((qq) => (
          <button
            key={qq.key}
            onClick={() => { setQueue(qq.key); setQ(""); setOpenId(null); }}
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
          onChange={(e) => { setQ(e.target.value); setOpenId(null); }}
        />
      </div>

      {logged > 0 && (
        <div className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded px-3 py-2 mb-4">
          <b className="tabular-nums">{logged}</b> call{logged === 1 ? "" : "s"} logged in this sitting —
          counted automatically, nothing to tally at the end of the day.
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
             "No candidates yet."}
          </div>
          <p className="text-sm text-slate-500 mt-1">
            {queue === "all"
              ? "Candidates get added from the call list as the desk works."
              : "Try another queue."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((c) => {
            const isOpen = c.id === openId;
            const v = c.screening ? VERDICT[c.screening.verdict] : null;
            return (
              <div key={c.id} className={"card " + (isOpen ? "ring-2 ring-chip-500/40" : "")}>
                {/* Row */}
                <button
                  onClick={() => { setOpenId(isOpen ? null : c.id); setNotes(""); setCallbackAt(""); }}
                  className="w-full text-left p-4 flex flex-wrap items-start gap-x-4 gap-y-1 hover:bg-slate-50/70 transition"
                >
                  <div className="min-w-[12rem] flex-1">
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
                  <div className="text-xs text-slate-500 min-w-[8rem]">
                    {c.callCount} call{c.callCount === 1 ? "" : "s"} · {ago(c.lastContactedAt)}
                  </div>
                  {v && (
                    <span className={"text-[11px] px-2 py-0.5 rounded border self-center " + v.cls}>
                      {v.label}
                    </span>
                  )}
                </button>

                {/* Call panel */}
                {isOpen && (
                  <div className="border-t border-slate-200 p-4 space-y-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <a href={`tel:${c.phone}`} className="btn-primary">📞 Call {c.phone}</a>
                      <a
                        href={`https://wa.me/91${c.phone}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-ghost"
                      >
                        WhatsApp
                      </a>
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
                        {OUTCOMES.map((o) => (
                          <button
                            key={o.key}
                            disabled={busy}
                            onClick={() => logCall(c.id, o.key)}
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
                      {c.lastCall && (
                        <p className="text-xs text-slate-500 mt-2">
                          Last time: <b>{c.lastCall.outcome}</b>
                          {c.lastCall.notes ? ` — ${c.lastCall.notes}` : ""} ({ago(c.lastCall.calledAt)})
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Shell>
  );
}
