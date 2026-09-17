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
import { KINDS, documentScope, isConfidentialKind, visibleKinds } from "@/lib/documents";
import { pageParams, pageMeta } from "@/lib/paging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;


export async function GET(req) {
  const gate = await requireCapability("candidate.read");
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") || "";
  const q = (url.searchParams.get("q") || "").trim();
  const clientId = url.searchParams.get("client") || "";

  // Whether this person may see commercials decides both what comes back and
  // what the filter bar offers. Asking for kind=client without the capability
  // is not an error — the scope below simply has nothing matching it, the same
  // answer an empty shelf gives.
  const confidential = can(gate.user.role, "document.confidential");

  // AND, not a spread. documentScope() returns { kind: { notIn: [...] } } and
  // the filter below returns { kind: "client" } — the same key, so spreading
  // both into one object silently DELETED the guard and handed every scanned
  // agreement to anyone who thought to ask for ?kind=client. The filter a
  // visitor controls must narrow the scope, never replace it, and the only way
  // to guarantee that is to stop them sharing an object.
  const where = {
    AND: [
      { archived: false },
      documentScope(confidential),
      kind && KINDS.includes(kind) ? { kind } : {},
      clientId ? { clientId } : {},
      q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" } },
              { body: { contains: q, mode: "insensitive" } },
              { tags: { contains: q, mode: "insensitive" } },
              { filename: { contains: q, mode: "insensitive" } },
            ],
          }
        : {},
    ],
  };
  const { take, skip } = pageParams(url);

  const rows = await prisma.document.findMany({
    where,
    // id last — see the note in app/api/candidates/route.js.
    orderBy: [{ pinned: "desc" }, { createdAt: "desc" }, { id: "asc" }],
    take,
    skip,
    include: {
      author: { select: { id: true, name: true } },
      client: { select: { id: true, name: true } },
    },
  });

  const totalCount = await prisma.document.count({ where });

  return NextResponse.json({
    ...pageMeta({ take, skip, totalCount, rows }),
    documents: rows,
    kinds: visibleKinds(confidential),
    canArchive: can(gate.user.role, "candidate.delete"),
    canSeeConfidential: confidential,
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

      // Same guard as the upload branch below. A typed note filed as a client
      // agreement hides from the desk exactly as well as a PDF does, and this
      // branch had no check at all.
      if (isConfidentialKind(b.kind) && !can(gate.user.role, "document.confidential")) {
        return NextResponse.json(
          { error: "Only an owner or manager files a client agreement." },
          { status: 403 }
        );
      }

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
    // awaited — checkFile reads the file's first bytes. See lib/storage.js.
    const problem = await checkFile(file);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });

    const kind = String(form.get("kind") || "note");
    // Filing something as a client agreement is itself a commercial act, and
    // more to the point it decides who can read it afterwards. Someone who may
    // not READ that shelf must not be able to put a document on it — otherwise
    // the classification can be used to hide a file from the people above them.
    if (isConfidentialKind(kind) && !can(gate.user.role, "document.confidential")) {
      return NextResponse.json(
        { error: "Only an owner or manager files a client agreement." },
        { status: 403 }
      );
    }
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
