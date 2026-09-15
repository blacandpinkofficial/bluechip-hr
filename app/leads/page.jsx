"use client";
// /leads — website enquiries, and what to do with each one.
//
// This screen is the reason the public hiring form is safe to have at all.
// Nothing typed into careers.* reaches Requirement until somebody opens this
// queue and presses Approve, so the queue has to be a screen people actually
// work rather than one they avoid. That means: the whole submission readable in
// one click, the three cheap verdicts on the row itself, and the expensive one
// — approve — pre-filled so that agreeing with the enquiry costs one press and
// correcting it costs a few keystrokes rather than a retype.
//
// Inline, never a modal. The approve form is a draft of a requirement and the
// enquiry it came from is the thing you check it against; a dialog that covers
// the enquiry while you edit its copy is exactly the wrong shape.

import { Fragment, useCallback, useEffect, useState } from "react";
import Shell from "@/components/Shell";

const TABS = [
  { key: "open", label: "To do" },
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "spam", label: "Spam" },
  { key: "all", label: "All" },
];

const TONE = {
  new: "bg-sky-50 text-sky-800 border-sky-200",
  contacted: "bg-amber-50 text-amber-900 border-amber-200",
  approved: "bg-emerald-50 text-emerald-800 border-emerald-200",
  rejected: "bg-slate-100 text-slate-600 border-slate-300",
  spam: "bg-red-50 text-red-800 border-red-200",
};

const LABEL = {
  new: "New",
  contacted: "Contacted",
  approved: "Approved",
  rejected: "Rejected",
  spam: "Spam",
};

