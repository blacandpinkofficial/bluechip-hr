"use client";
// Knowledge — what the desk needs to look up, and what someone left behind.
//
// Two kinds of thing in one place, because they get searched together: files
// somebody uploaded (a client's process document, a signed agreement) and notes
// somebody typed (a handover before leave, how a particular client likes their
// CVs formatted).

import { useCallback, useEffect, useState, useRef } from "react";
import Shell from "@/components/Shell";
import LoadMore from "@/components/LoadMore";

// The filter bar. "Client agreements" is only offered to someone who may read
// them — see lib/documents.js. The server scopes the rows regardless; this
// keeps the bar from showing a shelf that always comes back empty.
const BASE_KINDS = [
  { key: "", label: "Everything" },
  { key: "handover", label: "Handovers" },
  { key: "process", label: "Client process" },
  { key: "training", label: "Training" },
  { key: "policy", label: "Policy" },
  { key: "note", label: "Notes" },
];

function kindChips(confidential) {
  if (!confidential) return BASE_KINDS;
  return [...BASE_KINDS, { key: "client", label: "Client agreements" }];
}

const KIND_TONE = {
  handover: "bg-amber-50 text-amber-900 border-amber-200",
  process: "bg-sky-50 text-sky-800 border-sky-200",
  training: "bg-emerald-50 text-emerald-800 border-emerald-200",
  policy: "bg-chip-50 text-chip-800 border-chip-200",
  client: "bg-violet-50 text-violet-800 border-violet-200",
  note: "bg-slate-100 text-slate-700 border-slate-300",
};

