"use client";
// Users — who can sign in, and as what.
//
// Passwords are generated here and shown exactly once. Nobody types a password
// for someone else: a chosen one gets reused, written on a pad, or set to the
// company name, and this database holds every candidate's phone number.

import { useCallback, useEffect, useState } from "react";
import Shell from "@/components/Shell";
import { ROLE_BLURB, ROLE_OPTIONS, roleName, roleTone } from "@/lib/roles";

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
  // Nothing here happens on one click any more.
  const [confirm, setConfirm] = useState(null);
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

      {confirm && (
        <div className="card border-amber-300 bg-amber-50 p-4 mb-4">
          <div className="text-sm text-amber-900">
            {confirm.kind === "reset" ? (
              <>
                Reset <strong>{confirm.name}</strong>&rsquo;s password? They are signed out of every
                device immediately, and the new password is shown once — you have to pass it on
                yourself. If they are mid-call, they lose the screen.
              </>
            ) : (
              <>
                Deactivate <strong>{confirm.name}</strong>? They are signed out at once and cannot
                sign back in. Their candidates, calls and placements stay exactly where they are.
              </>
            )}
          </div>
          <div className="flex gap-2 mt-3">
            <button
              className="btn-primary"
              onClick={() => {
                const c = confirm;
                setConfirm(null);
                patch(c.id, c.kind === "reset" ? { resetPassword: true } : { active: false });
              }}
            >
              {confirm.kind === "reset" ? "Reset it" : "Deactivate"}
            </button>
            <button className="btn-ghost" onClick={() => setConfirm(null)}>Cancel</button>
          </div>
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
                {ROLE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
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
                      {/* Through to their desk — what they closed, what is live,
                          and where in the funnel they are losing people. */}
                      <a href={`/people/${u.id}`} className="hover:underline">{u.name}</a>
                      {u.id === me && <span className="text-xs text-slate-400 font-normal"> — you</span>}
                    </div>
                    <div className="text-xs text-slate-500">{u.email}</div>
                    {!u.active && <div className="text-xs text-red-700 mt-0.5">Deactivated</div>}
                  </td>
                  <td className="px-4 py-3">
                    {u.id === me ? (
                      <span className={"text-[11px] px-2 py-0.5 rounded border " + roleTone(u.role)}>
                        {roleName(u.role)}
                      </span>
                    ) : (
                      <select
                        id={`role-${u.id}`}
                        className={"input py-1 text-xs w-auto border " + roleTone(u.role)}
                        value={u.role}
                        onChange={(e) => patch(u.id, { role: e.target.value })}
                        aria-label={`Role for ${u.name}`}
                      >
                        {ROLE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    <div className="tabular-nums">{u.callCount} calls · {u.candidateCount} candidates</div>
                    <div className="tabular-nums">{u.placementCount} placements</div>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">{ago(u.lastLoginAt)}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    {/* Both of these throw the person out of the app mid-call,
                        and they sat three pixels apart with no confirmation.
                        Reset was not even hidden on your own row. */}
                    <button
                      className="text-xs text-chip-700 hover:underline mr-3"
                      onClick={() => setConfirm({ id: u.id, name: u.name, kind: "reset" })}
                    >
                      Reset password
                    </button>
                    {u.id !== me && (
                      <button
                        className={"text-xs hover:underline " + (u.active ? "text-red-700" : "text-emerald-700")}
                        onClick={() =>
                          u.active
                            ? setConfirm({ id: u.id, name: u.name, kind: "deactivate" })
                            : patch(u.id, { active: true })
                        }
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
              <dt className={"text-[11px] px-2 py-0.5 rounded border h-fit shrink-0 " + roleTone(k)}>{roleName(k)}</dt>
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
