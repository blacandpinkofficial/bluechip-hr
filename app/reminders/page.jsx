"use client";
// Today — what this person has to do, in the order they should do it.
//
// Late first. A list sorted by creation date buries the three-day-old follow-up
// under six things due next week, and the three-day-old follow-up is the one
// costing money.
//
// Nothing here is new information. All of it was already in the database; it was
// simply only visible to whoever thought to go and look.

import { useCallback, useEffect, useState } from "react";
import Shell from "@/components/Shell";

const LINK = {
  candidate: (id) => `/candidates?open=${id}`,
  interview: () => `/interviews`,
  placement: () => `/placements`,
  invoice: () => `/invoices`,
  submission: () => `/submissions`,
  attendance: () => `/attendance`,
};

const URGENCY = {
  now: "border-l-4 border-l-red-500",
  normal: "border-l-4 border-l-amber-400",
  later: "border-l-4 border-l-slate-300",
};

export default function RemindersPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showDone, setShowDone] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/reminders${showDone ? "?done=1" : ""}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load your list.");
      setData(j);
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [showDone]);

  useEffect(() => { load(); }, [load]);

  async function mark(id, status) {
    // Optimistic: the row disappears immediately. Ticking something off should
    // feel instant, and if the save fails the reload puts it back.
    setData((d) => d && ({
      ...d,
      late: d.late.filter((r) => r.id !== id),
      today: d.today.filter((r) => r.id !== id),
      ahead: d.ahead.filter((r) => r.id !== id),
    }));
    try {
      const r = await fetch("/api/reminders", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "That did not save.");
    } catch (e) {
      setError(e.message);
      load();
    }
  }

  const nothing = data && !data.late.length && !data.today.length && !data.ahead.length;

  return (
    <Shell
      title="Today"
      subtitle="Follow-ups, interviews, guarantees and unpaid invoices — everything with your name on it."
      actions={
        <button className="btn-ghost" onClick={() => setShowDone(!showDone)}>
          {showDone ? "Hide finished" : "Show finished"}
        </button>
      }
    >
      {error && <div role="alert" className="card border-red-200 bg-red-50 p-3 text-sm text-red-800 mb-4">{error}</div>}

      {loading ? (
        <div className="card p-10 text-center text-slate-400">Loading…</div>
      ) : nothing ? (
        <div className="card p-10 text-center">
          <div className="text-chip-900 font-medium">Nothing outstanding.</div>
          <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
            No follow-ups due, no interviews to confirm, nothing overdue. This list fills
            itself overnight from the dates already in the app — so the way to keep it
            useful is to set a follow-up date every time you finish a call.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          <Section title="Late" rows={data.late} onMark={mark} tone="text-red-700" />
          <Section title="Today" rows={data.today} onMark={mark} />
          <Section title="Coming up" rows={data.ahead} onMark={mark} muted />
        </div>
      )}

      <p className="text-xs text-slate-500 mt-6 max-w-prose">
        This list is rebuilt every night. Something you tick off stays ticked off; something
        that is still outstanding comes back with the number of days updated. If a reminder
        disappears on its own, the reason for it went away — the invoice was paid, or the
        call was made.
      </p>
    </Shell>
  );
}

function Section({ title, rows, onMark, tone, muted }) {
  if (!rows?.length) return null;
  return (
    <div>
      <div className={"text-sm font-medium mb-2 " + (tone || "text-chip-900")}>
        {title} <span className="text-slate-400 font-normal">· {rows.length}</span>
      </div>
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.id} className={"card p-4 flex items-start gap-3 " + (URGENCY[r.urgency] || "") + (muted ? " opacity-75" : "")}>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-chip-900">{r.title}</div>
              {r.body && <div className="text-sm text-slate-600 mt-0.5">{r.body}</div>}
              <div className="text-xs text-slate-400 mt-1">
                {r.kind}
                {r.daysLate > 0 && ` · ${r.daysLate} day${r.daysLate === 1 ? "" : "s"} late`}
                {r.status !== "open" && ` · ${r.status}`}
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              {r.refType && LINK[r.refType] && (
                <a href={LINK[r.refType](r.refId)} className="btn-ghost text-sm">Open</a>
              )}
              {r.status === "open" && (
                <>
                  <button className="btn-primary text-sm" onClick={() => onMark(r.id, "done")}>Done</button>
                  <button className="text-xs text-slate-400 hover:text-slate-600 px-1"
                    onClick={() => onMark(r.id, "dismissed")} title="Not something I need to do">
                    Skip
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
