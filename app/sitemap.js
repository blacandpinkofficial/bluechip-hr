// app/sitemap.js — the public URLs, and only the public ones.
//
// Google finds job postings far faster from a sitemap than by crawling, and a
// listing nobody can find is the same as no listing. Every URL here is one a
// signed-out stranger can open; nothing internal appears, by construction —
// the only database read is the same published-openings filter the job board
// itself uses.

import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";

export const revalidate = 3600;

const SITE = (process.env.PUBLIC_SITE_URL || "https://careers.blacandpink.com").replace(/\/+$/, "");

export default async function sitemap() {
  const settings = await getSettings().catch(() => null);

  const base = [
    { url: `${SITE}/careers`, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE}/careers/jobs`, changeFrequency: "daily", priority: 0.9 },
    { url: `${SITE}/careers/hire`, changeFrequency: "monthly", priority: 0.7 },
  ];

  // With the site switched off there is nothing to crawl but the shell, and
  // listing job URLs that answer 404 is how a sitemap loses Google's trust.
  if (!settings?.careersEnabled) return base;

  const jobs = await prisma.requirement
    .findMany({
      where: { status: "open", publishOnline: true },
      select: { id: true, openedAt: true },
      orderBy: { openedAt: "desc" },
      take: 1000,
    })
    .catch((e) => {
      console.error("[sitemap] job list failed:", e?.message || e);
      return [];
    });

  return base.concat(
    (Array.isArray(jobs) ? jobs : []).map((j) => ({
      url: `${SITE}/careers/jobs/${j.id}`,
      lastModified: j.openedAt || undefined,
      changeFrequency: "weekly",
      priority: 0.8,
    }))
  );
}
