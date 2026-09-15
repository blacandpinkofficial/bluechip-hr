// app/robots.js — what a crawler is allowed to look at.
//
// This app serves the office software AND the public careers site on the same
// Next instance, so the same hostname answers /login, /dashboard and /api as
// well as /careers. Every one of those is protected by the session check, but
// "protected" and "should be in Google's index" are different questions: an
// indexed /login page is a free advertisement of where the front door is, and
// an indexed /api/... URL is noise in Search Console forever.
//
// So: deny everything, then allow back only the public site.

const SITE = (process.env.PUBLIC_SITE_URL || "https://careers.blacandpink.com").replace(/\/+$/, "");

export default function robots() {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/careers", "/careers/"],
        disallow: ["/"],
      },
    ],
    sitemap: `${SITE}/sitemap.xml`,
  };
}
