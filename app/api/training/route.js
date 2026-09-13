// /api/training — practice calls.
//
// The AI plays the candidate. The SCORE is computed here, from the transcript,
// by lib/training.js — never by the model. A model asked to mark its own
// role-play will give a different number for the same call twice, and a trainee
// who scores 6 on Monday and 8 on Tuesday for the same words learns only that
// the score is noise.
//
// With no AI key configured the drill still runs: lib/training.js has a scripted
// candidate whose replies are keyed to what the trainee asked. Less lifelike,
// exactly as instructive, and it means a desk that has not bought an API key
// still gets the training module.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability, can } from "@/lib/auth";
import { complete, aiReady } from "@/lib/ai";
import {
  PERSONAS, persona, scoreTranscript, headline, scriptedReply,
  candidatePrompt, CANDIDATE_SYSTEM, CHECKS,
} from "@/lib/training";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TURNS = 40;
const MAX_LEN = 1500;

export async function GET(req) {
  const gate = await requireCapability("training.use");
  if (!gate.ok) return gate.response;
  const { user } = gate;

  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  if (id) {
    const s = await prisma.trainingSession.findUnique({
      where: { id },
      include: { user: { select: { id: true, name: true } } },
    });
    if (!s) return NextResponse.json({ error: "That practice call no longer exists." }, { status: 404 });
    // Your own, always. Someone else's only if you may review — a training tool
    // people believe is being read is a training tool used once.
    if (s.userId !== user.id && !can(user.role, "training.review")) {
      return NextResponse.json({ error: "That is someone else's practice call." }, { status: 403 });
    }
    return NextResponse.json({ session: { ...s, turns: safeTurns(s.turnsJson), result: safeJson(s.resultJson) } });
  }

  const [mine, best] = await Promise.all([
    prisma.trainingSession.findMany({
      where: { userId: user.id },
      orderBy: { startedAt: "desc" },
      take: 20,
      select: { id: true, personaKey: true, score: true, percent: true, verdict: true, startedAt: true, finishedAt: true },
    }),
    // The board carries scores and names, not transcripts. Seeing that someone
    // else is improving is the useful part; reading their words is not.
    prisma.trainingSession.findMany({
      where: { finishedAt: { not: null } },
      orderBy: { percent: "desc" },
      take: 10,
      select: { id: true, percent: true, personaKey: true, finishedAt: true, user: { select: { id: true, name: true } } },
    }),
  ]);

  const done = mine.filter((s) => s.finishedAt);
  return NextResponse.json({
    personas: PERSONAS.map(({ key, name, difficulty, wins, trap }) => ({ key, name, difficulty, wins, trap })),
    checks: CHECKS.map(({ key, label, weight, why }) => ({ key, label, weight, why })),
    mine,
    best,
    aiReady: await aiReady(),
    canReview: can(user.role, "training.review"),
    // Improvement over the last five, which is the number a trainee cares about.
    trend: done.length >= 2
      ? {
          latest: done[0].percent,
          average: Math.round(done.slice(0, 5).reduce((s, x) => s + (x.percent || 0), 0) / Math.min(done.length, 5)),
          attempts: done.length,
        }
      : null,
  });
}

/**
 * body: { action: "start", personaKey }
 *       { action: "reply", id, text }
 *       { action: "finish", id }
 */
export async function POST(req) {
  const gate = await requireCapability("training.use");
  if (!gate.ok) return gate.response;
  const { user } = gate;

  const b = await req.json().catch(() => ({}));
  const action = String(b.action || "");

  // ── start ─────────────────────────────────────────────────────────────────
  if (action === "start") {
    const p = persona(String(b.personaKey || ""));
    const session = await prisma.trainingSession.create({
      data: {
        userId: user.id,
        personaKey: p.key,
        turnsJson: JSON.stringify([{ role: "candidate", text: p.opening, at: new Date().toISOString() }]),
      },
    });
    return NextResponse.json({
      session: { ...session, turns: safeTurns(session.turnsJson) },
      persona: { key: p.key, name: p.name, difficulty: p.difficulty, wins: p.wins, trap: p.trap },
    });
  }

  // ── reply ─────────────────────────────────────────────────────────────────
  if (action === "reply") {
    const text = String(b.text || "").trim().slice(0, MAX_LEN);
    if (!text) return NextResponse.json({ error: "Say something." }, { status: 400 });

    const session = await prisma.trainingSession.findUnique({ where: { id: String(b.id || "") } });
    if (!session) return NextResponse.json({ error: "That practice call no longer exists." }, { status: 404 });
    if (session.userId !== user.id) {
      return NextResponse.json({ error: "That is someone else's practice call." }, { status: 403 });
    }
    if (session.finishedAt) {
      return NextResponse.json({ error: "That call is already finished. Start a new one." }, { status: 409 });
    }

    const turns = safeTurns(session.turnsJson);
    if (turns.length >= MAX_TURNS) {
      return NextResponse.json({ error: "That is a long call. Finish it and see how you did." }, { status: 409 });
    }

    turns.push({ role: "trainee", text, at: new Date().toISOString() });

    const p = persona(session.personaKey);
    let reply;
    let usedAi = false;

    if (await aiReady()) {
      const out = await complete({
        system: CANDIDATE_SYSTEM,
        prompt: candidatePrompt({ persona: p, requirement: null, turns }),
      });
      if (out.ok && out.text) {
        // Trimmed hard. The model occasionally writes a paragraph; a candidate
        // on a phone does not, and letting it run makes the drill unrealistic
        // in the direction that flatters the trainee.
        reply = { text: String(out.text).trim().slice(0, 400) };
        usedAi = true;
      }
    }
    if (!reply) reply = scriptedReply({ persona: p, turns });

    turns.push({ role: "candidate", text: reply.text, at: new Date().toISOString() });

    await prisma.trainingSession.update({
      where: { id: session.id },
      data: { turnsJson: JSON.stringify(turns), aiUsed: session.aiUsed || usedAi },
    });

    return NextResponse.json({ reply: reply.text, turns, aiUsed: usedAi });
  }

  // ── finish ────────────────────────────────────────────────────────────────
  if (action === "finish") {
    const session = await prisma.trainingSession.findUnique({ where: { id: String(b.id || "") } });
    if (!session) return NextResponse.json({ error: "That practice call no longer exists." }, { status: 404 });
    if (session.userId !== user.id) {
      return NextResponse.json({ error: "That is someone else's practice call." }, { status: 403 });
    }

    const turns = safeTurns(session.turnsJson);
    const p = persona(session.personaKey);
    const result = scoreTranscript(turns, { persona: p });

    const saved = await prisma.trainingSession.update({
      where: { id: session.id },
      data: {
        score: result.score,
        percent: result.percent,
        verdict: result.verdict,
        resultJson: JSON.stringify(result),
        finishedAt: session.finishedAt || new Date(),
      },
    });

    return NextResponse.json({
      session: { ...saved, turns },
      result,
      headline: headline(result),
      // What the persona was actually testing, revealed only now. Showing it up
      // front would tell the trainee the answer.
      persona: { key: p.key, name: p.name, hidden: p.hidden, wins: p.wins, trap: p.trap },
    });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}

function safeTurns(json) {
  const v = safeJson(json);
  return Array.isArray(v) ? v : [];
}

function safeJson(json) {
  try {
    return JSON.parse(json || "null");
  } catch {
    return null;
  }
}
