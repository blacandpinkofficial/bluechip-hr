"use client";
// The login screen. It is the whole of the brand promise that this is a
// separate company, so it carries Blue Chip's name and nothing else — no Pulse,
// no Blac & Pink, no shared styling.
//
// Two notes on how the redirect target is handled:
//
// 1. It is read with window.location inside the submit handler, NOT with
//    useSearchParams(). That hook forces the whole page out of static rendering
//    unless it sits inside a <Suspense> boundary, and without one the
//    production build fails outright at "Generating static pages". Since the
//    value is only needed at the moment of submit, reading it there is simpler
//    than wrapping the page in Suspense to satisfy a hook we barely use.
//
// 2. It is validated before being followed. "?next=" comes from the URL, which
//    means anyone can put anything in it — including https://evil.example. A
//    link like that would show a genuine Blue Chip login page and then hand the
//    user to someone else's site the instant they signed in. Only same-site
//    paths are accepted.

import { useState } from "react";

const DEFAULT_NEXT = "/dashboard";

function safeNext() {
  try {
    const raw = new URLSearchParams(window.location.search).get("next");
    if (!raw) return DEFAULT_NEXT;
    // Must be a path on this site: one leading slash, and not "//host" or
    // "/\host", both of which browsers treat as protocol-relative URLs to
    // somewhere else entirely.
    if (!raw.startsWith("/")) return DEFAULT_NEXT;
    if (raw.startsWith("//") || raw.startsWith("/\\")) return DEFAULT_NEXT;
    return raw;
  } catch {
    return DEFAULT_NEXT;
  }
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(j.error || "Could not sign you in.");
        setBusy(false);
        return;
      }
      // A full navigation, not router.push — the session cookie was just set
      // and the server components need to see it on a fresh request.
      window.location.href = safeNext();
    } catch {
      setError("Network problem. Check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen grid lg:grid-cols-2">
      {/* Brand side */}
      <div className="hidden lg:flex flex-col justify-between bg-chip-800 text-white p-12">
        <div>
          <div className="text-2xl font-bold tracking-tight">Blue Chip HR</div>
          <div className="text-chip-200 text-sm mt-1">Solutions Pvt. Ltd.</div>
        </div>
        <div className="max-w-sm">
          <p className="text-xl leading-relaxed text-chip-50">
            The right candidate for the right opportunity, at the right time.
          </p>
          <p className="text-sm text-chip-300 mt-6">
            Requirements, candidates, interviews and placements — one place, one
            record, no spreadsheets to reconcile at the end of the day.
          </p>
        </div>
        <div className="text-xs text-chip-400">
          Authorised users only. All activity is logged.
        </div>
      </div>

      {/* Form side */}
      <div className="flex items-center justify-center p-6 sm:p-12 bg-white">
        <form onSubmit={submit} className="w-full max-w-sm">
          <div className="lg:hidden mb-8">
            <div className="text-xl font-bold text-chip-800">Blue Chip HR</div>
            <div className="text-slate-500 text-sm">Solutions Pvt. Ltd.</div>
          </div>

          <h1 className="text-2xl font-semibold text-chip-900">Sign in</h1>
          <p className="text-sm text-slate-500 mt-1 mb-6">
            Use the email address your manager set up for you.
          </p>

          <div className="mb-4">
            <label htmlFor="email" className="label">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>

          <div className="mb-6">
            <label htmlFor="password" className="label">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {error && (
            <div
              role="alert"
              className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
            >
              {error}
            </div>
          )}

          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>

          <p className="text-xs text-slate-400 mt-6">
            Forgotten your password? Your manager can reset it — there is no
            self-service reset, by design.
          </p>
        </form>
      </div>
    </main>
  );
}
