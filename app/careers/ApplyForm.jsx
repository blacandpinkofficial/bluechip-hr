"use client";
// The apply form, on the job detail page.
//
// The only client component on the candidate side, and it does one thing: post
// the fields to /api/public/apply and say what happened. Every rule that
// matters — the careers switch, the rate limit, the honeypot, the length caps,
// whether that opening is still open — is enforced in the route. The maxLength
// attributes below are a courtesy to the person typing, not a check; a browser
// is the attacker's, not ours.
//
// No modal. On a phone a modal over a job description is a trap: the page
// behind scrolls, the keyboard covers half of it, and the close button lands
// under the thumb. The form sits in the page.

import { useState } from "react";

const EMPTY = {
  name: "",
  phone: "",
  email: "",
  location: "",
  designation: "",
  expMonths: "",
  currentCtc: "",
  expectedCtc: "",
  noticeDays: "",
  education: "",
  resumeText: "",
  website: "", // honeypot
};

export default function ApplyForm({ requirementId, designation }) {
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
      const r = await fetch("/api/public/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, requirementId }),
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
      <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-4" role="status">
        <div className="font-semibold text-emerald-900">Thank you.</div>
        <p className="mt-1.5 text-sm leading-relaxed text-emerald-800">
          Your details are with our team. If you are a fit for{" "}
          <b>{designation}</b>, a recruiter will call you on the number you gave.
        </p>
        <button
          type="button"
          className="btn-ghost mt-4"
          onClick={() => {
            setForm(EMPTY);
            setSent(false);
          }}
        >
          Apply for another role
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-3">
      <Field id="ap-name" label="Your name" required>
        <input
          id="ap-name"
          className="input"
          required
          maxLength={120}
          autoComplete="name"
          value={form.name}
          onChange={set("name")}
        />
      </Field>

      <Field id="ap-phone" label="Mobile number" required>
        <input
          id="ap-phone"
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

      <Field id="ap-email" label="Email">
        <input
          id="ap-email"
          className="input"
          type="email"
          maxLength={200}
          autoComplete="email"
          value={form.email}
          onChange={set("email")}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field id="ap-exp" label="Experience (months)">
          <input
            id="ap-exp"
            className="input"
            inputMode="numeric"
            maxLength={4}
            value={form.expMonths}
            onChange={set("expMonths")}
          />
        </Field>
        <Field id="ap-notice" label="Notice (days)">
          <input
            id="ap-notice"
            className="input"
            inputMode="numeric"
            maxLength={3}
            value={form.noticeDays}
            onChange={set("noticeDays")}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field id="ap-cur" label="Current pay (₹/month)">
          <input
            id="ap-cur"
            className="input"
            inputMode="numeric"
            maxLength={9}
            value={form.currentCtc}
            onChange={set("currentCtc")}
          />
        </Field>
        <Field id="ap-exp-pay" label="Expected (₹/month)">
          <input
            id="ap-exp-pay"
            className="input"
            inputMode="numeric"
            maxLength={9}
            value={form.expectedCtc}
            onChange={set("expectedCtc")}
          />
        </Field>
      </div>

      <Field id="ap-role" label="Current role">
        <input
          id="ap-role"
          className="input"
          maxLength={120}
          value={form.designation}
          onChange={set("designation")}
        />
      </Field>

      <Field id="ap-loc" label="Where you live">
        <input
          id="ap-loc"
          className="input"
          maxLength={120}
          value={form.location}
          onChange={set("location")}
        />
      </Field>

      <Field id="ap-edu" label="Qualification">
        <input
          id="ap-edu"
          className="input"
          maxLength={200}
          value={form.education}
          onChange={set("education")}
        />
      </Field>

      <Field id="ap-resume" label="Anything else (optional)">
        <textarea
          id="ap-resume"
          className="input"
          rows={3}
          maxLength={5000}
          placeholder="Paste your CV text, or tell us about your experience."
          value={form.resumeText}
          onChange={set("resumeText")}
        />
      </Field>

      {/* Hidden from people, irresistible to bots. Not display:none — some bots
          skip those. Off-screen and out of the tab order instead. */}
      <div aria-hidden="true" className="absolute left-[-9999px] top-auto h-px w-px overflow-hidden">
        <label htmlFor="ap-website">Leave this empty</label>
        <input
          id="ap-website"
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

      <button type="submit" className="btn-primary w-full" disabled={sending}>
        {sending ? "Sending…" : "Send my details"}
      </button>

      <p className="text-[11px] leading-relaxed text-slate-500">
        Your details go to Blue Chip HR&rsquo;s recruitment team and are used to
        contact you about roles. We don&rsquo;t share them with anyone else, and
        we never charge a candidate a fee.
      </p>
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