function size(n) {
  if (n == null) return "";
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
function when(d) {
  return new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export default function KnowledgePage() {
  const [docs, setDocs] = useState([]);
  const [canArchive, setCanArchive] = useState(false);
  const [canConfidential, setCanConfidential] = useState(false);
  const [kind, setKind] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [total, setTotal] = useState(0);
  // What the SERVER says it served, not what is on screen. The two drift the
  // moment a duplicate is dropped, and an offset taken from the screen then
  // asks for a row it already has, forever.
  const [nextSkip, setNextSkip] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  // Which filter the rows on screen belong to. A "load more" that is still in
  // flight when someone changes tab or types in the search box would otherwise
  // append the old list's next page onto the new list, and it would stay there.
  const viewKey = `${kind}|${q}`;
  const viewRef = useRef(viewKey);
  useEffect(() => { viewRef.current = viewKey; }, [viewKey]);
  const [error, setError] = useState("");
  const [mode, setMode] = useState(null); // "write" | "upload"
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState({ title: "", body: "", kind: "handover", tags: "" });
  const [file, setFile] = useState(null);
  const [upload, setUpload] = useState({ title: "", kind: "process", tags: "" });
  const [openId, setOpenId] = useState(null);
  const [archiving, setArchiving] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (kind) p.set("kind", kind);
      if (q.trim()) p.set("q", q.trim());
      const r = await fetch(`/api/documents?${p}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load.");
      setDocs(j.documents || []);
      setCanArchive(!!j.canArchive);
      setCanConfidential(!!j.canSeeConfidential);
      setTotal(Number(j.totalCount) || 0);
      setNextSkip((j.page?.skip || 0) + (j.page?.returned || 0));
      setHasMore(!!j.page?.hasMore);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [kind, q]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const mine = viewRef.current;
      const p = new URLSearchParams({ skip: String(nextSkip) });
      if (kind) p.set("kind", kind);
      if (q.trim()) p.set("q", q.trim());
      const r = await fetch(`/api/documents?${p}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load more.");
      if (viewRef.current !== mine) return;
      const more = Array.isArray(j.documents) ? j.documents : [];
      setDocs((ds) => {
        const seen = new Set(ds.map((x) => x.id));
        return [...ds, ...more.filter((x) => !seen.has(x.id))];
      });
      setTotal(Number(j.totalCount) || 0);
      setNextSkip((j.page?.skip || 0) + (j.page?.returned || 0));
      setHasMore(!!j.page?.hasMore);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingMore(false);
    }
  }, [kind, q, nextSkip]);

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  async function saveNote(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(note),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not save.");
      setNote({ title: "", body: "", kind: "handover", tags: "" });
      setMode(null);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function sendFile(e) {
    e.preventDefault();
    if (busy || !file) return;
    setBusy(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("title", upload.title || file.name);
      fd.append("kind", upload.kind);
      fd.append("tags", upload.tags);
      const r = await fetch("/api/documents", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not upload.");
      setFile(null);
      setUpload({ title: "", kind: "process", tags: "" });
      setMode(null);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function patch(id, body) {
    try {
      const r = await fetch(`/api/documents/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.error || "That did not save.");
      }
      load();
    } catch {
      setError("That did not save — check your connection.");
    }
  }

  return (
    <Shell
      title="Knowledge"
      subtitle="Handovers, client process notes, training material and documents — searchable by everyone on the desk."
      actions={
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={() => setMode(mode === "write" ? null : "write")}>
            Write a note
          </button>
          <button className="btn-primary" onClick={() => setMode(mode === "upload" ? null : "upload")}>
            Upload a file
          </button>
        </div>
      }
    >
      {error && (
        <div role="alert" className="card border-red-200 bg-red-50 p-3 text-sm text-red-800 mb-4">
          {error}
        </div>
      )}

      {mode === "write" && (
        <form onSubmit={saveNote} className="card p-5 mb-5 max-w-2xl">
          <div className="grid sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label htmlFor="n-title" className="label">Title</label>
              <input id="n-title" className="input" required value={note.title}
                placeholder="Handover — AGS Health pipeline, week of 15 Sep"
                onChange={(e) => setNote({ ...note, title: e.target.value })} />
            </div>
            <div>
              <label htmlFor="n-kind" className="label">Kind</label>
              <select id="n-kind" className="input" value={note.kind}
                onChange={(e) => setNote({ ...note, kind: e.target.value })}>
                <option value="handover">Handover</option>
                <option value="process">Client process</option>
                <option value="training">Training</option>
                <option value="policy">Policy</option>
                <option value="note">Note</option>
              </select>
            </div>
          </div>
          <div className="mt-3">
            <label htmlFor="n-body" className="label">What the next person needs to know</label>
            <textarea id="n-body" className="input h-40" required value={note.body}
              placeholder={"Who is mid-pipeline and where they are.\nWhat you promised anyone and when.\nAnything the client said that is not written down elsewhere."}
              onChange={(e) => setNote({ ...note, body: e.target.value })} />
          </div>
          <div className="mt-3">
            <label htmlFor="n-tags" className="label">Tags (comma separated)</label>
            <input id="n-tags" className="input" value={note.tags}
              placeholder="ags health, ar caller, chennai"
              onChange={(e) => setNote({ ...note, tags: e.target.value })} />
          </div>
          <button type="submit" className="btn-primary mt-4" disabled={busy || !note.title.trim() || !note.body.trim()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </form>
      )}

      {mode === "upload" && (
        <form onSubmit={sendFile} className="card p-5 mb-5 max-w-2xl">
          <label htmlFor="u-file" className="label">File</label>
          <input id="u-file" type="file" className="input"
            accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,.jpg,.jpeg,.png,.webp"
            onChange={(e) => setFile(e.target.files?.[0] || null)} />
          <p className="text-xs text-slate-500 mt-1">
            PDF, Word, Excel, image or text. Up to 15 MB.
          </p>
          <div className="grid sm:grid-cols-3 gap-3 mt-3">
            <div className="sm:col-span-2">
              <label htmlFor="u-title" className="label">Title</label>
              <input id="u-title" className="input" value={upload.title}
                placeholder={file?.name || "What is this?"}
                onChange={(e) => setUpload({ ...upload, title: e.target.value })} />
            </div>
            <div>
              <label htmlFor="u-kind" className="label">Kind</label>
              <select id="u-kind" className="input" value={upload.kind}
                onChange={(e) => setUpload({ ...upload, kind: e.target.value })}>
                <option value="process">Client process</option>
                <option value="training">Training</option>
                <option value="policy">Policy</option>
                {/* Filing something as a client agreement decides who may read
                    it afterwards, so it is offered only to the people who can.
                    The upload route refuses it either way. */}
                {canConfidential && <option value="client">Client document</option>}
                <option value="note">Other</option>
              </select>
            </div>
          </div>
          <div className="mt-3">
            <label htmlFor="u-tags" className="label">Tags</label>
            <input id="u-tags" className="input" value={upload.tags}
              onChange={(e) => setUpload({ ...upload, tags: e.target.value })} />
          </div>
          <button type="submit" className="btn-primary mt-4" disabled={busy || !file}>
            {busy ? "Uploading…" : "Upload"}
          </button>
        </form>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {kindChips(canConfidential).map((k) => (
          <button
            key={k.key || "all"}
            onClick={() => setKind(k.key)}
            className={
              "rounded-full px-3 py-1 text-sm transition " +
              (kind === k.key
                ? "bg-chip-700 text-white"
                : "bg-white border border-slate-300 text-slate-600 hover:bg-slate-50")
            }
          >
            {k.label}
          </button>
        ))}
        <input id="k-search" className="input max-w-xs ml-auto" placeholder="Search everything…"
          value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {loading ? (
        <div className="card p-10 text-center text-slate-400">Loading…</div>
      ) : docs.length === 0 ? (
        <div className="card p-10 text-center">
          <div className="text-chip-900 font-medium">Nothing here yet.</div>
          <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
            Start with a handover note the next time someone takes leave, or upload the
            process document a client sent you. Everything here is searchable by the
            whole desk.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {docs.map((d) => {
            const isOpen = openId === d.id;
            return (
              <div key={d.id} className="card">
                <div className="p-4 flex flex-wrap items-start gap-3">
                  <div className="flex-1 min-w-[14rem]">
                    <div className="flex items-center gap-2 flex-wrap">
                      {d.pinned && <span title="Pinned">📌</span>}
                      <span className="font-medium text-chip-900">{d.title}</span>
                      <span className={"text-[11px] px-2 py-0.5 rounded border " + (KIND_TONE[d.kind] || KIND_TONE.note)}>
                        {d.kind}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {d.author?.name || "—"} · {when(d.createdAt)}
                      {d.filename && ` · ${d.filename} (${size(d.bytes)})`}
                      {d.tags && ` · ${d.tags}`}
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    {d.storageKey && (
                      <a href={`/api/documents/${d.id}/file`} target="_blank" rel="noopener noreferrer"
                        className="btn-ghost text-sm">Open</a>
                    )}
                    {d.body && (
                      <button className="btn-ghost text-sm" onClick={() => setOpenId(isOpen ? null : d.id)}>
                        {isOpen ? "Hide" : "Read"}
                      </button>
                    )}
                    <button
                      className="text-xs text-slate-400 hover:text-chip-700 px-1"
                      onClick={() => patch(d.id, { pinned: !d.pinned })}
                      title={d.pinned ? "Unpin" : "Pin to the top"}
                    >
                      {d.pinned ? "Unpin" : "Pin"}
                    </button>
                    {canArchive && (
                      // One click used to file a handover out of sight. The
                      // handover somebody archived by accident is exactly the one
                      // the next person needed.
                      <button
                        className="text-xs text-slate-400 hover:text-red-700 px-1"
                        onClick={() =>
                          archiving === d.id
                            ? (setArchiving(null), patch(d.id, { archived: true }))
                            : setArchiving(d.id)
                        }
                      >
                        {archiving === d.id ? "Sure?" : "Archive"}
                      </button>
                    )}
                  </div>
                </div>
                {isOpen && d.body && (
                  <div className="border-t border-slate-200 p-4">
                    <pre className="whitespace-pre-wrap text-sm text-slate-700 font-sans">{d.body}</pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-slate-500 mt-4 max-w-prose">
        Files are stored on the server outside the application directory, so a deploy
        cannot delete them, and are served only to signed-in users. Archiving is a
        manager&rsquo;s decision even for your own note — a handover deleted by the person
        who wrote it is exactly the one someone needed.
      </p>
      {/* The true count and the next page. Until this existed the list simply
          stopped at the server's take and said nothing about it. */}
      <LoadMore
        shown={docs.length}
        total={total}
        hasMore={hasMore}
        busy={loadingMore}
        onMore={loadMore}
        noun="documents"
      />
    </Shell>
  );
}
