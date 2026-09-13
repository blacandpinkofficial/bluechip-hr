"use client";
// Practice calls.
//
// The candidate on the other end is played by the AI when a key is set, and by
// a scripted stand-in when it is not. Either way the SCORE is worked out from
// what you typed, against the questions that decide whether a candidate can
// actually be placed — so it means the same thing every time.
//
// Nobody is told what the persona is hiding until the call is over. Showing it
// up front would just be handing over the answer.

import { useCallback, useEffect, useRef, useState } from "react";
import Shell from "@/components/Shell";

const DIFF = {
  easy: "bg-emerald-50 text-emerald-800 border-emerald-200",
  medium: "bg-amber-50 text-amber-900 border-amber-200",
  hard: "bg-red-50 text-red-800 border-red-200",
};
const VERDICT = {
  strong: { label: "Strong", tone: "text-emerald-700" },
  solid: { label: "Solid", tone: "text-sky-700" },
  "needs-work": { label: "Needs work", tone: "text-amber-700" },
  poor: { label: "Poor", tone: "text-red-700" },
};

export default function TrainingPage() {
  const [data, setData] = useState(null);
  const [session, setSession] = useState(null);
  const [turns, setTurns] = useState([]);
  const [text, setText] = useState("");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const bottom = useRef(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/training");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load the trainer.");
      setData(j);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [turns.length]);

  async function post(body) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/training", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "That did not work.");
      return j;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function start(personaKey) {
    const j = await post({ action: "start", personaKey });
    if (!j) return;
    setSession({ ...j.session, persona: j.persona });
    setTurns(j.session.turns || []);
    setResult(null);
    setText("");
  }

  async function send(e) {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy || !session) return;
    // Shown immediately — waiting for the round trip before your own words
    // appear makes the whole thing feel broken.
    const before = turns;
    setTurns((prev) => [...prev, { role: "trainee", text: t }]);
    setText("");
    const j = await post({ action: "reply", id: session.id, text: t });
    if (j) {
      setTurns(j.turns);
    } else {
      // The send failed, so the server has no record of that line. Leaving it on
      // screen would have the trainee carrying on against a transcript that does
      // not exist — and then being scored on a call they did not make.
      setTurns(before);
      setText(t);
    }
  }

  // Reading back a call you made last week is the thing that makes improvement
  // believable — a percentage on its own is just a number that moved.
  async function review(id) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/training?id=${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not open that call.");
      const s = j.session;
      setSession({ ...s, persona: (data?.personas || []).find((p) => p.key === s.personaKey) });
      setTurns(s.turns || []);
      setResult(s.result ? { ...s.result, headline: "", persona: null } : null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    if (!session) return;
    const j = await post({ action: "finish", id: session.id });
    if (!j) return;
    setResult({ ...j.result, headline: j.headline, persona: j.persona });
    load();
  }

  return (
    <Shell
      title="Practice calls"
      subtitle="Screen a candidate who is having a bad day, and find out what you forgot to ask."
      actions={session && !result && (
        <button className="btn-primary" onClick={finish} disabled={busy}>End the call &amp; see the score</button>
      )}
    >
      {error && <div role="alert" className="card border-red-200 bg-red-50 p-3 text-sm text-red-800 mb-4">{error}</div>}

      {data && !data.aiReady && !session && (
        <div className="card border-slate-300 bg-slate-50 p-3 text-sm text-slate-700 mb-4">
          No AI key is set, so the candidate&rsquo;s replies come from a scripted stand-in.
          Less lifelike, but the drill and the scoring are exactly the same — the score has
          never been worked out by a model.
        </div>
      )}

      {/* ── choosing who to practise against ─────────────────────────────── */}
      {!session && (
        <>
          {data?.trend && (
            <div className="card p-4 mb-4 flex flex-wrap gap-6">
              <div>
                <div className="text-xs text-slate-500">Last call</div>
                <div className="text-xl tabular-nums text-chip-900">{data.trend.latest}%</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Average of your last 5</div>
                <div className="text-xl tabular-nums text-chip-900">{data.trend.average}%</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Calls practised</div>
                <div className="text-xl tabular-nums text-chip-900">{data.trend.attempts}</div>
              </div>
            </div>
          )}

          <div className="grid sm:grid-cols-2 gap-3 mb-6">
            {(data?.personas || []).map((p) => (
              <button key={p.key} onClick={() => start(p.key)} disabled={busy}
                className="card p-4 text-left hover:border-chip-300 transition">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-chip-900">{p.name}</span>
                  <span className={"text-[11px] px-2 py-0.5 rounded border " + (DIFF[p.difficulty] || DIFF.medium)}>
                    {p.difficulty}
                  </span>
                </div>
                <div className="text-sm text-slate-600 mt-1">{p.wins}</div>
                <div className="text-xs text-amber-800 mt-1">Easy mistake: {p.trap}</div>
              </button>
            ))}
          </div>

          <div className="card p-5 mb-4">
            <div className="font-medium text-chip-900">What the score is actually measuring</div>
            <p className="text-sm text-slate-500 mt-1 mb-3 max-w-prose">
              Not charm. These are the questions that decide whether a candidate can be
              placed at all — the same ones the screening rules check. A warm call that
              skipped them still wasted everybody&rsquo;s afternoon.
            </p>
            <table className="w-full text-sm">
              <tbody>
                {(data?.checks || []).map((c) => (
                  <tr key={c.key} className="border-t border-slate-100">
                    <td className="py-2 font-medium text-chip-900 w-1/3">{c.label}</td>
                    <td className="py-2 text-slate-600">{c.why}</td>
                    <td className="py-2 text-right tabular-nums text-slate-400">{c.weight}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data?.mine?.length > 0 && (
            <div className="card p-5">
              <div className="font-medium text-chip-900 mb-2">Your earlier attempts</div>
              <p className="text-xs text-slate-500 mb-2">
                Open one to read back what you actually said.
              </p>
              <table className="w-full text-sm">
                <tbody>
                  {data.mine.filter((s) => s.finishedAt).map((s) => (
                    <tr key={s.id} className="border-t border-slate-100 cursor-pointer hover:bg-slate-50"
                      onClick={() => review(s.id)}>
                      <td className="py-2">{(data.personas.find((p) => p.key === s.personaKey) || {}).name || s.personaKey}</td>
                      <td className="py-2 text-slate-500">
                        {new Date(s.startedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                      </td>
                      <td className={"py-2 text-right tabular-nums " + (VERDICT[s.verdict]?.tone || "")}>
                        {s.percent}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ── the call ─────────────────────────────────────────────────────── */}
      {session && (
        <>
          <div className="card flex flex-col mb-4" style={{ minHeight: "24rem" }}>
            <div className="border-b border-slate-200 px-4 py-2 text-sm">
              <span className="font-medium text-chip-900">{session.persona?.name}</span>
              <span className="text-slate-400"> · they do not know you can see this label</span>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3" style={{ maxHeight: "22rem" }}>
              {turns.map((t, i) => (
                <div key={i} className={"flex " + (t.role === "trainee" ? "justify-end" : "justify-start")}>
                  <div className={"max-w-[80%] rounded-lg px-3 py-2 text-sm " +
                    (t.role === "trainee" ? "bg-chip-700 text-white" : "bg-slate-100 text-slate-800")}>
                    {t.text}
                  </div>
                </div>
              ))}
              {busy && <div className="text-xs text-slate-400">…</div>}
              <div ref={bottom} />
            </div>
            {!result && (
              <form onSubmit={send} className="border-t border-slate-200 p-3 flex gap-2">
                <label htmlFor="say" className="sr-only">What you say</label>
                <input id="say" className="input flex-1" placeholder="What do you say?" value={text}
                  onChange={(e) => setText(e.target.value)} disabled={busy} />
                <button type="submit" className="btn-primary" disabled={busy || !text.trim()}>Say it</button>
              </form>
            )}
          </div>

          {!result && (
            <button className="btn-ghost" onClick={() => { setSession(null); setTurns([]); }}>
              Abandon this call
            </button>
          )}
        </>
      )}

      {/* ── the score ────────────────────────────────────────────────────── */}
      {result && (
        <div className="space-y-4">
          <div className="card p-5">
            <div className="flex flex-wrap items-baseline gap-3">
              <div className={"text-3xl font-semibold tabular-nums " + (VERDICT[result.verdict]?.tone || "")}>
                {result.percent}%
              </div>
              <div className={"text-lg " + (VERDICT[result.verdict]?.tone || "")}>
                {VERDICT[result.verdict]?.label}
              </div>
              <div className="text-sm text-slate-500">{result.score} of {result.outOf}</div>
            </div>
            <p className="text-sm text-chip-900 mt-2 max-w-prose">{result.headline}</p>
          </div>

          {result.persona?.hidden && (
            <div className="card border-sky-200 bg-sky-50 p-4">
              <div className="text-sm font-medium text-sky-900">What they were not telling you</div>
              <p className="text-sm text-sky-900/90 mt-1">{result.persona.hidden}</p>
              <p className="text-xs text-sky-900/70 mt-2">{result.persona.wins}</p>
            </div>
          )}

          {result.notes?.length > 0 && (
            <div className="card border-amber-200 bg-amber-50 p-4">
              <ul className="text-sm text-amber-900 space-y-2">
                {result.notes.map((n, i) => <li key={i}>• {n}</li>)}
              </ul>
            </div>
          )}

          <div className="grid sm:grid-cols-2 gap-4">
            <div className="card p-4">
              <div className="text-sm font-medium text-emerald-800 mb-2">You covered</div>
              {result.covered.length === 0 ? (
                <p className="text-sm text-slate-500">Nothing on the list.</p>
              ) : (
                <ul className="text-sm text-slate-700 space-y-1">
                  {result.covered.map((c) => <li key={c.key}>✓ {c.label}</li>)}
                </ul>
              )}
            </div>
            <div className="card p-4">
              <div className="text-sm font-medium text-red-800 mb-2">You missed</div>
              {result.missed.length === 0 ? (
                <p className="text-sm text-slate-500">Nothing. Good call.</p>
              ) : (
                <ul className="text-sm text-slate-700 space-y-2">
                  {result.missed.map((c) => (
                    <li key={c.key}>
                      <div>✗ {c.label}</div>
                      <div className="text-xs text-slate-500">{c.why}</div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <button className="btn-primary" onClick={() => { setSession(null); setTurns([]); setResult(null); }}>
            Practise another
          </button>
        </div>
      )}
    </Shell>
  );
}
