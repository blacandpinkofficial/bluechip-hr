// PATCH /api/candidates/[id] — update a candidate mid-call.
//
// The call screen writes here one field at a time as answers come out of the
// conversation, so this accepts a partial body and touches nothing it was not
// given. A recruiter should never have to fill a form to record one answer.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability, can } from "@/lib/auth";
import { parseRupees } from "@/lib/money";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STAGES = ["new", "contacted", "shortlisted", "lined-up", "interviewed", "selected", "joined", "dropped"];

export async function PATCH(req, { params }) {
  const gate = await requireCapability("candidate.write");
  if (!gate.ok) return gate.response;

  try {
    const id = params?.id;
    const existing = await prisma.candidate.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "No such candidate." }, { status: 404 });

    // A recruiter edits their own; managers and owners edit anyone's. Without
    // this, "my candidates" is a filter rather than a boundary.
    if (!can(gate.user.role, "report.desk") && existing.ownerId && existing.ownerId !== gate.user.id) {
      return NextResponse.json(
        { error: "This candidate belongs to another recruiter." },
        { status: 403 }
      );
    }

    const b = await req.json().catch(() => ({}));
    const data = {};
    const set = (k, v) => { if (v !== undefined) data[k] = v; };

    if (typeof b.name === "string" && b.name.trim()) set("name", b.name.trim());
    if (b.email !== undefined) set("email", String(b.email || "").trim().toLowerCase() || null);
    if (b.designation !== undefined) set("designation", String(b.designation || "").trim() || null);
    if (b.location !== undefined) set("location", String(b.location || "").trim() || null);
    if (b.education !== undefined) set("education", String(b.education || "").trim() || null);
    if (b.skills !== undefined) set("skills", String(b.skills || "").trim() || null);
    if (b.source !== undefined) set("source", String(b.source || "").trim() || null);
    if (b.status !== undefined) set("status", String(b.status || "").trim() || null);
    if (b.altPhone !== undefined) set("altPhone", String(b.altPhone || "").replace(/[^\d+]/g, "") || null);

    if (b.expMonths !== undefined) set("expMonths", numOrNull(b.expMonths));
    if (b.noticeDays !== undefined) set("noticeDays", numOrNull(b.noticeDays));
    if (b.currentCtc !== undefined) set("currentCtc", parseRupees(b.currentCtc));
    if (b.expectedCtc !== undefined) set("expectedCtc", parseRupees(b.expectedCtc));

    // Tri-state on purpose: true, false, and "not asked yet" are three
    // different answers, and screening treats unknown as a question rather
    // than a rejection.
    if (b.hasRelieving !== undefined) set("hasRelieving", triState(b.hasRelieving));
    if (b.hasArrears !== undefined) set("hasArrears", triState(b.hasArrears));

    if (b.rating !== undefined) {
      const r = Number(b.rating);
      set("rating", Number.isFinite(r) && r >= 1 && r <= 5 ? Math.round(r) : null);
    }
    if (b.stage !== undefined) {
      if (!STAGES.includes(b.stage)) {
        return NextResponse.json({ error: `Unknown stage "${b.stage}".` }, { status: 400 });
      }
      set("stage", b.stage);
    }
    if (b.requirementId !== undefined) {
      const rid = String(b.requirementId || "").trim() || null;
      if (rid) {
        // Pointing a candidate at an opening that has since been closed and
        // deleted would come back as a foreign-key 500. The recruiter's real
        // problem is that the list they were choosing from is out of date.
        const opening = await prisma.requirement.findUnique({
          where: { id: rid },
          select: { id: true },
        });
        if (!opening) {
          return NextResponse.json(
            { error: "That opening no longer exists — pick another one." },
            { status: 400 }
          );
        }
      }
      set("requirementId", rid);
    }
    if (b.archived !== undefined) set("archived", !!b.archived);

    // The single outstanding callback, set or cleared from the call list
    // without logging a dial. Deliberately NOT a call: callCount is the day's
    // productivity figure, and "I'll ring him Thursday" is not a call made.
    // null or "" clears it — clearing is how somebody leaves the due queue.
    if (b.nextFollowUpAt !== undefined) {
      if (b.nextFollowUpAt === null || b.nextFollowUpAt === "") {
        set("nextFollowUpAt", null);
      } else {
        const d = new Date(b.nextFollowUpAt);
        if (Number.isNaN(d.getTime())) {
          return NextResponse.json({ error: "That callback time didn't make sense." }, { status: 400 });
        }
        set("nextFollowUpAt", d);
      }
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }

    const updated = await prisma.candidate.update({ where: { id }, data });

    // Log stage moves only. Logging every keystroke would bury the events that
    // matter under a wall of "designation changed".
    if (data.stage && data.stage !== existing.stage) {
      await prisma.auditLog
        .create({
          data: {
            userId: gate.user.id,
            action: "update",
            entity: "Candidate",
            entityId: id,
            summary: `${existing.name}: ${existing.stage} → ${data.stage}`,
          },
        })
        .catch((e) => console.error("[candidate patch] audit write failed:", e?.message));
    }

    return NextResponse.json({ candidate: updated });
  } catch (e) {
    console.error("[PATCH /api/candidates/[id]]", e?.message || e);
    return NextResponse.json({ error: "Could not save the change." }, { status: 500 });
  }
}

function numOrNull(v) {
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}
function triState(v) {
  if (v === true || v === "yes" || v === "true") return true;
  if (v === false || v === "no" || v === "false") return false;
  return null;
}
