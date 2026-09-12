"use client";
// Clients — the companies Blue Chip recruits for, and the terms with each.
//
// Commercials appear only for owners. The API strips them before they leave the
// server, so this is not a hidden column — a manager's browser never receives
// the number at all.

import { useEffect, useState, useCallback } from "react";
import Shell from "@/components/Shell";

function feeText(c) {
  if (c.feeType === "percent" && c.feeBps != null) {
    return (c.feeBps / 100).toFixed(2).replace(/\.00$/, "") + "% of CTC";
  }
  if (c.feeType === "flat" && c.feeFlat != null) {
    return "₹" + Number(c.feeFlat).toLocaleString("en-IN") + " flat";
  }
  return null;
}

export default function ClientsPage() {
  const [clients, setClients] = useState([]);
  const [canSeeFees, setCanSeeFees] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    name: "", hrName: "", hrPhone: "", city: "",
    feeType: "", feePercent: "", feeFlat: "",
  });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/clients");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not load clients.");
      setClients(j.clients || []);
      setCanSeeFees(!!j.canSeeFees);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function save(e) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const r = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not save.");
      setForm({ name: "", hrName: "", hrPhone: "", city: "", feeType: "", feePercent: "", feeFlat: "" });
      setAdding(false);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Shell
      title="Clients"
      subtitle="Who Blue Chip recruits for, and the terms agreed with each."
      actions={
        <button className="btn-primary" onClick={() => setAdding((v) => !v)}>
          {adding ? "Cancel" : "Add client"}
        </button>
      }
    >
      {error && (
        <div role="alert" className="card border-red-200 bg-red-50 p-4 text-sm text-red-800 mb-4">
          {error}
        </div>
      )}

      {adding && (
        <form onSubmit={save} className="card p-5 mb-6 max-w-2xl">
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="c-name" className="label">Company name</label>
              <input id="c-name" className="input" required value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label htmlFor="c-city" className="label">City</label>
              <input id="c-city" className="input" value={form.city}
                onChange={(e) => setForm({ ...form, city: e.target.value })} />
            </div>
            <div>
              <label htmlFor="c-hr" className="label">HR contact</label>
              <input id="c-hr" className="input" value={form.hrName}
                onChange={(e) => setForm({ ...form, hrName: e.target.value })} />
            </div>
            <div>
              <label htmlFor="c-phone" className="label">Phone</label>
              <input id="c-phone" className="input" value={form.hrPhone}
                onChange={(e) => setForm({ ...form, hrPhone: e.target.value })} />
            </div>
          </div>

          {canSeeFees && (
            <fieldset className="mt-5 border-t border-slate-200 pt-4">
              <legend className="sr-only">Commercials</legend>
              <div className="label mb-2">Commercials</div>
              <div className="flex flex-wrap items-end gap-3">
                <select
                  id="c-feetype"
                  className="input w-auto"
                  value={form.feeType}
                  onChange={(e) => setForm({ ...form, feeType: e.target.value })}
                >
                  <option value="">Not set yet</option>
                  <option value="percent">Percentage of CTC</option>
                  <option value="flat">Flat fee</option>
                </select>

                {form.feeType === "percent" && (
                  <div>
                    <label htmlFor="c-pct" className="label">Percent</label>
                    <input id="c-pct" className="input w-32" placeholder="8.33" value={form.feePercent}
                      onChange={(e) => setForm({ ...form, feePercent: e.target.value })} />
                  </div>
                )}
                {form.feeType === "flat" && (
                  <div>
                    <label htmlFor="c-flat" className="label">Amount</label>
                    <input id="c-flat" className="input w-32" placeholder="8000 or 8k" value={form.feeFlat}
                      onChange={(e) => setForm({ ...form, feeFlat: e.target.value })} />
                  </div>
                )}
              </div>
              <p className="text-xs text-slate-500 mt-2">
                This is the default for the client. An individual opening can carry its
                own rate, and a placement freezes whichever applied at the time.
              </p>
            </fieldset>
          )}

          <button type="submit" className="btn-primary mt-5" disabled={saving || !form.name.trim()}>
            {saving ? "Saving…" : "Add client"}
          </button>
        </form>
      )}

      {loading ? (
        <div className="card p-10 text-center text-slate-400">Loading…</div>
      ) : clients.length === 0 ? (
        <div className="card p-10 text-center">
          <div className="text-slate-600">No clients yet.</div>
          <p className="text-sm text-slate-500 mt-1">
            Importing the job description sheet creates them automatically.
          </p>
          <a href="/import" className="btn-primary mt-4 inline-flex">Import the sheet</a>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {clients.map((c) => {
            const fee = feeText(c);
            return (
              <div key={c.id} className="card p-4">
                <div className="font-medium text-chip-900">{c.name}</div>
                <div className="text-xs text-slate-500">
                  {[c.hrName, c.city].filter(Boolean).join(" · ") || "No contact recorded"}
                </div>
                {c.hrPhone && <div className="text-xs text-slate-500">{c.hrPhone}</div>}

                <div className="flex gap-4 mt-3 text-sm">
                  <div>
                    <div className="tabular-nums font-medium text-chip-800">{c.openOpenings}</div>
                    <div className="text-[11px] text-slate-500">open positions</div>
                  </div>
                  <div>
                    <div className="tabular-nums font-medium text-chip-800">{c.requirementCount}</div>
                    <div className="text-[11px] text-slate-500">requirements</div>
                  </div>
                  <div>
                    <div className="tabular-nums font-medium text-chip-800">{c.placementCount}</div>
                    <div className="text-[11px] text-slate-500">placements</div>
                  </div>
                </div>

                {canSeeFees && (
                  <div className="mt-3 pt-3 border-t border-slate-100 text-sm">
                    {fee ? (
                      <span className="text-chip-800">{fee}</span>
                    ) : (
                      <span className="text-amber-700">No commercials set</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Shell>
  );
}
