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
    // `r.ok ? r.json() : null` swallowed every HTTP error, and the catch only
    // fired on a network throw — so a 403 or a 500 left `settings` null and the
    // screen said "Loading…" for the rest of the session with nothing to click.
    try {
      const [meRes, setRes] = await Promise.all([
        fetch("/api/auth/me"),
        fetch("/api/settings"),
      ]);
      if (meRes.ok) {
        const j = await meRes.json();
        setMe(j.user);
        setCanEdit((j.capabilities || []).includes("user.write"));
      }
      if (!setRes.ok) {
        const j = await setRes.json().catch(() => ({}));
        throw new Error(j.error || `Settings could not be loaded (${setRes.status}).`);
      }
      setSettings((await setRes.json()).settings);
      setError("");
    } catch (e) {
      setError(e.message || "Could not load settings.");
      setSettings(null);
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
              Used to sharpen the call scripts on the candidate screen. With no key the
              scripts still work — they are built from the requirement and the candidate
              either way; the key only makes the wording less mechanical. The key is
              stored on the server and never sent back to a browser.
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

        {/* Invoicing identity */}
        {canEdit && settings && (
          <div className="card p-5">
            <div className="font-medium text-chip-900">Invoicing</div>
            <p className="text-sm text-slate-500 mt-1 mb-4">
              What appears at the top of every invoice. An invoice without a GSTIN and an
              address is not a tax invoice, and a client&rsquo;s accounts department will send
              it back — so invoices cannot be raised until these are filled in.
            </p>

            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="s-gstin" className="label">Your GSTIN</label>
                <input id="s-gstin" className="input" defaultValue={settings.gstin || ""}
                  placeholder="33AAACA1234A1Z5"
                  onBlur={(e) => e.target.value !== (settings.gstin || "") && saveSettings({ gstin: e.target.value })} />
                <p className="text-xs text-slate-500 mt-1">
                  The first two digits are your state code, and they decide whether an
                  invoice carries CGST+SGST or IGST. Taken from here automatically.
                </p>
              </div>
              <div>
                <label htmlFor="s-state" className="label">State</label>
                <input id="s-state" className="input" defaultValue={settings.stateName || ""}
                  placeholder="Tamil Nadu"
                  onBlur={(e) => e.target.value !== (settings.stateName || "") && saveSettings({ stateName: e.target.value })} />
              </div>
            </div>

            <div className="mt-3">
              <label htmlFor="s-addr" className="label">Registered address</label>
              <textarea id="s-addr" className="input h-20" defaultValue={settings.addressLine || ""}
                placeholder={"2nd Floor, ...\nChennai 600040"}
                onBlur={(e) => e.target.value !== (settings.addressLine || "") && saveSettings({ addressLine: e.target.value })} />
            </div>

            <div className="grid sm:grid-cols-3 gap-3 mt-3">
              <div>
                <label htmlFor="s-prefix" className="label">Invoice prefix</label>
                <input id="s-prefix" className="input" defaultValue={settings.invoicePrefix || "BCH"}
                  onBlur={(e) => e.target.value !== (settings.invoicePrefix || "") && saveSettings({ invoicePrefix: e.target.value })} />
                <p className="text-xs text-slate-500 mt-1">BCH/2026-27/001</p>
              </div>
              <div>
                <label htmlFor="s-gst" className="label">GST rate</label>
                <select id="s-gst" className="input" defaultValue={String(settings.gstBps ?? 1800)}
                  onChange={(e) => saveSettings({ gstBps: Number(e.target.value) })}>
                  <option value="1800">18% — recruitment services</option>
                  <option value="1200">12%</option>
                  <option value="500">5%</option>
                  <option value="0">Not registered / exempt</option>
                </select>
              </div>
            </div>

            <div className="grid sm:grid-cols-3 gap-3 mt-3">
              <div>
                <label htmlFor="s-bank" className="label">Bank</label>
                <input id="s-bank" className="input" defaultValue={settings.bankName || ""}
                  onBlur={(e) => e.target.value !== (settings.bankName || "") && saveSettings({ bankName: e.target.value })} />
              </div>
              <div>
                <label htmlFor="s-acct" className="label">Account number</label>
                <input id="s-acct" className="input" defaultValue={settings.bankAccount || ""}
                  onBlur={(e) => e.target.value !== (settings.bankAccount || "") && saveSettings({ bankAccount: e.target.value })} />
              </div>
              <div>
                <label htmlFor="s-ifsc" className="label">IFSC</label>
                <input id="s-ifsc" className="input" defaultValue={settings.bankIfsc || ""}
                  onBlur={(e) => e.target.value !== (settings.bankIfsc || "") && saveSettings({ bankIfsc: e.target.value })} />
              </div>
            </div>
            <p className="text-xs text-slate-500 mt-2">
              Invoice numbers run in one unbroken series per financial year (April to March)
              and restart at 001 each April. Gaps in the series get questioned, so nothing
              in the app deletes an invoice — cancelling one keeps its number.
            </p>
          </div>
        )}

        {/* Email */}
        {canEdit && settings && (
          <div className="card p-5">
            <div className="font-medium text-chip-900">Email</div>
            <p className="text-sm text-slate-500 mt-1 mb-4">
              Lets the desk send a CV to a client from inside the app, so there is a record
              of what went where and when. Without this, submissions can still be recorded
              by hand — the record is the part that matters.
            </p>

            <div className="grid sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2">
                <label htmlFor="s-smtph" className="label">SMTP server</label>
                <input id="s-smtph" className="input" defaultValue={settings.smtpHost || ""}
                  placeholder="smtp.gmail.com"
                  onBlur={(e) => e.target.value !== (settings.smtpHost || "") && saveSettings({ smtpHost: e.target.value })} />
              </div>
              <div>
                <label htmlFor="s-smtpp" className="label">Port</label>
                <input id="s-smtpp" className="input" inputMode="numeric" defaultValue={settings.smtpPort ?? ""}
                  placeholder="465"
                  onBlur={(e) => String(e.target.value) !== String(settings.smtpPort ?? "") && saveSettings({ smtpPort: e.target.value })} />
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-3 mt-3">
              <div>
                <label htmlFor="s-smtpu" className="label">Username</label>
                <input id="s-smtpu" className="input" autoComplete="off" defaultValue={settings.smtpUser || ""}
                  onBlur={(e) => e.target.value !== (settings.smtpUser || "") && saveSettings({ smtpUser: e.target.value })} />
              </div>
              <div>
                <label htmlFor="s-smtppw" className="label">
                  Password {settings.smtpPasswordSet && <span className="text-emerald-700">· one is stored</span>}
                </label>
                <input id="s-smtppw" type="password" className="input" autoComplete="new-password"
                  defaultValue={settings.smtpPassword || ""}
                  placeholder={settings.smtpPasswordSet ? "A password is saved" : ""}
                  onBlur={(e) => e.target.value !== (settings.smtpPassword || "") && saveSettings({ smtpPassword: e.target.value })} />
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-3 mt-3">
              <div>
                <label htmlFor="s-smtpf" className="label">Send from</label>
                <input id="s-smtpf" className="input" defaultValue={settings.smtpFrom || ""}
                  placeholder="Blue Chip HR &lt;hr@bluechiphr.com&gt;"
                  onBlur={(e) => e.target.value !== (settings.smtpFrom || "") && saveSettings({ smtpFrom: e.target.value })} />
              </div>
              <label className="flex items-start gap-3 cursor-pointer pt-6">
                <input id="s-smtpsec" type="checkbox" className="mt-1 h-4 w-4 accent-chip-600"
                  defaultChecked={settings.smtpSecure}
                  onChange={(e) => saveSettings({ smtpSecure: e.target.checked })} />
                <span className="text-sm">
                  <span className="font-medium text-chip-900">Secure connection</span>
                  <span className="block text-slate-500">On for port 465, off for 587.</span>
                </span>
              </label>
            </div>

            <p className="text-xs text-slate-500 mt-3">
              If this is a Gmail or Google Workspace address it needs an <b>app password</b>,
              not the account password — Google rejects the account password from other
              programs. The password is stored on the server and never sent back to a browser.
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
