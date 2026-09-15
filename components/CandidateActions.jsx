"use client";
// The three things that actually happen after a good call.
//
// This component exists because the app had screens for interviews, placements
// and submissions, and no way to create any of them. Three lists that could
// never be filled, each with an empty state politely directing the user to a
// control that did not exist. A recruiter could log a call and nothing else.
//
// All three live here, on the candidate, because that is where the recruiter
// is standing when the thing happens — they have just put the phone down. Making
// them navigate to a different screen and re-find the person is how a placement
// ends up recorded three days late, or not at all.

import { useEffect, useState } from "react";

function todayLocal() {
  // The value attribute of <input type="date"> wants YYYY-MM-DD in the user's
  // own calendar, not an ISO instant.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function CandidateActions({ candidate, onDone }) {
  const [open, setOpen] = useState(null); // "send" | "interview" | "placement"
  const [requirements, setRequirements] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const [confirmDup, setConfirmDup] = useState(false);

  // The opening defaults to the one the candidate is already against, which is
  // right almost every time.
  const [reqId, setReqId] = useState(candidate.requirement?.id || "");
  const [send, setSend] = useState(true);
  const [when, setWhen] = useState("");
  const [mode, setMode] = useState("telephonic");
  const [ctc, setCtc] = useState("");
  const [selectedOn, setSelectedOn] = useState(todayLocal());
  const [joinedOn, setJoinedOn] = useState("");

  useEffect(() => {
    if (!open || requirements.length) return;
    fetch("/api/requirements?status=open")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setRequirements(j.requirements || []))
      .catch(() => setError("Could not load the open requirements."));
  }, [open, requirements.length]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(""), 4000);
    return () => clearTimeout(t);
  }, [flash]);

  async function post(url, body) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) {
        // A 409 asking "are you sure" is a question, not a failure. Swallowing
        // it as an error would make the button look broken.
        if (j.needsConfirmation) {
          setConfirmDup(true);
          setError(j.error);
          return null;
        }
        throw new Error(j.error || "That did not save.");
      }
      setConfirmDup(false);
      setOpen(null);
      onDone?.();
      return j;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  const chosen = requirements.find((r) => r.id === reqId) || candidate.requirement;

  return (
    <div className="rounded border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap gap-2">
        <button className="btn-ghost text-sm" onClick={() => setOpen(open === "send" ? null : "send")}>
          Send CV to client
        </button>
        <button className="btn-ghost text-sm" onClick={() => setOpen(open === "interview" ? null : "interview")}>
          Book an interview
        </button>
        <button className="btn-ghost text-sm" onClick={() => setOpen(open === "placement" ? null : "placement")}>
          They were selected
        </button>
      </div>

      {error && (
        <div role="alert" className="mt-3 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-800">
          {error}
        </div>
      )}
      {flash && (
        <div className="mt-3 rounded border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-800">
          {flash}
        </div>
      )}

      {open && (
        <div className="mt-3 space-y-3">
          <div>
            <label htmlFor={`req-${candidate.id}`} className="label">For which opening</label>
            <select
              id={`req-${candidate.id}`}
              className="input"
              value={reqId}
              onChange={(e) => setReqId(e.target.value)}
            >
              <option value="">Choose an opening…</option>
              {requirements.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.designation} — {r.clientName || r.client?.name} · {r.location}
                </option>
              ))}
            </select>
          </div>

          {/* ── send the CV ─────────────────────────────────────────────── */}
          {open === "send" && (
            <>
              <label className="flex items-start gap-2 cursor-pointer">
                <input type="checkbox" className="mt-1 h-4 w-4 accent-chip-600"
                  checked={send} onChange={(e) => setSend(e.target.checked)} />
                <span className="text-sm">
                  <span className="font-medium text-chip-900">Email it now</span>
                  <span className="block text-slate-500">
                    Goes to the client&rsquo;s address on file, with the CV attached if one is
                    uploaded. Leave this off to record a submission you sent another way.
                  </span>
                </span>
              </label>
              {confirmDup && (
                <div className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
                  Send it again anyway?
                </div>
              )}
              <button
                className="btn-primary"
                disabled={busy || !reqId}
                onClick={async () => {
                  const j = await post("/api/submissions", {
                    candidateId: candidate.id,
                    requirementId: reqId,
                    send,
                    confirmDuplicate: confirmDup,
                  });
                  if (j) setFlash(j.message);
                }}
              >
                {busy ? "Sending…" : confirmDup ? "Yes, send it again" : "Record and send"}
              </button>
            </>
          )}

          {/* ── book the interview ──────────────────────────────────────── */}
          {open === "interview" && (
            <>
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor={`iv-when-${candidate.id}`} className="label">When</label>
                  <input id={`iv-when-${candidate.id}`} type="datetime-local" className="input"
                    value={when} onChange={(e) => setWhen(e.target.value)} />
                </div>
                <div>
                  <label htmlFor={`iv-mode-${candidate.id}`} className="label">How</label>
                  <select id={`iv-mode-${candidate.id}`} className="input" value={mode}
                    onChange={(e) => setMode(e.target.value)}>
                    <option value="telephonic">Telephonic</option>
                    <option value="direct">In person</option>
                    <option value="video">Video</option>
                  </select>
                </div>
              </div>
              <button
                className="btn-primary"
                disabled={busy || !reqId || !when}
                onClick={async () => {
                  const j = await post("/api/interviews", {
                    candidateId: candidate.id,
                    requirementId: reqId,
                    scheduledAt: new Date(when).toISOString(),
                    mode,
                    // Without this the duplicate guard is a dead end here: a
                    // 409 sets confirmDup, the button re-posts the identical
                    // body, and the same 409 comes back forever.
                    confirmDuplicate: confirmDup,
                  });
                  if (j) setFlash(`Booked. ${candidate.name} moves to lined-up.`);
                }}
              >
                {busy ? "Booking…" : "Book it"}
              </button>
            </>
          )}

          {/* ── record the placement ────────────────────────────────────── */}
          {open === "placement" && (
            <>
              <div className="grid sm:grid-cols-3 gap-3">
                <div>
                  <label htmlFor={`pl-ctc-${candidate.id}`} className="label">Annual CTC offered</label>
                  <input id={`pl-ctc-${candidate.id}`} className="input" placeholder="3.6L or 360000"
                    value={ctc} onChange={(e) => setCtc(e.target.value)} />
                </div>
                <div>
                  <label htmlFor={`pl-sel-${candidate.id}`} className="label">Selected on</label>
                  <input id={`pl-sel-${candidate.id}`} type="date" className="input"
                    value={selectedOn} onChange={(e) => setSelectedOn(e.target.value)} />
                </div>
                <div>
                  <label htmlFor={`pl-join-${candidate.id}`} className="label">Joining date</label>
                  <input id={`pl-join-${candidate.id}`} type="date" className="input"
                    value={joinedOn} onChange={(e) => setJoinedOn(e.target.value)} />
                </div>
              </div>
              <p className="text-xs text-slate-500">
                Leave the joining date empty until they actually turn up. The fee is only
                real revenue once they have joined, and the invoice is raised from that date.
              </p>
              <button
                className="btn-primary"
                disabled={busy || !reqId || !ctc}
                onClick={async () => {
                  const j = await post("/api/placements", {
                    candidateId: candidate.id,
                    requirementId: reqId,
                    ctcOfferedAnnual: ctc,
                    selectedOn,
                    joinedOn: joinedOn || null,
                  });
                  if (j) {
                    setFlash(
                      j.placement?.revenue
                        ? `Recorded — fee ₹${Number(j.placement.revenue).toLocaleString("en-IN")}.`
                        : "Recorded."
                    );
                  }
                }}
              >
                {busy ? "Saving…" : "Record the placement"}
              </button>
              {chosen && !chosen.feeType && (
                <p className="text-xs text-amber-800">
                  No commercials are set for this client, so the fee cannot be worked out.
                  An owner needs to set them before this can be invoiced.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
