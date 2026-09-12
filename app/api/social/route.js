// /api/social — writes the LinkedIn post; you press Post.
//
// Nothing here contacts LinkedIn. Automated posting and automated profile
// scraping both breach LinkedIn's terms, and the company account is worth more
// to this desk than the copy-paste it would save. So the app does the writing
// and the judgement; the publishing stays in a human's hands.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCapability } from "@/lib/auth";
import { linkedInPost, booleanSearch, shortPost } from "@/lib/social";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req) {
  const gate = await requireCapability("social.use");
  if (!gate.ok) return gate.response;
  const { user } = gate;

  const url = new URL(req.url);
  const requirementId = url.searchParams.get("requirementId");
  const style = url.searchParams.get("style") || "hiring";

  if (!requirementId) {
    // No requirement chosen yet: list the open ones so the screen can offer them.
    const open = await prisma.requirement.findMany({
      where: { status: { not: "closed" } },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { client: { select: { name: true, city: true } } },
    });
    return NextResponse.json({
      requirements: open.map((r) => ({
        id: r.id,
        designation: r.designation,
        location: r.location,
        openings: r.openings,
        client: r.client?.name,
        publishOnline: r.publishOnline,
      })),
    });
  }

  const req_ = await prisma.requirement.findUnique({
    where: { id: requirementId },
    include: { client: { select: { name: true, city: true } } },
  });
  if (!req_) return NextResponse.json({ error: "That opening does not exist." }, { status: 404 });

  const [settings, me] = await Promise.all([
    prisma.setting.findFirst().catch(() => null),
    prisma.user.findUnique({ where: { id: user.id }, select: { phone: true } }),
  ]);

  const post = linkedInPost(req_, {
    style,
    contactName: user.name,
    // The recruiter's own number, so replies reach the person who posted it.
    // Overridable by query for a desk number.
    contactPhone: url.searchParams.get("phone") || me?.phone || null,
    contactEmail: settings?.careersEmail || null,
    walkIn: url.searchParams.get("when")
      ? { when: url.searchParams.get("when"), where: url.searchParams.get("where") }
      : null,
  });

  return NextResponse.json({
    requirement: {
      id: req_.id,
      designation: req_.designation,
      location: req_.location,
      client: req_.client?.name,
      publishOnline: req_.publishOnline,
    },
    post,
    short: shortPost(req_, {}),
    search: booleanSearch(req_),
    // Said on every response, not buried in a help page: the client's name is
    // the thing most likely to be posted by accident, and it is the thing that
    // loses the account.
    notice: req_.publishOnline
      ? `This opening is marked publishable, so "${req_.client?.name}" appears in the post. Make sure they have agreed to that.`
      : "The client's name is left out. Turn on \"publish online\" for this opening only if the client has agreed to be named.",
  });
}
