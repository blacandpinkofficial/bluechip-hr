"use client";
// Post — writes the LinkedIn post; you press Post on LinkedIn.
//
// Nothing on this screen contacts LinkedIn. The app does the writing and the
// judgement about what may be said publicly; the publishing stays with a human
// and the company account stays safe.

import { useCallback, useEffect, useState } from "react";
import Shell from "@/components/Shell";

export default function SocialPage() {
  const [list, setList] = useState([]);
  const [id, setId] = useState("");
  const [style, setStyle] = useState("hiring");
  const [walkIn, setWalkIn] = useState({ when: "", where: "" });
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");

  useEffect(() => {
    fetch("/api/social")
      .then((r) => r.json())
      .then((j) => setList(j.requirements || []))
      .catch(() => setError("Could not load the open requirements."));
  }, []);

  const load = useCallback(async () => {
    if (!id) { setData(null); return; }
    const p = new URLSearchParams({ requirementId: id, style });
    if (style === "walkin" && walkIn.when) {
      p.set("when", walkIn.when);
      if (walkIn.where) p.set("where", walkIn.where);
    }
    try {
      const r = await fetch(`/api/social?${p}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not build the post.");
      setData(j);
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }, [id, style, walkIn]);

  useEffect(() => { load(); }, [load]);

  async function copy(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(""), 2000);
    } catch {
      // Clipboard access fails on an insecure origin and in some browsers. The
      // text is on screen and selectable, so say that rather than nothing.
      setError("Could not copy automatically — select the text and copy it.");
    }
  }

  return (
    <Shell
      title="Post an opening"
      subtitle="A LinkedIn post written from the requirement, and a search string to find people."
    >
      {error && <div role="alert" className="card border-red-200 bg-red-50 p-3 text-sm text-red-800 mb-4">{error}</div>}

      <div className="card p-5 mb-5">
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="s-req" className="label">Which opening</label>
            <select id="s-req" className="input" value={id} onChange={(e) => setId(e.target.value)}>
              <option value="">Choose an opening…</option>
              {list.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.designation} — {r.location}{r.openings > 1 ? ` (${r.openings})` : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="s-style" className="label">Kind of post</label>
            <select id="s-style" className="input" value={style} onChange={(e) => setStyle(e.target.value)}>
              <option value="hiring">Standard — we are hiring</option>
              <option value="urgent">Urgent — immediate joiners</option>
              <option value="walkin">Walk-in / drive</option>
            </select>
          </div>
        </div>

        {style === "walkin" && (
          <div className="grid sm:grid-cols-2 gap-3 mt-3">
            <div>
              <label htmlFor="w-when" className="label">When</label>
              <input id="w-when" className="input" placeholder="Saturday 20 Sep, 10am – 2pm"
                value={walkIn.when} onChange={(e) => setWalkIn({ ...walkIn, when: e.target.value })} />
            </div>
            <div>
              <label htmlFor="w-where" className="label">Where</label>
              <input id="w-where" className="input" placeholder="Blue Chip HR, 2nd Floor, Anna Nagar"
                value={walkIn.where} onChange={(e) => setWalkIn({ ...walkIn, where: e.target.value })} />
            </div>
          </div>
        )}
      </div>

      {!data ? (
        <div className="card p-10 text-center text-slate-400">
          Choose an opening and the post is written for you.
        </div>
      ) : (
        <>
          <div className="card border-sky-200 bg-sky-50 p-3 text-sm text-sky-900 mb-4">{data.notice}</div>

          {data.post.warnings?.length > 0 && (
            <div className="card border-amber-200 bg-amber-50 p-3 mb-4">
              <ul className="text-sm text-amber-900 space-y-1">
                {data.post.warnings.map((w, i) => <li key={i}>• {w}</li>)}
              </ul>
            </div>
          )}

          <div className="card p-5 mb-4">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div>
                <div className="font-medium text-chip-900">The post</div>
                <div className="text-xs text-slate-500">
                  First line is {data.post.hookLength} characters
                  {data.post.hookFits
                    ? " — fits before LinkedIn cuts it off."
                    : " — LinkedIn cuts it at about 140 on a phone."}
                </div>
              </div>
              <button className="btn-primary" onClick={() => copy(data.post.text, "post")}>
                {copied === "post" ? "Copied" : "Copy"}
              </button>
            </div>
            <pre className="whitespace-pre-wrap text-sm text-slate-800 font-sans bg-slate-50 rounded p-4 border border-slate-200">
              {data.post.text}
            </pre>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <div className="card p-5">
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="font-medium text-chip-900">Short version</div>
                <button className="btn-ghost text-sm" onClick={() => copy(data.short, "short")}>
                  {copied === "short" ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="text-xs text-slate-500 mb-2">For a WhatsApp status or a group.</p>
              <pre className="whitespace-pre-wrap text-sm text-slate-800 font-sans bg-slate-50 rounded p-3 border border-slate-200">
                {data.short}
              </pre>
            </div>

            <div className="card p-5">
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="font-medium text-chip-900">Find people</div>
                <button className="btn-ghost text-sm" onClick={() => copy(data.search.query, "search")}>
                  {copied === "search" ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="whitespace-pre-wrap text-xs text-slate-800 font-mono bg-slate-50 rounded p-3 border border-slate-200 break-all">
                {data.search.query}
              </pre>
              <ul className="text-xs text-slate-500 mt-3 space-y-1">
                {data.search.notes.map((n, i) => <li key={i}>• {n}</li>)}
              </ul>
              {data.search.googleQuery && (
                <>
                  <div className="text-xs text-slate-500 mt-3 mb-1">Or through a search engine:</div>
                  <pre className="whitespace-pre-wrap text-xs text-slate-700 font-mono bg-slate-50 rounded p-3 border border-slate-200 break-all">
                    {data.search.googleQuery}
                  </pre>
                </>
              )}
            </div>
          </div>
        </>
      )}

      <p className="text-xs text-slate-500 mt-4 max-w-prose">
        The app writes the post; you publish it from your own LinkedIn account, and you
        run the search in LinkedIn&rsquo;s own search box. Automated posting and automated
        profile scraping both breach LinkedIn&rsquo;s terms — the company account is worth
        more than the copy-paste it would save.
      </p>
    </Shell>
  );
}
