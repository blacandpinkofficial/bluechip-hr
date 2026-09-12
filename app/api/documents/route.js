// /api/documents — the knowledge base.
//
// Client process notes, handovers before someone goes on leave, training
// material, scanned agreements. Everyone on the desk can add and read; only
// managers and owners can archive, because a handover note deleted by the
// person who wrote it is exactly the note somebody needed.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability, can } from "@/lib/auth";
import { checkFile, save } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const KINDS = ["note", "handover", "process", "training", "client", "policy"];

export async function GET(req) {
  const gate = await requireCapability("candidate.read");
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") || "";
  const q = (url.searchParams.get("q") || "").trim();
  const clientId = url.searchParams.get("client") || "";

  const rows = await prisma.document.findMany({
    where: {
      archived: false,
      ...(kind && KINDS.includes(kind) ? { kind } : {}),
      ...(clientId ? { clientId } : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" } },
              { body: { contains: q, mode: "insensitive" } },
              { tags: { contains: q, mode: "insensitive" } },
              { filename: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
    take: 200,
    include: {
      author: { select: { id: true, name: true } },
      client: { select: { id: true, name: true } },
    },
  });

  return NextResponse.json({
    documents: rows,
    kinds: KINDS,
    canArchive: can(gate.user.role, "candidate.delete"),
  });
}

export async function POST(req) {
  const gate = await requireCapability("candidate.write");
  if (!gate.ok) return gate.response;

  try {
    const type = req.headers.get("content-type") || "";

    // A typed note or handover — no file involved.
    if (type.includes("application/json")) {
      const b = await req.json().catch(() => ({}));
      const title = String(b.title || "").trim();
      const body = String(b.body || "").trim();
      if (!title) return NextResponse.json({ error: "Give it a title." }, { status: 400 });
      if (!body) return NextResponse.json({ error: "There is nothing written in it." }, { status: 400 });

      const doc = await prisma.document.create({
        data: {
          title: title.slice(0, 200),
          body: body.slice(0, 50000),
          kind: KINDS.includes(b.kind) ? b.kind : "note",
          tags: String(b.tags || "").trim().slice(0, 300) || null,
          clientId: b.clientId || null,
          authorId: gate.user.id,
        },
        include: { author: { select: { name: true } } },
      });
      return NextResponse.json({ document: doc }, { status: 201 });
    }

    // An upload.
    const form = await req.formData();
    const file = form.get("file");
    const problem = checkFile(file);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });

    const kind = String(form.get("kind") || "note");
    const key = await save(file);

    const doc = await prisma.document.create({
      data: {
        title: String(form.get("title") || file.name || "Untitled").trim().slice(0, 200),
        kind: KINDS.includes(kind) ? kind : "note",
        storageKey: key,
        filename: String(file.name || "").slice(0, 200),
        mimeType: file.type || null,
        bytes: file.size,
        tags: String(form.get("tags") || "").trim().slice(0, 300) || null,
        clientId: String(form.get("clientId") || "") || null,
        authorId: gate.user.id,
      },
      include: { author: { select: { name: true } } },
    });

    await prisma.auditLog
      .create({
        data: {
          userId: gate.user.id, action: "create", entity: "Document", entityId: doc.id,
          summary: `Uploaded "${doc.title}" (${Math.round((doc.bytes || 0) / 1024)} KB)`,
        },
      })
      .catch((e) => console.error("[documents] audit write failed:", e?.message));

    return NextResponse.json({ document: doc }, { status: 201 });
  } catch (e) {
    console.error("[POST /api/documents]", e?.message || e);
    return NextResponse.json({ error: "Could not save that." }, { status: 500 });
  }
}
