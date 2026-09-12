// /api/chat — the desk talking to itself.
//
// Deliberately small. This is not a replacement for WhatsApp; it exists so that
// "did you call the AGS candidate back?" happens INSIDE the app, attached to
// the candidate, instead of in a personal chat that leaves with the person who
// owned the phone. Everything here is company correspondence and is visible to
// the owner — which is why the screen says so rather than implying privacy the
// app does not provide.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = 4000;

export async function GET(req) {
  const gate = await requireCapability("chat.use");
  if (!gate.ok) return gate.response;
  const { user } = gate;

  const url = new URL(req.url);
  const peer = url.searchParams.get("peer") || "desk"; // "desk" or a user id
  const limit = Math.min(200, Math.max(10, Number(url.searchParams.get("limit")) || 60));

  const where =
    peer === "desk"
      ? { toUserId: null, deletedAt: null }
      : {
          deletedAt: null,
          // Both directions of one conversation. Written as an explicit OR of
          // two exact pairs, not "author or recipient is the peer" — the loose
          // version also matches the peer's messages to somebody else.
          OR: [
            { authorId: user.id, toUserId: peer },
            { authorId: peer, toUserId: user.id },
          ],
        };

  const [messages, people, reads, unreadDesk] = await Promise.all([
    prisma.chatMessage.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { author: { select: { id: true, name: true, role: true } } },
    }),
    prisma.user.findMany({
      where: { active: true, id: { not: user.id } },
      select: { id: true, name: true, role: true },
      orderBy: { name: "asc" },
    }),
    prisma.chatRead.findMany({ where: { userId: user.id } }),
    prisma.chatMessage.count({ where: { toUserId: null, deletedAt: null } }),
  ]);

  const readAt = new Map(reads.map((r) => [r.peerKey, r.lastReadAt]));

  // Unread counts per conversation, computed here rather than in the browser
  // so every screen showing a badge shows the same number.
  const unread = {};
  const deskSince = readAt.get("desk");
  unread.desk = deskSince
    ? await prisma.chatMessage.count({
        where: { toUserId: null, deletedAt: null, createdAt: { gt: deskSince }, authorId: { not: user.id } },
      })
    : unreadDesk;

  const direct = await prisma.chatMessage.groupBy({
    by: ["authorId"],
    where: { toUserId: user.id, deletedAt: null },
    _max: { createdAt: true },
    _count: { _all: true },
  });
  for (const d of direct) {
    const since = readAt.get(d.authorId);
    unread[d.authorId] = since
      ? await prisma.chatMessage.count({
          where: { authorId: d.authorId, toUserId: user.id, deletedAt: null, createdAt: { gt: since } },
        })
      : d._count._all;
  }

  // Mark this conversation read now that it has been fetched.
  await prisma.chatRead.upsert({
    where: { userId_peerKey: { userId: user.id, peerKey: peer } },
    create: { userId: user.id, peerKey: peer, lastReadAt: new Date() },
    update: { lastReadAt: new Date() },
  }).catch(() => {});

  return NextResponse.json({
    peer,
    // Oldest first for reading; the query took the newest N.
    messages: messages.reverse(),
    people,
    unread,
    me: { id: user.id, name: user.name, role: user.role },
  });
}

export async function POST(req) {
  const gate = await requireCapability("chat.use");
  if (!gate.ok) return gate.response;
  const { user } = gate;

  const b = await req.json().catch(() => ({}));
  const body = String(b.body || "").trim();
  if (!body) return NextResponse.json({ error: "Nothing to send." }, { status: 400 });
  if (body.length > MAX_BODY) {
    return NextResponse.json({ error: `That is longer than ${MAX_BODY} characters — put it in Knowledge instead.` }, { status: 400 });
  }

  const to = b.toUserId ? String(b.toUserId) : null;
  if (to) {
    if (to === user.id) return NextResponse.json({ error: "You cannot message yourself." }, { status: 400 });
    const exists = await prisma.user.findFirst({ where: { id: to, active: true }, select: { id: true } });
    if (!exists) return NextResponse.json({ error: "That person is not on the desk." }, { status: 404 });
  }

  const refType = b.refType ? String(b.refType) : null;
  const REFS = ["candidate", "requirement", "client", "placement"];
  if (refType && !REFS.includes(refType)) {
    return NextResponse.json({ error: "Unknown attachment type." }, { status: 400 });
  }

  const row = await prisma.chatMessage.create({
    data: {
      authorId: user.id,
      toUserId: to,
      body,
      refType,
      refId: b.refId ? String(b.refId) : null,
    },
    include: { author: { select: { id: true, name: true, role: true } } },
  });

  return NextResponse.json({ message: row });
}

/** Soft delete, and only your own. body: { id } */
export async function DELETE(req) {
  const gate = await requireCapability("chat.use");
  if (!gate.ok) return gate.response;
  const { user } = gate;

  const b = await req.json().catch(() => ({}));
  const id = String(b.id || "");
  if (!id) return NextResponse.json({ error: "Which message?" }, { status: 400 });

  const row = await prisma.chatMessage.findUnique({ where: { id } });
  if (!row) return NextResponse.json({ error: "That message is already gone." }, { status: 404 });
  // A manager cannot delete someone else's message. Removing what a colleague
  // said, invisibly, is not a feature a desk should have.
  if (row.authorId !== user.id) {
    return NextResponse.json({ error: "You can only delete your own messages." }, { status: 403 });
  }

  await prisma.chatMessage.update({ where: { id }, data: { deletedAt: new Date() } });
  return NextResponse.json({ ok: true });
}
