// GET /api/documents/[id]/file — download the attachment.
//
// Behind the session, deliberately: these are signed agreements and client
// process notes, and a guessable public URL for them is how a competitor reads
// your commercials.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/auth";
import { read } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req, { params }) {
  const gate = await requireCapability("candidate.read");
  if (!gate.ok) return gate.response;

  const doc = await prisma.document.findUnique({ where: { id: params?.id } });
  if (!doc || !doc.storageKey) {
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
