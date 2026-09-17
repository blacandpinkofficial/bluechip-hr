"use client";
// Pay setup — salary, commission and bonus for the desk.
//
// This is where the numbers payroll runs on are actually entered. The APIs for
// it shipped in Phase F and this screen did not, so until now there was no way
// to set anyone's salary at all — payroll simply said "No salary set for this
// person" and there was nowhere to go and fix it.
//
// A salary is never edited in place. Changing someone's pay writes a NEW row
// with a new effective date, and the old one stays, so last month's payslip can
// still be recomputed from the figures that were true last month.

import { useCallback, useEffect, useState } from "react";
import Shell from "@/components/Shell";
import { roleName } from "@/lib/roles";

function inr(n) {
  if (n == null) return "—";
  return `₹${Number(n).toLocaleString("en-IN")}`;
}
function dt(x) {
  return x ? new Date(x).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—";
}
function firstOfNextMonth() {
  // getMonth() is 0-based, so `+1` is THIS month, not next. The off-by-one
  // meant the form defaulted to backdating every raise into the month already
  // in progress — silently re-pricing the whole month at the new rate, which is
  // the exact thing the never-edit-a-salary rule exists to prevent. Built by
  // date arithmetic so December rolls the year over on its own.
  const d = new Date();
  const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-01`;
}

export default function PaySetupPage() {
  const [people, setPeople] = useState([]);
  const [rules, setRules] = useState([]);
  const [canWrite, setCanWrite] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [busy, setBusy] = useState(false);
  const [openPay, setOpenPay] = useState(null);
  const [openHistory, setOpenHistory] = useState(null);
  const [form, setForm] = useState({ monthlyGross: "", standardHoursPerDay: 8, workingDaysPerWeek: 6, effectiveFrom: firstOfNextMonth(), note: "" });
  const [ruleForm, setRuleForm] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, i] = await Promise.all([
        fetch("/api/payroll/salary"),
        fetch("/api/payroll/incentive"),
      ]);
      if (!s.ok) throw new Error((await s.json().catch(() => ({}))).error || "Could not load salaries.");
      const sj = await s.json();
      setPeople(sj.people || []);
      setCanWrite(!!sj.canWrite);
      // Not `if (i.ok)` and move on. Swallowing the failure made the screen
      // state "No rules yet, so no incentive is calculated for anyone" — which
      // is a false statement about someone's pay, not a missing section.
      if (!i.ok) throw new Error((await i.json().catch(() => ({}))).error || "Could not load the incentive rules.");
      setRules((await i.json()).rules || []);
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(""), 4000);
    return () => clearTimeout(t);
  }, [flash]);

  async function saveSalary(userId) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/payroll/salary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, ...form }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "That did not save.");
      setFlash(j.message);
      setOpenPay(null);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveRule() {
    if (busy || !ruleForm) return;
    setBusy(true);
    setError("");
    try {
      const body = { ...ruleForm };
      if (body.kind === "slab") {
        body.slabs = String(body.slabsText || "")
          .split("\n")
          .map((l) => l.split(/[,:]/).map((x) => Number(String(x).replace(/[^\d.]/g, ""))))
          .filter((a) => a.length >= 2 && Number.isFinite(a[0]) && Number.isFinite(a[1]))
          .map(([min, amount]) => ({ min, amount }));
      }
      const r = await fetch("/api/payroll/incentive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "That did not save.");
      setFlash(j.message);
      setRuleForm(null);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const noSalary = people.filter((p) => !p.current).length;

  return (
    <Shell
      title="Pay setup"
      subtitle="Salary, commission and bonus. These are the figures every payslip is calculated from."
      actions={
        canWrite && (
          <button className="btn-primary" onClick={() => setRuleForm({ name: "", kind: "per-joining", perJoining: "", percent: "", slabsText: "3, 5000\n5, 12000", userId: "" })}>
            New incentive rule
          </button>
        )
      }
    >
      {error && <div role="alert" className="card border-red-200 bg-red-50 p-3 text-sm text-red-800 mb-4">{error}</div>}
      {flash && <div className="card border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 mb-4">{flash}</div>}

      {!loading && noSalary > 0 && (
        <div className="card border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 mb-4">
          {noSalary} {noSalary === 1 ? "person has" : "people have"} no salary set. Payroll will
          show them at zero and refuse to lock the month without a confirmation.
        </div>
      )}

      {loading ? (
        <div className="card p-10 text-center text-slate-400">Loading…</div>
      ) : (
        <>
          {/* ── salaries ───────────────────────────────────────────────────── */}
          <div className="card overflow-x-auto mb-6">
            <table className="w-full text-sm min-w-[720px]">
              <thead className="bg-slate-50 text-left text-slate-500">
                <tr>
                  <th className="p-3 font-medium">Person</th>
                  <th className="p-3 font-medium text-right">Monthly salary</th>
                  <th className="p-3 font-medium text-right">Shift</th>
                  <th className="p-3 font-medium">In force from</th>
                  <th className="p-3" />
                </tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.user.id} className="border-t border-slate-100 align-top">
                    <td className="p-3">
                      <div className="font-medium text-chip-900">{p.user.name}</div>
                      <div className="text-xs text-slate-500">{roleName(p.user.role)}</div>
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {p.current ? inr(p.current.monthlyGross) : <span className="text-amber-800">not set</span>}
                    </td>
                    <td className="p-3 text-right tabular-nums text-slate-500">
                      {p.current ? `${p.current.standardHoursPerDay}h × ${p.current.workingDaysPerWeek}d` : "—"}
                    </td>
                    <td className="p-3 text-slate-500">
                      {p.current ? dt(p.current.effectiveFrom) : "—"}
                      {p.upcoming?.length > 0 && (
                        <div className="text-xs text-sky-700">
                          {inr(p.upcoming[p.upcoming.length - 1].monthlyGross)} from {dt(p.upcoming[p.upcoming.length - 1].effectiveFrom)}
                        </div>
                      )}
                    </td>
                    <td className="p-3 text-right whitespace-nowrap">
                      {p.history.length > 1 && (
                        <button className="text-xs text-slate-400 hover:text-chip-700 mr-3"
                          onClick={() => setOpenHistory(openHistory === p.user.id ? null : p.user.id)}>
                          {p.history.length} changes
                        </button>
                      )}
                      {canWrite && (
                        <button className="text-xs text-chip-700 hover:underline"
                          onClick={() => {
                            setOpenPay(openPay === p.user.id ? null : p.user.id);
                            setForm({
                              monthlyGross: p.current?.monthlyGross ?? "",
                              standardHoursPerDay: p.current?.standardHoursPerDay ?? 8,
                              workingDaysPerWeek: p.current?.workingDaysPerWeek ?? 6,
                              effectiveFrom: firstOfNextMonth(),
                              note: "",
                            });
                          }}>
                          {p.current ? "Change" : "Set salary"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {openHistory && (
            <div className="card p-4 mb-6">
              <div className="font-medium text-chip-900 mb-2">
                {people.find((p) => p.user.id === openHistory)?.user.name} — salary history
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {(people.find((p) => p.user.id === openHistory)?.history || []).map((h) => (
                    <tr key={h.id} className="border-t border-slate-100">
                      <td className="py-2">{dt(h.effectiveFrom)}</td>
                      <td className="py-2 text-right tabular-nums">{inr(h.monthlyGross)}</td>
                      <td className="py-2 text-slate-500">{h.note || ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-slate-500 mt-2">
                Nothing here is ever overwritten. Each change is a new row, so a payslip from
                any past month can still be recomputed from the figures that applied then.
              </p>
            </div>
          )}

          {openPay && (
            <form className="card p-5 mb-6 max-w-2xl" onSubmit={(e) => { e.preventDefault(); saveSalary(openPay); }}>
              <div className="font-medium text-chip-900 mb-3">
                {people.find((p) => p.user.id === openPay)?.user.name}
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="pg" className="label">Monthly salary (₹)</label>
                  <input id="pg" className="input" inputMode="numeric" required value={form.monthlyGross}
                    onChange={(e) => setForm({ ...form, monthlyGross: e.target.value })} />
                </div>
                <div>
                  <label htmlFor="pe" className="label">In force from</label>
                  <input id="pe" type="date" className="input" required value={form.effectiveFrom}
                    onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} />
                </div>
                <div>
                  <label htmlFor="ph" className="label">Hours a day</label>
                  <input id="ph" className="input" inputMode="numeric" value={form.standardHoursPerDay}
                    onChange={(e) => setForm({ ...form, standardHoursPerDay: e.target.value })} />
                </div>
                <div>
                  <label htmlFor="pd" className="label">Working days a week</label>
                  <input id="pd" className="input" inputMode="numeric" value={form.workingDaysPerWeek}
                    onChange={(e) => setForm({ ...form, workingDaysPerWeek: e.target.value })} />
                </div>
              </div>
              <div className="mt-3">
                <label htmlFor="pn" className="label">Note (optional)</label>
                <input id="pn" className="input" placeholder="Annual increment" value={form.note}
                  onChange={(e) => setForm({ ...form, note: e.target.value })} />
              </div>
              <div className="flex gap-2 mt-4">
                <button type="submit" className="btn-primary" disabled={busy}>Save</button>
                <button type="button" className="btn-ghost" onClick={() => setOpenPay(null)}>Cancel</button>
              </div>
              <p className="text-xs text-slate-500 mt-3 max-w-prose">
                Hours a day and days a week decide what a full month is worth, and pay is
                pro-rated by hours actually worked against that. They are not a target — they
                are the denominator.
              </p>
            </form>
          )}

          {/* ── incentive rules ────────────────────────────────────────────── */}
          <div className="card p-5">
            <div className="font-medium text-chip-900">Commission and bonus</div>
            <p className="text-sm text-slate-500 mt-1 mb-4 max-w-prose">
              A rule with nobody named applies to the whole desk; a rule naming one person
              overrides it for them. Only candidates who joined and did not drop count —
              a selection that never turned up earned the business nothing.
            </p>

            {rules.length === 0 ? (
              <p className="text-sm text-slate-500">
                No rules yet, so no incentive is calculated for anyone.
              </p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.id} className="border-t border-slate-100">
                      <td className="py-2">
                        <div className="font-medium text-chip-900">{r.name}</div>
                        <div className="text-xs text-slate-500">
                          {r.user ? r.user.name : "Whole desk"} · {r.kind}
                          {!r.active && " · switched off"}
                        </div>
                      </td>
                      <td className="py-2 text-slate-600">
                        {r.kind === "per-joining" && `${inr(r.perJoining)} per joining`}
                        {r.kind === "percent-of-revenue" && `${(r.revenueBps / 100).toFixed(2).replace(/\.00$/, "")}% of revenue`}
                        {r.kind === "slab" && (r.slabs || []).map((s) => `${s.min}+ → ${inr(s.amount)}`).join(", ")}
                      </td>
                      <td className="py-2 text-right text-xs text-slate-500">
                        {/* A worked example beside every rule. "5% of revenue" is
                            abstract; this is how someone spots that they meant
                            5 and typed 50. */}
                        On 3 joinings worth ₹2,00,000: <b className="text-slate-700">{inr(r.example?.amount)}</b>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {ruleForm && (
            <form className="card p-5 mt-4 max-w-2xl" onSubmit={(e) => { e.preventDefault(); saveRule(); }}>
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="rn" className="label">Name</label>
                  <input id="rn" className="input" required placeholder="Recruiter incentive 2026-27"
                    value={ruleForm.name} onChange={(e) => setRuleForm({ ...ruleForm, name: e.target.value })} />
                </div>
                <div>
                  <label htmlFor="rw" className="label">Applies to</label>
                  <select id="rw" className="input" value={ruleForm.userId}
                    onChange={(e) => setRuleForm({ ...ruleForm, userId: e.target.value })}>
                    <option value="">The whole desk</option>
                    {people.map((p) => <option key={p.user.id} value={p.user.id}>{p.user.name}</option>)}
                  </select>
                </div>
              </div>

              <div className="mt-3">
                <label htmlFor="rk" className="label">How it is earned</label>
                <select id="rk" className="input" value={ruleForm.kind}
                  onChange={(e) => setRuleForm({ ...ruleForm, kind: e.target.value })}>
                  <option value="per-joining">A fixed amount per joining</option>
                  <option value="percent-of-revenue">A percentage of the fee billed</option>
                  <option value="slab">Slabs — more joinings, bigger bonus</option>
                </select>
              </div>

              {ruleForm.kind === "per-joining" && (
                <div className="mt-3">
                  <label htmlFor="rp" className="label">Rupees per joining</label>
                  <input id="rp" className="input max-w-[12rem]" inputMode="numeric" value={ruleForm.perJoining}
                    onChange={(e) => setRuleForm({ ...ruleForm, perJoining: e.target.value })} />
                </div>
              )}
              {ruleForm.kind === "percent-of-revenue" && (
                <div className="mt-3">
                  <label htmlFor="rr" className="label">Percentage of the fee</label>
                  <input id="rr" className="input max-w-[12rem]" inputMode="decimal" placeholder="5"
                    value={ruleForm.percent} onChange={(e) => setRuleForm({ ...ruleForm, percent: e.target.value })} />
                  <p className="text-xs text-slate-500 mt-1">Enter 5 for 5%, not 0.05.</p>
                </div>
              )}
              {ruleForm.kind === "slab" && (
                <div className="mt-3">
                  <label htmlFor="rs" className="label">Slabs — one per line, as “joinings, amount”</label>
                  <textarea id="rs" className="input h-24 font-mono text-sm" value={ruleForm.slabsText}
                    onChange={(e) => setRuleForm({ ...ruleForm, slabsText: e.target.value })} />
                  <p className="text-xs text-slate-500 mt-1">
                    The highest slab a person reaches is the one that pays. A slab paying less
                    than a lower one is refused — it is always a typo.
                  </p>
                </div>
              )}

              <div className="flex gap-2 mt-4">
                <button type="submit" className="btn-primary" disabled={busy}>Save rule</button>
                <button type="button" className="btn-ghost" onClick={() => setRuleForm(null)}>Cancel</button>
              </div>
            </form>
          )}
        </>
      )}
    </Shell>
  );
}
