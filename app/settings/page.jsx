"use client";
// Settings — your own password, and the two commercial terms that are policy.

import { useCallback, useEffect, useState } from "react";
import Shell from "@/components/Shell";

export default function SettingsPage() {
  const [me, setMe] = useState(null);
  const [settings, setSettings] = useState(null);
  const [canEdit, setCanEdit] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  // Password form
  const [pw, setPw] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState("");
  const [pwDone, setPwDone] = useState(false);

  const load = useCallback(async () => {
    try {
      const [meRes, setRes] = await Promise.all([
        fetch("/api/auth/me").then((r) => (r.ok ? r.json() : null)),
        fetch("/api/settings").then((r) => (r.ok ? r.json() : null)),
      ]);
      if (meRes) {
        setMe(meRes.user);
        setCanEdit((meRes.capabilities || []).includes("user.write"));
      }
      if (setRes) setSettings(setRes.settings);
    } catch {
      setError("Could not load settings.");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function saveSettings(patch) {
    setError("");
    setSaved("");
    try {
      const r = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not save.");
      setSettings(j.settings);
      setSaved("Saved.");
      setTimeout(() => setSaved(""), 2500);
    } catch (e) {
      setError(e.message);
    }
  }

  async function changePassword(e) {
    e.preventDefault();
    if (pwBusy) return;
    setPwError("");
    if (pw.newPassword !== pw.confirm) {
      setPwError("The two new passwords don't match.");
      return;
    }
    setPwBusy(true);
    try {
      const r = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: pw.currentPassword, newPassword: pw.newPassword }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not change your password.");
      setPwDone(true);
      setPw({ currentPassword: "", newPassword: "", confirm: "" });
    } catch (e) {
      setPwError(e.message);
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <Shell title="Settings" subtitle="Your account, and the terms the business runs on.">
      {error && (
        <div role="alert" className="card border-red-200 bg-red-50 p-3 text-sm text-red-800 mb-4">
          {error}
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-5 items-start">
        {/* Password */}
        <div className="card p-5">
          <div className="font-medium text-chip-900">Your password</div>
          <p className="text-sm text-slate-500 mt-1 mb-4">
            Signed in as {me?.name} ({me?.email}).
          </p>

          {pwDone ? (
            <div className="rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              Password changed. Every other device you were signed in on has been
              signed out — this one stays.
            </div>
          ) : (
            <form onSubmit={changePassword}>
              <div className="mb-3">
                <label htmlFor="pw-cur" className="label">Current password</label>
                <input id="pw-cur" type="password" autoComplete="current-password" className="input"
                  value={pw.currentPassword} required
                  onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />
              </div>
              <div className="mb-3">
                <label htmlFor="pw-new" className="label">New password</label>
                <input id="pw-new" type="password" autoComplete="new-password" className="input"
                  value={pw.newPassword} required minLength={8}
                  onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />
                <p className="text-xs text-slate-500 mt-1">At least 8 characters.</p>
              </div>
              <div className="mb-4">
                <label htmlFor="pw-conf" className="label">New password again</label>
                <input id="pw-conf" type="password" autoComplete="new-password" className="input"
                  value={pw.confirm} required
                  onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
              </div>
              {pwError && (
                <div role="alert" className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                  {pwError}
                </div>
              )}
              <button type="submit" className="btn-primary" disabled={pwBusy}>
                {pwBusy ? "Changing…" : "Change password"}
              </button>
            </form>
          )}
        </div>

        {/* Business terms */}
        <div className="card p-5">
          <div className="font-medium text-chip-900">Business terms</div>
          <p className="text-sm text-slate-500 mt-1 mb-4">
            {canEdit
              ? "These are copied onto each placement as it is created, so changing one affects future placements only."
              : "Set by the owner. Shown here because a client may ask you on a call."}
          </p>

          {!settings ? (
            <div className="text-sm text-slate-400">Loading…</div>
          ) : (
            <div className="space-y-4">
              <div>
                <label htmlFor="s-company" className="label">Company name</label>
                <input id="s-company" className="input" defaultValue={settings.companyName}
                  disabled={!canEdit}
                  onBlur={(e) => canEdit && e.target.value !== settings.companyName &&
                    saveSettings({ companyName: e.target.value })} />
              </div>

              <div>
                <label htmlFor="s-repl" className="label">Free replacement window (days)</label>
                <input id="s-repl" type="number" min="0" max="365" className="input w-32"
                  defaultValue={settings.replacementDays} disabled={!canEdit}
                  onBlur={(e) => canEdit && Number(e.target.value) !== settings.replacementDays &&
                    saveSettings({ replacementDays: e.target.value })} />
                <p className="text-xs text-slate-500 mt-1 max-w-prose">
                  Counted from the joining date. If a candidate leaves inside it, Blue Chip
                  owes the client a replacement and the fee is at risk — the Placements
                  screen flags anyone still inside their window. 90 days is the usual term
                  in Indian staffing; 30 and 45 both exist. It was set to 90 as a starting
                  point, not because anyone confirmed it.
                </p>
              </div>

              <div>
                <label htmlFor="s-pay" className="label">Default credit period (days)</label>
                <input id="s-pay" type="number" min="0" max="365" className="input w-32"
                  defaultValue={settings.defaultPaymentDays} disabled={!canEdit}
                  onBlur={(e) => canEdit && Number(e.target.value) !== settings.defaultPaymentDays &&
                    saveSettings({ defaultPaymentDays: e.target.value })} />
                <p className="text-xs text-slate-500 mt-1">
                  How long a client has to pay, unless a different period is agreed with them.
                </p>
              </div>

              {saved && <div className="text-sm text-emerald-700">{saved}</div>}
            </div>
          )}
        </div>

        {/* Careers page */}
        {canEdit && settings && (
          <div className="card p-5">
            <div className="font-medium text-chip-900">Careers page</div>
            <p className="text-sm text-slate-500 mt-1 mb-4">
              A public list of openings at <code className="text-chip-700">/jobs</code>, with an
              apply form that creates a candidate. Off by default, because turning it on
              publishes client names and pay ranges to anyone who visits.
            </p>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                id="s-careers" type="checkbox" className="mt-1 h-4 w-4 accent-chip-600"
                defaultChecked={settings.careersEnabled}
                onChange={(e) => saveSettings({ careersEnabled: e.target.checked })}
              />
              <span className="text-sm">
                <span className="font-medium text-chip-900">Show the careers page</span>
                <span className="block text-slate-500">
                  Only openings you mark <b>Public</b> on the Requirements screen appear.
                  Nothing is published just by switching this on.
                </span>
              </span>
            </label>

            <div className="mt-4">
              <label htmlFor="s-intro" className="label">Introduction shown to candidates</label>
              <textarea id="s-intro" className="input h-20" defaultValue={settings.careersIntro || ""}
                placeholder="The right candidate for the right opportunity, at the right time."
                onBlur={(e) => e.target.value !== (settings.careersIntro || "") &&
                  saveSettings({ careersIntro: e.target.value })} />
            </div>
            <div className="mt-3">
              <label htmlFor="s-cemail" className="label">Contact email on the page</label>
              <input id="s-cemail" type="email" className="input" defaultValue={settings.careersEmail || ""}
                onBlur={(e) => e.target.value !== (settings.careersEmail || "") &&
                  saveSettings({ careersEmail: e.target.value })} />
            </div>

            <a href="/jobs" target="_blank" rel="noopener noreferrer" className="btn-ghost mt-4 inline-flex">
              See what candidates see →
            </a>
          </div>
        )}

        {/* AI connection */}
        {canEdit && settings && (
          <div className="card p-5">
            <div className="font-medium text-chip-900">AI connection</div>
            <p className="text-sm text-slate-500 mt-1 mb-4">
              Somewhere to put a provider key for later. To be plain about it:{" "}
              <b>nothing in the app uses this yet</b> — it is the socket, not the appliance.
              The key is stored on the server and never sent back to a browser.
            </p>

            <label className="flex items-start gap-3 cursor-pointer mb-4">
              <input
                id="s-ai" type="checkbox" className="mt-1 h-4 w-4 accent-chip-600"
                defaultChecked={settings.aiEnabled}
                onChange={(e) => saveSettings({ aiEnabled: e.target.checked })}
              />
              <span className="text-sm">
                <span className="font-medium text-chip-900">Allow AI features</span>
                <span className="block text-slate-500">
                  Leave off until a feature exists that you have decided to use.
                </span>
              </span>
            </label>

            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="s-aiprov" className="label">Provider</label>
                <select id="s-aiprov" className="input" defaultValue={settings.aiProvider || ""}
                  onChange={(e) => saveSettings({ aiProvider: e.target.value })}>
                  <option value="">Not set</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI</option>
                </select>
              </div>
              <div>
                <label htmlFor="s-aikey" className="label">
                  API key {settings.aiKeySet && <span className="text-emerald-700">· one is stored</span>}
                </label>
                <input id="s-aikey" type="password" className="input" autoComplete="off"
                  defaultValue={settings.aiApiKey || ""}
                  placeholder={settings.aiKeySet ? "A key is saved" : "Paste a key"}
                  onBlur={(e) => e.target.value !== (settings.aiApiKey || "") &&
                    saveSettings({ aiApiKey: e.target.value })} />
              </div>
            </div>
            <p className="text-xs text-slate-500 mt-2">
              Clearing the field removes the stored key. Leaving the dots untouched keeps it —
              saving another field on this page will not overwrite it.
            </p>
          </div>
        )}

        {/* Export */}
        <div className="card p-5">
          <div className="font-medium text-chip-900">Export everything</div>
          <p className="text-sm text-slate-500 mt-1 mb-4">
            One workbook with every candidate, call, interview, placement, client and
            opening — laid out as the sheets the desk already knows. Nobody should feel
            locked in; you can walk back to spreadsheets whenever you want.
          </p>
          <a href="/api/export" className="btn-primary inline-flex">Download workbook</a>
          <p className="text-xs text-slate-500 mt-3">
            Revenue and client commercials are included only if your role can see them
            on screen. An export is not a way around a permission.
          </p>
        </div>
      </div>
    </Shell>
  );
}
