"use client";
// The public careers page. No sign-in, no nav, no Blue Chip internals.
//
// Written for the candidate, not the desk: the knockout criteria are stated on
// every card, up front. A candidate who reads "relieving letter required" today
// does not spend two weeks on a role they were never going to get, and the desk
// does not spend a slot finding out.

import { useCallback, useEffect, useState } from "react";

// The exact figure. This rounded to the nearest thousand and then formatted the
// result to look precise, so an opening paying ₹18,500 was published to the
// public internet as "₹19,000 a month" — a number no client agreed to and a
// candidate could reasonably hold the desk to.
function money(n) {
  if (n == null) return null;
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}
function pay(j) {
  const lo = money(j.takeHomeMin), hi = money(j.takeHomeMax);
  if (lo && hi) return lo === hi ? `${lo} a month` : `${lo} – ${hi} a month`;
  if (hi) return `Up to ${hi} a month`;
  if (lo) return `From ${lo} a month`;
  return "Salary discussed on the call";
}
function exp(j) {
  const f = (m) => (m == null ? null : m < 12 ? `${m} month${m === 1 ? "" : "s"}` : `${Math.round(m / 12)} year${Math.round(m / 12) === 1 ? "" : "s"}`);
  if (j.expMinMonths === 0 && j.expMaxMonths === 0) return "Freshers welcome";
  const lo = f(j.expMinMonths), hi = f(j.expMaxMonths);
  if (lo && hi) return lo === hi ? lo : `${lo} – ${hi}`;
  if (lo) return `${lo}+`;
  if (hi) return `Up to ${hi}`;
  return "Any experience";
}

