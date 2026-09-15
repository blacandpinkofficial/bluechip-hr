"use client";
// The client requirement form. Posts to /api/public/lead, which writes a
// RequirementLead and nothing else.
//
// Three fields are required — company, role, phone — and that is deliberate.
// Every extra required field on an enquiry form is an enquiry that does not
// get sent, and the missing detail is exactly what the call-back is for. The
// budget and experience boxes are there for the people who already know.
//
// As on the apply form, maxLength here is a courtesy. The route re-validates
// and re-truncates everything; nothing typed in a browser is trusted.

import { useState } from "react";

const EMPTY = {
  companyName: "",
  contactName: "",
  phone: "",
  email: "",
  city: "",
  designation: "",
  openings: "",
  expMinMonths: "",
  expMaxMonths: "",
  budgetMin: "",
  budgetMax: "",
  shift: "",
  jobDescription: "",
  website: "", // honeypot
};

const SHIFTS = ["day", "night", "rotational", "US shift"];

export default function HireForm() {
  const [form, setForm] = useState(EMPTY);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    if (sending) return;
    setSending(true);
    setError("");
    try {
      const r = await fetch("/api/public/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Something went wrong. Please try again.");
      setSent(true);
    } catch (err) {
      setError(err.message || "Something went wrong. Please try again.");
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-6" role="status">
        <h2 className="text-lg font-semibold text-emerald-900">We have your enquiry.</h2>
        <p className="mt-2 text-sm leading-relaxed text-emerald-800">
          A consultant will read it and call you on the number you gave, usually
          the same working day. Nothing has been quoted or agreed automatically —
          the terms are something we talk about.
        </p>
        <button
          type="button"
          className="btn-ghost mt-4"
          onClick={() => {
            setForm(EMPTY);
            setSent(false);
          }}
        >
          Send another requirement
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-8">
      <fieldset className="space-y-4">
        <legend className="text-lg font-semibold">About you</legend>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="h-company" label="Company name" required>
            <input
              id="h-company"
              className="input"
              required
              maxLength={160}
              autoComplete="organization"
              value={form.companyName}
              onChange={set("companyName")}
            />
          </Field>
          <Field id="h-contact" label="Your name">
            <input
              id="h-contact"
              className="input"
              maxLength={120}
              autoComplete="name"
              value={form.contactName}
              onChange={set("contactName")}
            />
          </Field>
          <Field id="h-phone" label="Contact number" required>
            <input
              id="h-phone"
              className="input"
              required
              type="tel"
              inputMode="numeric"
              maxLength={15}
              autoComplete="tel"
              placeholder="10 digits"
              value={form.phone}
              onChange={set("phone")}
            />
          </Field>
          <Field id="h-email" label="Work email">
            <input
              id="h-email"
              className="input"
              type="email"
              maxLength={200}
              autoComplete="email"
              value={form.email}
              onChange={set("email")}
            />
          </Field>
          <Field id="h-city" label="City">
            <input
              id="h-city"
              className="input"
              maxLength={120}
              placeholder="Chennai"
              value={form.city}
              onChange={set("city")}
            />
          </Field>
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-lg font-semibold">The role</legend>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="h-role" label="Designation" required>
            <input
              id="h-role"
              className="input"
              required
              maxLength={160}
              placeholder="AR Caller, Customer Support Executive…"
              value={form.designation}
              onChange={set("designation")}
            />
          </Field>
          <Field id="h-openings" label="How many people">
            <input
              id="h-openings"
              className="input"
              inputMode="numeric"
              maxLength={3}
              value={form.openings}
              onChange={set("openings")}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="h-exp-min" label="Experience from (months)">
            <input
              id="h-exp-min"
              className="input"
              inputMode="numeric"
              maxLength={3}
              placeholder="0 for freshers"
              value={form.expMinMonths}
              onChange={set("expMinMonths")}
            />
          </Field>
          <Field id="h-exp-max" label="Experience to (months)">
            <input
              id="h-exp-max"
              className="input"
              inputMode="numeric"
              maxLength={3}
              value={form.expMaxMonths}
              onChange={set("expMaxMonths")}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="h-budget-min" label="Take home from (₹/month)">
            <input
              id="h-budget-min"
              className="input"
              inputMode="numeric"
              maxLength={9}
              value={form.budgetMin}
              onChange={set("budgetMin")}
            />
          </Field>
          <Field id="h-budget-max" label="Take home to (₹/month)">
            <input
              id="h-budget-max"
              className="input"
              inputMode="numeric"
              maxLength={9}
              value={form.budgetMax}
              onChange={set("budgetMax")}
            />
          </Field>
        </div>
        <p className="text-xs text-slate-500">
          Monthly take-home, in rupees — the figure a candidate is told on the
          call. Leave it blank if it is not settled.
        </p>

        <Field id="h-shift" label="Shift">
          <select id="h-shift" className="input" value={form.shift} onChange={set("shift")}>
            <option value="">Not sure yet</option>
            {SHIFTS.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
        </Field>

        <Field id="h-jd" label="What the job involves">
          <textarea
            id="h-jd"
            className="input"
            rows={6}
            maxLength={4000}
            placeholder="Paste the job description, or describe the role, the process, the qualification you need and anything that would rule a candidate out."
            value={form.jobDescription}
            onChange={set("jobDescription")}
          />
        </Field>
      </fieldset>

      {/* Hidden from people, irresistible to bots. */}
      <div aria-hidden="true" className="absolute left-[-9999px] top-auto h-px w-px overflow-hidden">
        <label htmlFor="h-website">Leave this empty</label>
        <input
          id="h-website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={form.website}
          onChange={set("website")}
        />
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {error}
        </div>
      )}

      <div>
        <button type="submit" className="btn-primary w-full sm:w-auto" disabled={sending}>
          {sending ? "Sending…" : "Send this requirement"}
        </button>
        <p className="mt-3 text-xs leading-relaxed text-slate-500">
          We use these details to call you about this requirement. We don&rsquo;t
          add you to a mailing list and we don&rsquo;t pass them on.
        </p>
      </div>
    </form>
  );
}

function Field({ id, label, required, children }) {
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </label>
      {children}
    </div>
  );
}
