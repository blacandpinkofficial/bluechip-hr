// GET /api/documents/[id]/file — download the attachment.
//
// Behind the session, deliberately: these are signed agreements and client
// process notes, and a guessable public URL for them is how a competitor reads
// your commercials.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability, can } from "@/lib/auth";
import { read } from "@/lib/storage";
import { isConfidentialKind } from "@/lib/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req, { params }) {
  const gate = await requireCapability("candidate.read");
  if (!gate.ok) return gate.response;

  // findFirst, not findUnique: findUnique's where accepts only the unique
  // columns, so the archived check cannot ride along on it.
  //
  // Archived documents were still served here. The list has filtered them out
  // since the first day, which is what made it easy to miss — the document
  // disappears from Knowledge and looks gone, while anyone who kept the URL,
  // or can guess an id from one they saw, keeps downloading it. Archiving is
  // meant to be an act, not a change of decoration.
  const doc = await prisma.document.findFirst({
    where: { id: params?.id, archived: false },
  });
  if (!doc || !doc.storageKey) {
    return NextResponse.json({ error: "No such file." }, { status: 404 });
  }

  // And the file itself is re-checked, not just the list it appears in. This
  // URL is reachable with nothing but an id, so a filter applied only when
  // drawing the list guards the shelf and leaves the door open. 404 rather
  // than 403: whether a particular agreement exists is itself the answer
  // somebody is fishing for.
  if (isConfidentialKind(doc.kind) && !can(gate.user.role, "document.confidential")) {
    return NextResponse.json({ error: "No such file." }, { status: 404 });
  }

  const buf = await read(doc.storageKey);
  if (!buf) {
    // The row exists and the file does not — worth saying so plainly rather
    // than a bare 404, because it means something went wrong on disk.
    console.error("[documents] missing file on disk:", doc.storageKey);
    return NextResponse.json(
      { error: "The record is here but the file is missing from the server." },
      { status: 410 }
    );
  }

  return new NextResponse(buf, {
    headers: {
      "Content-Type": doc.mimeType || "application/octet-stream",
      // inline for PDFs and images so they open in the browser; attachment for
      // anything else. Either way the filename is quoted and stripped of
      // anything that could break the header.
      "Content-Disposition": `${/^(application\/pdf|image\/)/.test(doc.mimeType || "") ? "inline" : "attachment"}; filename="${String(doc.filename || "file").replace(/[^\w.\- ]/g, "_")}"`,
      "Content-Length": String(buf.length),
      "Cache-Control": "private, no-store",
      // These are user-supplied files served from our origin; stop the browser
      // sniffing one into something executable.
      "X-Content-Type-Options": "nosniff",
    },
  });
}