function dt(x) {
  if (!x) return "—";
  return new Date(x).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function rupees(n) {
  if (n == null) return null;
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return null;
  return "₹" + v.toLocaleString("en-IN");
}

function budget(lead) {
  const lo = rupees(lead.budgetMin);
  const hi = rupees(lead.budgetMax);
  if (lo && hi) return lo === hi ? `${lo}/month` : `${lo} – ${hi}/month`;
  if (lo) return `From ${lo}/month`;
  if (hi) return `Up to ${hi}/month`;
  return "Not stated";
}

function experience(lead) {
  const lo = lead.expMinMonths;
  const hi = lead.expMaxMonths;
  if (lo == null && hi == null) return "Not stated";
  if (lo != null && hi != null) return lo === hi ? `${lo} months` : `${lo} – ${hi} months`;
  if (lo != null) return `${lo} months+`;
  return `Up to ${hi} months`;
}

/** The small square-shouldered button every row action is made of — the same
 *  one /submissions uses, so the two queues read as one application. */
function RowButton({ children, onClick, disabled, title, tone = "plain" }) {
  const tones = {
    plain: "bg-white text-slate-600 border-slate-300 hover:bg-slate-50 hover:text-chip-700",
    go: "bg-chip-50 text-chip-800 border-chip-300 hover:bg-chip-100",
    stop: "bg-white text-red-700 border-red-200 hover:bg-red-50",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={
        "text-[11px] px-2 py-0.5 rounded border transition disabled:opacity-40 disabled:cursor-not-allowed " +
        tones[tone]
      }
    >
      {children}
    </button>
  );
}

export default function LeadsPage() {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("open");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [openId, setOpenId] = useState("");
  const [busyId, setBusyId] = useState("");
  const [draft, setDraft] = useState(null);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(""), 4000);
    return () => clearTimeout(t);
  }, [flash]);

  const load = useCallback(
    async (quiet) => {
      if (!quiet) setLoading(true);
      try {
        const r = await fetch(`/api/leads?status=${encodeURIComponent(tab)}`);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "Could not load the enquiry queue.");
        setData(j);
        setError("");
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    },
    [tab]
  );

  useEffect(() => {
    load();
  }, [load]);

  async function mark(lead, status) {
    setBusyId(lead.id);
    setError("");
    try {
      const r = await fetch(`/api/leads/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not update the enquiry.");
      setFlash(`${lead.companyName} marked ${LABEL[status].toLowerCase()}.`);
      await load(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId("");
    }
  }

  /** Open the approve form, pre-filled from the enquiry. The stranger's words
   *  are the draft; whatever is in these boxes when Approve is pressed is what
   *  gets written. */
  function startApprove(lead) {
    setOpenId(lead.id);
    setDraft({
      leadId: lead.id,
      clientId: "",
      newClientName: lead.companyName || "",
      designation: lead.designation || "",
      location: lead.city || "",
      openings: lead.openings != null ? String(lead.openings) : "1",
      expMinMonths: lead.expMinMonths != null ? String(lead.expMinMonths) : "",
      expMaxMonths: lead.expMaxMonths != null ? String(lead.expMaxMonths) : "",
      takeHomeMin: lead.budgetMin != null ? String(lead.budgetMin) : "",
      takeHomeMax: lead.budgetMax != null ? String(lead.budgetMax) : "",
      shift: lead.shift || "",
      processType: "",
      processDetail: lead.jobDescription || "",
      educationMin: "",
      priority: "normal",
      relievingRequired: false,
      arrearsAllowed: true,
      cabFacility: "none",
    });
  }

  async function approve(e) {
    e.preventDefault();
    if (!draft || busyId) return;
    setBusyId(draft.leadId);
    setError("");
    try {
      const r = await fetch(`/api/leads/${draft.leadId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not create the opening.");
      setFlash(
        `Opening created: ${j.requirement?.designation || "requirement"} in ${j.requirement?.location || "—"}. It is internal until you publish it on Requirements.`
      );
      setDraft(null);
      setOpenId("");
      await load(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId("");
    }
  }

  const leads = Array.isArray(data?.leads) ? data.leads : [];
  const clients = Array.isArray(data?.clients) ? data.clients : [];
  const counts = data?.counts || {};
  const canCreateClient = !!data?.canCreateClient;

  return (
    <Shell
      title="Website leads"
      subtitle="Hiring enquiries from careers.bluechiphr.com. Nothing here is an opening until you approve it."
    >
      <div className="flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => {
              setTab(t.key);
              setOpenId("");
              setDraft(null);
            }}
            className={
              "rounded-md border px-3 py-1.5 text-sm transition " +
              (tab === t.key
                ? "border-chip-300 bg-chip-50 font-medium text-chip-800"
                : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50")
            }
          >
            {t.label}
            {counts[t.key] != null && (
              <span className="ml-1.5 text-xs text-slate-400">{counts[t.key]}</span>
            )}
          </button>
        ))}
      </div>

      {flash && (
        <div
          role="status"
          className="mt-4 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {flash}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="card mt-4 p-10 text-center text-slate-400">Loading…</div>
      ) : leads.length === 0 ? (
        <div className="card mt-4 p-10 text-center text-slate-500">
          Nothing in this list.
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {leads.map((lead) => {
            const expanded = openId === lead.id;
            const approving = expanded && draft?.leadId === lead.id;
            const settled = lead.status === "approved";

            return (
              <Fragment key={lead.id}>
                <article className="card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="font-semibold text-chip-900">{lead.companyName}</h2>
                        <span
                          className={
                            "rounded border px-1.5 py-0.5 text-[11px] " +
                            (TONE[lead.status] || TONE.rejected)
                          }
                        >
                          {LABEL[lead.status] || lead.status}
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-slate-600">
                        {[lead.designation, lead.city].filter(Boolean).join(" · ")}
                        {lead.openings ? ` · ${lead.openings} needed` : ""}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {[lead.contactName, lead.phone, lead.email].filter(Boolean).join(" · ")}
                      </p>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                      <span className="mr-1 text-xs text-slate-400">{dt(lead.createdAt)}</span>
                      <RowButton
                        onClick={() => {
                          setDraft(null);
                          setOpenId(expanded ? "" : lead.id);
                        }}
                      >
                        {expanded ? "Hide" : "View"}
                      </RowButton>
                      {!settled && (
                        <>
                          {lead.status !== "contacted" && (
                            <RowButton
                              onClick={() => mark(lead, "contacted")}
                              disabled={busyId === lead.id}
                              title="We have called them"
                            >
                              Contacted
                            </RowButton>
                          )}
                          <RowButton
                            tone="go"
                            onClick={() => startApprove(lead)}
                            disabled={busyId === lead.id}
                            title="Turn this into a real opening"
                          >
                            Approve
                          </RowButton>
                          <RowButton
                            tone="stop"
                            onClick={() => mark(lead, "rejected")}
                            disabled={busyId === lead.id}
                          >
                            Reject
                          </RowButton>
                          <RowButton
                            tone="stop"
                            onClick={() => mark(lead, "spam")}
                            disabled={busyId === lead.id}
                          >
                            Spam
                          </RowButton>
                        </>
                      )}
                    </div>
                  </div>

                  {settled && lead.requirement && (
                    <p className="mt-3 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                      Became {lead.requirement.designation} in {lead.requirement.location}
                      {lead.reviewedByName ? ` · approved by ${lead.reviewedByName}` : ""}
                      {lead.reviewedAt ? ` on ${dt(lead.reviewedAt)}` : ""}. Publish it from
                      Requirements when you are ready.
                    </p>
                  )}

                  {expanded && !approving && <Submission lead={lead} />}

                  {approving && (
                    <ApproveForm
                      lead={lead}
                      draft={draft}
                      setDraft={setDraft}
                      clients={clients}
                      canCreateClient={canCreateClient}
                      busy={busyId === lead.id}
                      onSubmit={approve}
                      onCancel={() => {
                        setDraft(null);
                        setOpenId("");
                      }}
                    />
                  )}
                </article>
              </Fragment>
            );
          })}
        </div>
      )}
    </Shell>
  );
}

