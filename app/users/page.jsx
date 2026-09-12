"use client";
// Users — who can sign in, and as what.
//
// Passwords are generated here and shown exactly once. Nobody types a password
// for someone else: a chosen one gets reused, written on a pad, or set to the
// company name, and this database holds every candidate's phone number.

import { useCallback, useEffect, useState } from "react";
import Shell from "@/components/Shell";

const ROLE_BLURB = {
  owner: "Everything, including commercials, revenue and invoices.",
  manager: "The whole desk, except setting client rates and invoicing.",
  recruiter: "Their own candidates, calls and interviews, and their own numbers only.",
};

const ROLE_TONE = {
  owner: "bg-chip-100 text-chip-800 border-chip-300",
  manager: "bg-sky-100 text-sky-800 border-sky-300",
  recruiter: "bg-slate-100 text-slate-700 border-slate-300",
};

function ago(d) {
  if (!d) return "never signed in";
  const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
  if (days <= 0) return "signed in today";
  if (days === 1) return "signed in yesterday";
  return `signed in ${days} days ago`;
}

export default function UsersPage() {
  const [users, setUsers] = useState([]);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", phone: "", role: "recruiter" });
  // { name, email, password } — shown once, then dismissed by hand.
  const [credential, setCredential] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/users");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load the team.");
      setUsers(j.users || []);
      setMe(j.me);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const r = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not create the account.");
      setCredential({ name: j.user.name, email: j.user.email, password: j.password });
      setForm({ name: "", email: "", phone: "", role: "recruiter" });
      setAdding(false);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function patch(id, body, label) {
    setError("");
    try {
      const r = await fetch(`/api/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "That change did not save.");
      if (j.password) {
        setCredential({ name: j.user.name, email: j.user.email, password: j.password, reset: true });
      }
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <Shell
      title="Team"
      subtitle="Who can sign in, and what each of them can see."
      actions={
        <button className="btn-primary" onClick={() => setAdding((v) => !v)}>
          {adding ? "Cancel" : "Add someone"}
        </button>
      }
    >
      {credential && (
        <div className="card border-chip-300 bg-chip-50 p-4 mb-5">
          <div className="font-medium text-chip-900">
            {credential.reset ? "Password reset for" : "Account created for"} {credential.name}
          </div>
          <dl className="mt-2 text-sm grid sm:grid-cols-2 gap-x-8 gap-y-1 max-w-lg">
            <div className="flex justify-between border-b border-chip-200 py-1">
              <dt className="text-slate-600">Email</dt>
              <dd className="font-mono">{credential.email}</dd>
            </div>
            <div className="flex justify-between border-b border-chip-200 py-1">
              <dt className="text-slate-600">Password</dt>
              <dd className="font-mono font-semibold">{credential.password}</dd>
            </div>
          </dl>
          <p className="text-xs text-slate-600 mt-2 max-w-prose">
            Shown once and not recoverable — if this box is closed before the password
            is passed on, reset it and a new one appears. Send it over a channel you
            trust, and have them change it at first sign-in.
            {credential.reset && " Every session of theirs has been signed out."}
          </p>
          <button className="btn-ghost mt-3" onClick={() => setCredential(null)}>
            I&rsquo;ve passed it on
          </button>
        </div>
      )}

      {error && (
        <div role="alert" className="card border-red-200 bg-red-50 p-3 text-sm text-red-800 mb-4">
          {error}
        </div>
      )}

      {adding && (
        <form onSubmit={create} className="card p-5 mb-5 max-w-2xl">
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="u-name" className="label">Name</label>
              <input id="u-name" className="input" required value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label htmlFor="u-email" className="label">Email (this is their username)</label>
              <input id="u-email" type="email" className="input" required value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div>
              <label htmlFor="u-phone" className="label">Phone</label>
              <input id="u-phone" className="input" value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div>
              <label htmlFor="u-role" className="label">Role</label>
              <select id="u-role" className="input" value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="recruiter">Recruiter / telecaller</option>
                <option value="manager">Manager</option>
                <option value="owner">Owner</option>
              </select>
            </div>
          </div>
          <p className="text-sm text-slate-600 mt-3">{ROLE_BLURB[form.role]}</p>
          <p className="text-xs text-slate-500 mt-1">
            A password is generated and shown to you once. You don&rsquo;t choose it.
          </p>
          <button type="submit" className="btn-primary mt-4" disabled={saving || !form.name.trim() || !form.email.trim()}>
            {saving ? "Creating…" : "Create account"}
          </button>
        </form>
      )}

      {loading ? (
        <div className="card p-10 text-center text-slate-400">Loading…</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm min-w-[820px]">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-left">
                <th className="px-4 py-2 font-medium text-slate-600">Name</th>
                <th className="px-4 py-2 font-medium text-slate-600">Role</th>
                <th className="px-4 py-2 font-medium text-slate-600">Activity</th>
                <th className="px-4 py-2 font-medium text-slate-600">Last seen</th>
                <th className="px-4 py-2 font-medium text-slate-600 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={
                  "border-b border-slate-100 last:border-0 align-top " +
                  (u.active ? "hover:bg-slate-50/60" : "opacity-55")
                }>
                  <td className="px-4 py-3">
                    <div className="font-medium text-chip-900">
                      {u.name}{u.id === me && <span className="text-xs text-slate-400 font-normal"> — you</span>}
                    </div>
                    <div className="text-xs text-slate-500">{u.email}</div>
                    {!u.active && <div className="text-xs text-red-700 mt-0.5">Deactivated</div>}
                  </td>
                  <td className="px-4 py-3">
                    {u.id === me ? (
                      <span className={"text-[11px] px-2 py-0.5 rounded border " + ROLE_TONE[u.role]}>
                        {u.role}
                      </span>
                    ) : (
                      <select
                        id={`role-${u.id}`}
                        className={"input py-1 text-xs w-auto border " + ROLE_TONE[u.role]}
                        value={u.role}
                        onChange={(e) => patch(u.id, { role: e.target.value })}
                        aria-label={`Role for ${u.name}`}
                      >
                        <option value="recruiter">recruiter</option>
                        <option value="manager">manager</option>
                        <option value="owner">owner</option>
                      </select>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    <div className="tabular-nums">{u.callCount} calls · {u.candidateCount} candidates</div>
                    <div className="tabular-nums">{u.placementCount} placements</div>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">{ago(u.lastLoginAt)}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button
                      className="text-xs text-chip-700 hover:underline mr-3"
                      onClick={() => patch(u.id, { resetPassword: true })}
                    >
                      Reset password
                    </button>
                    {u.id !== me && (
                      <button
                        className={"text-xs hover:underline " + (u.active ? "text-red-700" : "text-emerald-700")}
                        onClick={() => patch(u.id, { active: !u.active })}
                      >
                        {u.active ? "Deactivate" : "Reactivate"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card p-4 mt-5 max-w-2xl">
        <div className="text-sm font-medium mb-2">What each role sees</div>
        <dl className="text-sm space-y-1.5">
          {Object.entries(ROLE_BLURB).map(([k, v]) => (
            <div key={k} className="flex gap-3">
              <dt className={"text-[11px] px-2 py-0.5 rounded border h-fit shrink-0 " + ROLE_TONE[k]}>{k}</dt>
              <dd className="text-slate-600">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-slate-500 mt-3">
          Deactivating signs someone out immediately rather than at session expiry, and
          so does a password reset. The last active owner cannot be demoted or
          deactivated — there is no way back into commercials and invoicing from inside
          the app once that is gone.
        </p>
      </div>
    </Shell>
  );
}
