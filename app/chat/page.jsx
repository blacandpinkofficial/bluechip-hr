"use client";
// Chat — the desk talking to itself, inside the app.
//
// It says plainly at the bottom that this is company correspondence. An app
// that looks private but is not is worse than one that is openly not: people
// say things on the strength of what the screen implies.

import { useCallback, useEffect, useRef, useState } from "react";
import Shell from "@/components/Shell";
import { roleName } from "@/lib/roles";

function when(d) {
  const t = new Date(d);
  const today = new Date();
  const sameDay = t.toDateString() === today.toDateString();
  return sameDay
    ? t.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })
    : t.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

export default function ChatPage() {
  const [peer, setPeer] = useState("desk");
  const [data, setData] = useState(null);
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const bottom = useRef(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/chat?peer=${encodeURIComponent(peer)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load messages.");
      setData(j);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, [peer]);

  useEffect(() => { load(); }, [load]);

  // Polling, not a websocket. A desk of six people checking every ten seconds
  // is nothing; a websocket is a second thing to keep running and a second
  // thing to be broken at 9am.
  useEffect(() => {
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [data?.messages?.length]);

  async function send(e) {
    e.preventDefault();
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text, toUserId: peer === "desk" ? null : peer }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "That did not send.");
      setBody("");
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id) {
    await fetch("/api/chat", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => {});
    load();
  }

  const unread = data?.unread || {};
  const peerName = peer === "desk" ? "Everyone" : data?.people?.find((p) => p.id === peer)?.name || "";

  return (
    <Shell title="Chat" subtitle="Quick messages between the desk, kept with the company rather than on a personal phone.">
      {error && <div role="alert" className="card border-red-200 bg-red-50 p-3 text-sm text-red-800 mb-4">{error}</div>}

      {/* Underscore, not comma. Tailwind emits arbitrary values verbatim, so
          `[14rem,1fr]` produced `grid-template-columns: 14rem,1fr`, which is
          invalid CSS and silently dropped — the people list stacked on top of
          the conversation on every desktop. */}
      <div className="grid md:grid-cols-[14rem_1fr] gap-4">
        <div className="card p-2 h-fit">
          <ChannelButton
            active={peer === "desk"}
            onClick={() => setPeer("desk")}
            label="Everyone"
            sub="The whole desk"
            unread={unread.desk}
          />
          <div className="border-t border-slate-100 my-2" />
          {(data?.people || []).map((p) => (
            <ChannelButton
              key={p.id}
              active={peer === p.id}
              onClick={() => setPeer(p.id)}
              label={p.name}
              sub={roleName(p.role)}
              unread={unread[p.id]}
            />
          ))}
          {data?.people?.length === 0 && (
            <div className="text-xs text-slate-400 p-3">Nobody else on the desk yet.</div>
          )}
        </div>

        <div className="card flex flex-col" style={{ minHeight: "28rem" }}>
          <div className="border-b border-slate-200 px-4 py-2 text-sm font-medium text-chip-900">
            {peerName}
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3" style={{ maxHeight: "26rem" }}>
            {(data?.messages || []).length === 0 ? (
              <div className="text-center text-slate-400 text-sm py-12">
                Nothing here yet. Say something.
              </div>
            ) : (
              (data?.messages || []).map((m) => {
                const mine = m.authorId === data?.me?.id;
                return (
                  <div key={m.id} className={"flex " + (mine ? "justify-end" : "justify-start")}>
                    <div className={"max-w-[80%] rounded-lg px-3 py-2 " + (mine ? "bg-chip-700 text-white" : "bg-slate-100 text-slate-800")}>
                      {!mine && (
                        <div className="text-[11px] opacity-70 mb-0.5">{m.author?.name}</div>
                      )}
                      <div className="text-sm whitespace-pre-wrap break-words">{m.body}</div>
                      <div className={"text-[10px] mt-1 " + (mine ? "text-white/60" : "text-slate-400")}>
                        {when(m.createdAt)}
                        {mine && (
                          <button className="ml-2 underline underline-offset-2" onClick={() => remove(m.id)}>
                            delete
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={bottom} />
          </div>

          <form onSubmit={send} className="border-t border-slate-200 p-3 flex gap-2">
            <label htmlFor="chat-body" className="sr-only">Message</label>
            <input
              id="chat-body"
              className="input flex-1"
              placeholder={peer === "desk" ? "Message the whole desk…" : `Message ${peerName}…`}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <button type="submit" className="btn-primary" disabled={busy || !body.trim()}>Send</button>
          </form>
        </div>
      </div>

      <p className="text-xs text-slate-500 mt-4 max-w-prose">
        These messages belong to the company and the owner can read them, including direct
        ones. Anything you would not want read back to you belongs somewhere else. Deleting
        a message removes it from the screen; it does not remove it from the database.
      </p>
    </Shell>
  );
}

function ChannelButton({ active, onClick, label, sub, unread }) {
  return (
    <button
      onClick={onClick}
      className={
        "w-full text-left px-3 py-2 rounded flex items-center justify-between gap-2 transition " +
        (active ? "bg-chip-50 text-chip-900" : "hover:bg-slate-50 text-slate-700")
      }
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium truncate">{label}</span>
        <span className="block text-[11px] text-slate-400 capitalize truncate">{sub}</span>
      </span>
      {unread > 0 && (
        <span className="shrink-0 text-[10px] bg-chip-700 text-white rounded-full px-1.5 py-0.5">{unread}</span>
      )}
    </button>
  );
}