/** The submission exactly as it arrived. Everything here was typed by a
 *  stranger; React escapes it, and nothing on this screen builds markup. */
function Submission({ lead }) {
  return (
    <div className="mt-4 border-t border-slate-100 pt-4">
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
        <Detail label="Contact" value={lead.contactName} />
        <Detail label="Phone" value={lead.phone} />
        <Detail label="Email" value={lead.email} />
        <Detail label="City" value={lead.city} />
        <Detail label="Role" value={lead.designation} />
        <Detail label="Openings" value={lead.openings != null ? String(lead.openings) : null} />
        <Detail label="Experience" value={experience(lead)} />
        <Detail label="Budget" value={budget(lead)} />
        <Detail label="Shift" value={lead.shift} />
      </dl>

      {lead.jobDescription && (
        <div className="mt-4">
          <div className="label">What they sent</div>
          <p className="whitespace-pre-wrap rounded border border-slate-200 bg-slate-50 p-3 text-sm leading-relaxed text-slate-700">
            {lead.jobDescription}
          </p>
        </div>
      )}

      {lead.notes && (
        <div className="mt-4">
          <div className="label">Our notes</div>
          <p className="whitespace-pre-wrap text-sm text-slate-700">{lead.notes}</p>
        </div>
      )}

      <p className="mt-4 text-[11px] text-slate-400">
        Received {dt(lead.createdAt)}
        {lead.ip ? ` · from ${lead.ip}` : ""}
        {lead.userAgent ? ` · ${lead.userAgent.slice(0, 80)}` : ""}
      </p>
    </div>
  );
}

function Detail({ label, value }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-chip-900">{value || "—"}</dd>
    </div>
  );
}

