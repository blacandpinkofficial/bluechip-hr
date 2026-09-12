// GET /api/candidates/[id]/script — what to say on this call.
//
// Always returns a usable script. The deterministic one is built first and
// returned whatever happens; AI, if configured, rewrites the talking parts and
// the rest is left alone. The response says which you got and, when AI was
// tried and failed, why — a recruiter should never be left wondering whether
// the app is broken or simply not switched on.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability, can } from "@/lib/auth";
import { buildScript } from "@/lib/callScript";
import { screen } from "@/lib/screening";
import { complete, SCRIPT_SYSTEM } from "@/lib/ai";
import { getSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req, { params }) {
  const gate = await requireCapability("candidate.read");
  if (!gate.ok) return gate.response;

  try {
    const candidate = await prisma.candidate.findUnique({
      where: { id: params?.id },
      include: { requirement: { include: { client: { select: { name: true } } } } },
    });
    if (!candidate) return NextResponse.json({ error: "No such candidate." }, { status: 404 });

    if (!can(gate.user.role, "report.desk") && candidate.ownerId && candidate.ownerId !== gate.user.id) {
      return NextResponse.json({ error: "This candidate belongs to another recruiter." }, { status: 403 });
    }
    if (!candidate.requirement) {
      return NextResponse.json(
        { error: "Match this candidate to an opening first — a script needs a role to talk about." },
        { status: 400 }
      );
    }

    const settings = await getSettings();
    const requirement = { ...candidate.requirement, clientName: candidate.requirement.client?.name };
    const input = { candidate, requirement, recruiter: gate.user, company: settings.companyName };

    const script = buildScript(input);
    const screening = screen(candidate, requirement);

    // AI is an enhancement pass, and only when asked for. The default load of
    // this endpoint costs nothing and waits for nothing.
    const wantAi = new URL(req.url).searchParams.get("ai") === "1";
    if (!wantAi) {
      return NextResponse.json({ script, screening, aiAvailable: !!(settings.aiEnabled && settings.aiApiKey) });
    }

    const facts = [
      `Candidate: ${candidate.name}`,
      candidate.designation && `Currently: ${candidate.designation}`,
      candidate.expMonths != null && `Experience: ${candidate.expMonths} months`,
      candidate.location && `Lives in: ${candidate.location}`,
      candidate.currentCtc != null && `Current monthly take-home: Rs ${candidate.currentCtc}`,
      candidate.expectedCtc != null && `Expecting: Rs ${candidate.expectedCtc}`,
      candidate.noticeDays != null && `Notice period: ${candidate.noticeDays} days`,
      candidate.education && `Qualification: ${candidate.education}`,
      "",
      `Role: ${requirement.designation}`,
      requirement.clientName && `Client: ${requirement.clientName}`,
      `Location: ${requirement.location}`,
      requirement.takeHomeMin != null && `Pay from: Rs ${requirement.takeHomeMin} monthly take-home`,
      requirement.takeHomeMax != null && `Pay up to: Rs ${requirement.takeHomeMax} monthly take-home`,
      requirement.shift && `Shift: ${requirement.shift}`,
      requirement.domain && `Work: ${requirement.domain}`,
      requirement.relievingRequired && `MUST have a relieving letter`,
      requirement.arrearsAllowed === false && `MUST have no arrears or backlogs`,
      requirement.educationMin && `Qualification required: ${requirement.educationMin}`,
      requirement.cabFacility !== "none" && `Cab provided: ${requirement.cabFacility}`,
      "",
      screening.blockers.length
        ? `This client will REFUSE this candidate because: ${screening.blockers.map((b) => b.label).join("; ")}`
        : null,
      screening.unknowns.length
        ? `Still unknown: ${screening.unknowns.map((u) => u.label).join("; ")}`
        : null,
    ].filter(Boolean).join("\n");

    const ai = await complete({
      system: SCRIPT_SYSTEM,
      prompt: `${facts}

Write, using only the facts above:

OPENING
Two lines the recruiter says to start the call.

PITCH
Three or four short lines, strongest true point first for THIS candidate.

ASK
The questions still worth asking, most important first.

OBJECTIONS
Three likely objections from this specific candidate, each with a reply that
concedes what is true before it answers.`,
    });

    if (!ai.ok) {
      // The built-in script is already in hand. Hand it over with the reason,
      // rather than an error the recruiter can do nothing about.
      return NextResponse.json({
        script,
        screening,
        aiAvailable: !!(settings.aiEnabled && settings.aiApiKey),
        aiError: ai.reason,
      });
    }

    return NextResponse.json({
      script: { ...script, ai: ai.text, source: "ai" },
      screening,
      aiAvailable: true,
    });
  } catch (e) {
    console.error("[GET /api/candidates/[id]/script]", e?.message || e);
    return NextResponse.json({ error: "Could not build the script." }, { status: 500 });
  }
}