export default function JobsPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [loc, setLoc] = useState("");
  const [applyTo, setApplyTo] = useState(null);
  const [form, setForm] = useState({
    name: "", phone: "", email: "", designation: "",
    location: "", expMonths: "", noticeDays: "", education: "", skills: "", website: "",
  });
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (q.trim()) p.set("q", q.trim());
      if (loc) p.set("location", loc);
      const r = await fetch(`/api/public/jobs?${p}`);
      setData(await r.json());
    } catch {
      setData({ enabled: false, jobs: [] });
    } finally {
      setLoading(false);
    }
  }, [q, loc]);

  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  async function apply(e) {
    e.preventDefault();
    if (sending) return;
    setSending(true);
    setError("");
    try {
      const r = await fetch("/api/public/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, requirementId: applyTo?.id }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Something went wrong. Please try again.");
      setSent(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  if (loading && !data) {
    return <main className="min-h-screen grid place-items-center text-slate-400">Loading…</main>;
  }

  if (!data?.enabled) {
    return (
      <main className="min-h-screen grid place-items-center p-6 bg-slate-50">
        <div className="card p-8 max-w-md text-center">
          <div className="text-xl font-bold text-chip-800">Blue Chip HR</div>
          <p className="text-slate-600 mt-3">
            There are no openings listed publicly at the moment. Please check back soon.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-50">
      <header className="bg-chip-800 text-white">
        <div className="max-w-4xl mx-auto px-6 py-10">
          <div className="text-2xl font-bold">{data.company || "Blue Chip HR"}</div>
          <h1 className="text-3xl font-semibold mt-4">Current openings</h1>
          <p className="text-chip-100 mt-2 max-w-xl">
            {data.intro || "The right candidate for the right opportunity, at the right time."}
          </p>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="flex flex-wrap gap-2 mb-6">
          <input
            id="job-search"
            className="input max-w-xs"
            placeholder="Search role or skill"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select id="job-loc" className="input w-auto" value={loc}
            onChange={(e) => setLoc(e.target.value)} aria-label="Location">
            <option value="">All locations</option>
            {(data.locations || []).map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>

        {data.jobs.length === 0 ? (
          <div className="card p-10 text-center text-slate-500">
            No openings match that. Try a different search.
          </div>
        ) : (
          <div className="space-y-3">
            {data.jobs.map((j) => (
              <article key={j.id} className="card p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-chip-900">{j.designation}</h2>
                    <div className="text-sm text-slate-600">
                      {[j.clientName, j.location].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <button className="btn-primary" onClick={() => { setApplyTo(j); setSent(false); setError(""); }}>
                    Apply
                  </button>
                </div>

                <dl className="grid sm:grid-cols-3 gap-x-6 gap-y-2 mt-4 text-sm">
                  <div>
                    <dt className="text-xs text-slate-500">Take home</dt>
                    <dd className="text-chip-900">{pay(j)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-500">Experience</dt>
                    <dd className="text-chip-900">{exp(j)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-500">Openings</dt>
                    <dd className="text-chip-900">{j.openings}</dd>
                  </div>
                </dl>

                {(j.relievingRequired || j.arrearsAllowed === false || j.educationMin ||
                  (j.cabFacility && j.cabFacility !== "none") || j.shift) && (
                  <div className="mt-4 pt-3 border-t border-slate-100">
                    <div className="text-xs text-slate-500 mb-1.5">Before you apply</div>
                    <div className="flex flex-wrap gap-1.5">
                      {j.relievingRequired && (
                        <span className="text-[11px] px-2 py-0.5 rounded border border-amber-300 bg-amber-50 text-amber-900">
                          Relieving letter required
                        </span>
                      )}
                      {j.arrearsAllowed === false && (
                        <span className="text-[11px] px-2 py-0.5 rounded border border-amber-300 bg-amber-50 text-amber-900">
                          No arrears or backlogs
                        </span>
                      )}
                      {j.educationMin && (
                        <span className="text-[11px] px-2 py-0.5 rounded border border-slate-300 bg-slate-50 text-slate-700">
                          {j.educationMin}
                        </span>
                      )}
                      {j.shift && (
                        <span className="text-[11px] px-2 py-0.5 rounded border border-slate-300 bg-slate-50 text-slate-700">
                          {j.shift}
                        </span>
                      )}
                      {j.cabFacility && j.cabFacility !== "none" && (
                        <span className="text-[11px] px-2 py-0.5 rounded border border-emerald-300 bg-emerald-50 text-emerald-800">
                          Cab {j.cabFacility === "twoway" ? "both ways" : "one way"}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}

        <footer className="text-center text-xs text-slate-400 mt-10">
          {data.company}
          {data.email && <> · <a className="hover:underline" href={`mailto:${data.email}`}>{data.email}</a></>}
        </footer>
      </div>

      {/* Apply */}
      {applyTo && (
        <div className="fixed inset-0 bg-black/40 grid place-items-center p-4 z-50 overflow-y-auto">
          <div className="card p-6 w-full max-w-lg my-8">
            {sent ? (
              <div className="text-center py-4">
                <div className="text-lg font-semibold text-chip-900">Thank you.</div>
                <p className="text-slate-600 mt-2">
                  Your details are with our team. If you&rsquo;re a fit for{" "}
                  <b>{applyTo.designation}</b>, a recruiter will call you.
                </p>
                <button className="btn-primary mt-5" onClick={() => { setApplyTo(null); setForm({ ...form, name: "", phone: "", email: "" }); }}>
                  Close
                </button>
              </div>
            ) : (
              <form onSubmit={apply}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold text-chip-900">Apply</h2>
                    <p className="text-sm text-slate-600">
                      {applyTo.designation} · {applyTo.location}
                    </p>
                  </div>
                  <button type="button" className="text-slate-400 hover:text-slate-700 text-xl leading-none"
                    onClick={() => setApplyTo(null)} aria-label="Close">×</button>
                </div>

                <div className="grid sm:grid-cols-2 gap-3 mt-5">
                  <div className="sm:col-span-2">
                    <label htmlFor="a-name" className="label">Your name</label>
                    <input id="a-name" className="input" required value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })} />
                  </div>
                  <div>
                    <label htmlFor="a-phone" className="label">Mobile number</label>
                    <input id="a-phone" className="input" required inputMode="numeric" value={form.phone}
                      onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                  </div>
                  <div>
                    <label htmlFor="a-email" className="label">Email (optional)</label>
                    <input id="a-email" type="email" className="input" value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })} />
                  </div>
                  <div>
                    <label htmlFor="a-desig" className="label">Current role</label>
                    <input id="a-desig" className="input" value={form.designation}
                      onChange={(e) => setForm({ ...form, designation: e.target.value })} />
                  </div>
                  <div>
                    <label htmlFor="a-exp" className="label">Experience (months)</label>
                    <input id="a-exp" className="input" inputMode="numeric" value={form.expMonths}
                      onChange={(e) => setForm({ ...form, expMonths: e.target.value })} />
                  </div>
                  <div>
                    <label htmlFor="a-loc" className="label">Where you live</label>
                    <input id="a-loc" className="input" value={form.location}
                      onChange={(e) => setForm({ ...form, location: e.target.value })} />
                  </div>
                  <div>
                    <label htmlFor="a-notice" className="label">Notice period (days)</label>
                    <input id="a-notice" className="input" inputMode="numeric" value={form.noticeDays}
                      onChange={(e) => setForm({ ...form, noticeDays: e.target.value })} />
                  </div>
                  <div className="sm:col-span-2">
                    <label htmlFor="a-edu" className="label">Qualification</label>
                    <input id="a-edu" className="input" value={form.education}
                      onChange={(e) => setForm({ ...form, education: e.target.value })} />
                  </div>
                </div>

                {/* Hidden from people, irresistible to bots. */}
                <input
                  type="text" name="website" tabIndex={-1} autoComplete="off"
                  value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })}
                  className="absolute opacity-0 h-0 w-0 -z-10" aria-hidden="true"
                />

                {error && (
                  <div role="alert" className="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                    {error}
                  </div>
                )}

                <button type="submit" className="btn-primary w-full mt-5" disabled={sending}>
                  {sending ? "Sending…" : "Send my details"}
                </button>
                <p className="text-[11px] text-slate-500 mt-3">
                  Your details go to {data.company}&rsquo;s recruitment team and are used to
                  contact you about roles. We don&rsquo;t share them with anyone else.
                </p>
              </form>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