function ApproveForm({ lead, draft, setDraft, clients, canCreateClient, busy, onSubmit, onCancel }) {
  const set = (k) => (e) => {
    const v = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    setDraft((d) => ({ ...d, [k]: v }));
  };

  return (
    <form onSubmit={onSubmit} className="mt-4 border-t border-slate-100 pt-4">
      <div className="rounded border border-chip-200 bg-chip-50 px-3 py-2 text-xs text-chip-800">
        This creates a real opening. Check every box below — what is here now is
        what the enquiry said, not what you agreed on the phone. The opening is
        internal; publish it from Requirements when you want it on the website.
      </div>

      <Submission lead={lead} />

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor={`cl-${lead.id}`} className="label">
            Client
          </label>
          <select
            id={`cl-${lead.id}`}
            className="input"
            value={draft.clientId}
            onChange={set("clientId")}
          >
            <option value="">
              {canCreateClient ? "— create a new client —" : "— choose a client —"}
            </option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {!draft.clientId && (
          <div className="sm:col-span-2">
            <label htmlFor={`ncn-${lead.id}`} className="label">
              New client name
            </label>
            <input
              id={`ncn-${lead.id}`}
              className="input"
              maxLength={160}
              value={draft.newClientName}
              onChange={set("newClientName")}
              disabled={!canCreateClient}
            />
            <p className="mt-1 text-[11px] text-slate-500">
              {canCreateClient
                ? "The contact details above are copied onto the new client. If a client with this name already exists, the opening is attached to it and nothing about it is changed."
                : "You don't have access to create clients — choose an existing one above."}
            </p>
          </div>
        )}

        <div>
          <label htmlFor={`dg-${lead.id}`} className="label">
            Designation
          </label>
          <input
            id={`dg-${lead.id}`}
            className="input"
            required
            maxLength={160}
            value={draft.designation}
            onChange={set("designation")}
          />
        </div>
        <div>
          <label htmlFor={`lo-${lead.id}`} className="label">
            Location
          </label>
          <input
            id={`lo-${lead.id}`}
            className="input"
            required
            maxLength={160}
            value={draft.location}
            onChange={set("location")}
          />
        </div>

        <div>
          <label htmlFor={`op-${lead.id}`} className="label">
            Openings
          </label>
          <input
            id={`op-${lead.id}`}
            className="input"
            inputMode="numeric"
            value={draft.openings}
            onChange={set("openings")}
          />
        </div>
        <div>
          <label htmlFor={`pt-${lead.id}`} className="label">
            Process
          </label>
          <select
            id={`pt-${lead.id}`}
            className="input"
            value={draft.processType}
            onChange={set("processType")}
          >
            <option value="">Not set</option>
            <option value="voice">Voice</option>
            <option value="non-voice">Non-voice</option>
            <option value="semi-voice">Semi-voice</option>
          </select>
        </div>

        <div>
          <label htmlFor={`e1-${lead.id}`} className="label">
            Experience from (months)
          </label>
          <input
            id={`e1-${lead.id}`}
            className="input"
            inputMode="numeric"
            value={draft.expMinMonths}
            onChange={set("expMinMonths")}
          />
        </div>
        <div>
          <label htmlFor={`e2-${lead.id}`} className="label">
            Experience to (months)
          </label>
          <input
            id={`e2-${lead.id}`}
            className="input"
            inputMode="numeric"
            value={draft.expMaxMonths}
            onChange={set("expMaxMonths")}
          />
        </div>

        <div>
          <label htmlFor={`t1-${lead.id}`} className="label">
            Take home from (₹/month)
          </label>
          <input
            id={`t1-${lead.id}`}
            className="input"
            inputMode="numeric"
            value={draft.takeHomeMin}
            onChange={set("takeHomeMin")}
          />
        </div>
        <div>
          <label htmlFor={`t2-${lead.id}`} className="label">
            Take home to (₹/month)
          </label>
          <input
            id={`t2-${lead.id}`}
            className="input"
            inputMode="numeric"
            value={draft.takeHomeMax}
            onChange={set("takeHomeMax")}
          />
        </div>

        <div>
          <label htmlFor={`sh-${lead.id}`} className="label">
            Shift
          </label>
          <input
            id={`sh-${lead.id}`}
            className="input"
            maxLength={60}
            value={draft.shift}
            onChange={set("shift")}
          />
        </div>
        <div>
          <label htmlFor={`ed-${lead.id}`} className="label">
            Qualification
          </label>
          <input
            id={`ed-${lead.id}`}
            className="input"
            maxLength={200}
            placeholder="Any graduate"
            value={draft.educationMin}
            onChange={set("educationMin")}
          />
        </div>

        <div>
          <label htmlFor={`pr-${lead.id}`} className="label">
            Priority
          </label>
          <select
            id={`pr-${lead.id}`}
            className="input"
            value={draft.priority}
            onChange={set("priority")}
          >
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
        </div>
        <div>
          <label htmlFor={`cb-${lead.id}`} className="label">
            Cab
          </label>
          <select
            id={`cb-${lead.id}`}
            className="input"
            value={draft.cabFacility}
            onChange={set("cabFacility")}
          >
            <option value="none">None</option>
            <option value="oneway">One way</option>
            <option value="twoway">Both ways</option>
          </select>
        </div>

        <div className="sm:col-span-2">
          <label htmlFor={`pd-${lead.id}`} className="label">
            Process detail / job description
          </label>
          <textarea
            id={`pd-${lead.id}`}
            className="input"
            rows={4}
            maxLength={2000}
            value={draft.processDetail}
            onChange={set("processDetail")}
          />
          <p className="mt-1 text-[11px] text-slate-500">
            This is the enquiry&rsquo;s own words. Rewrite it before publishing —
            it goes on the public job page.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-5 sm:col-span-2">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={draft.relievingRequired}
              onChange={set("relievingRequired")}
            />
            Relieving letter required
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={draft.arrearsAllowed}
              onChange={set("arrearsAllowed")}
            />
            Arrears allowed
          </label>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? "Creating…" : "Approve and create the opening"}
        </button>
        <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
      <p className="mt-2 text-[11px] text-slate-500">
        No fee terms are set here. Add them on Requirements, where only an owner
        can.
      </p>
    </form>
  );
}
