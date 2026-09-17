// PATCH /api/documents/[id] — edit, pin, or archive.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability, can } from "@/lib/auth";
import { isConfidentialKind } from "@/lib/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req, { params }) {
  const gate = await requireCapability("candidate.write");
  if (!gate.ok) return gate.response;

  try {
    const doc = await prisma.document.findUnique({ where: { id: params?.id } });
    if (!doc) return NextResponse.json({ error: "No such document." }, { status: 404 });

    // The same shelf, the same door. Without this a recruiter cannot see a
    // client agreement but can still unpin, retitle or archive one by id.
    if (isConfidentialKind(doc.kind) && !can(gate.user.role, "document.confidential")) {
      return NextResponse.json({ error: "No such document." }, { status: 404 });
    }

    const b = await req.json().catch(() => ({}));
    const data = {};

    // The author can correct their own; a manager can correct anyone's.
    const mine = doc.authorId === gate.user.id;
    const senior = can(gate.user.role, "candidate.delete");

    if (b.title !== undefined || b.body !== undefined || b.tags !== undefined) {
      if (!mine && !senior) {
        return NextResponse.json(
          { error: "Only the author or a manager can edit this." },
          { status: 403 }
        );
      }
      if (b.title !== undefined && String(b.title).trim()) data.title = String(b.title).trim().slice(0, 200);
      if (b.body !== undefined) data.body = String(b.body || "").slice(0, 50000) || null;
      if (b.tags !== undefined) data.tags = String(b.tags || "").trim().slice(0, 300) || null;
    }

    if (b.pinned !== undefined) data.pinned = !!b.pinned;

    if (b.archived !== undefined) {
      // Archiving is a manager's call even for your own note. A handover note
      // removed by the person who wrote it is exactly the note someone needed.
      if (!senior) {
        return NextResponse.json(
          { error: "Only a manager or owner can archive a document." },
          { status: 403 }
        );
      }
      data.archived = !!b.archived;
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
    }

    const updated = await prisma.document.update({ where: { id: params.id }, data });
    return NextResponse.json({ document: updated });
  } catch (e) {
    console.error("[PATCH /api/documents/[id]]", e?.message || e);
    return NextResponse.json({ error: "Could not save the change." }, { status: 500 });
  }
}
