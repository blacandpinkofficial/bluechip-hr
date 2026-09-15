// app/careers — the front door of the public site.
//
// Two kinds of visitor arrive here and they want opposite things: someone
// looking for work, and someone looking for staff. The page does exactly one
// job, which is to tell them apart in the first screenful and send each to the
// right place. Everything below the two cards is supporting material.
//
// Server-rendered, no session, no client JavaScript on this page at all. It is
// the page Google will crawl first and the page that loads on a phone on a
// 3G connection in Guindy.

import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function CareersLanding() {
  const settings = await getSettings().catch(() => null);
  const enabled = !!settings?.careersEnabled;
  const intro = settings?.careersIntro || null;

  // One switch, one outcome. /careers/jobs, /careers/hire and every public API
  // route already refuse when this is off; a landing page that still renders
  // the company's shopfront and links into two closed pages means "off" does
  // not mean off. Whoever flips it is taking the site down, not dimming it.
  if (!enabled) return <CareersClosed />;

  // A count, not the rows. The landing page never needs an opening's details,
  // so it never loads them.
  let openCount = 0;
  let cities = [];
  if (enabled) {
    try {
      openCount = await prisma.requirement.count({
        where: { status: "open", publishOnline: true },
      });
      const rows = await prisma.requirement.findMany({
        where: { status: "open", publishOnline: true },
        select: { location: true },
        take: 200,
      });
      cities = [...new Set(rows.map((r) => r.location).filter(Boolean))].sort().slice(0, 8);
    } catch (e) {
      console.error("[careers] landing counts failed:", e?.message || e);
    }
  }

  return (
    <>
      {/* ── hero ───────────────────────────────────────────────────────── */}
      <section className="border-b border-slate-200 bg-gradient-to-b from-chip-50 to-white">
        <div className="mx-auto w-full max-w-5xl px-4 py-14 sm:px-6 sm:py-20">
          <p className="text-xs font-semibold uppercase tracking-widest text-chip-600">
            Chennai · Recruitment &amp; staffing
          </p>
          <h1 className="mt-3 text-3xl font-bold leading-tight tracking-tight sm:text-5xl">
            The right person for the role.
            <br className="hidden sm:block" />{" "}
            <span className="text-chip-600">Usually within the week.</span>
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-slate-600 sm:text-lg">
            {intro ||
              "Blue Chip HR Solutions recruits for BPO, healthcare RCM, customer support and back-office teams. We screen properly, we tell candidates the truth about the role, and we do not send a CV we have not spoken to."}
          </p>

          <div className="mt-9 grid gap-4 sm:grid-cols-2">
            <Link
              href="/careers/jobs"
              className="group rounded-xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-chip-300 hover:shadow-md"
            >
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                For candidates
              </div>
              <div className="mt-2 text-xl font-semibold text-chip-800">
                I&rsquo;m looking for a job
              </div>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">
                {enabled && openCount > 0
                  ? `${openCount} opening${openCount === 1 ? "" : "s"} listed right now, with the pay, the shift and the conditions stated up front.`
                  : "See what we are hiring for, with the pay, the shift and the conditions stated up front."}
              </p>
              <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-chip-600 group-hover:gap-2">
                See openings
                <span aria-hidden="true">&rarr;</span>
              </span>
            </Link>

            <Link
              href="/careers/hire"
              className="group rounded-xl border border-chip-200 bg-chip-700 p-6 text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-chip-800 hover:shadow-md"
            >
              <div className="text-xs font-semibold uppercase tracking-wider text-chip-200">
                For employers
              </div>
              <div className="mt-2 text-xl font-semibold">I&rsquo;m hiring</div>
              <p className="mt-2 text-sm leading-relaxed text-chip-100">
                Tell us the role, the experience band and the budget. A
                consultant reads every enquiry and calls you back — no bots, no
                automatic quote.
              </p>
              <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium group-hover:gap-2">
                Send us a requirement
                <span aria-hidden="true">&rarr;</span>
              </span>
            </Link>
          </div>
        </div>
      </section>

      {/* ── what we do ─────────────────────────────────────────────────── */}
      <section className="mx-auto w-full max-w-5xl px-4 py-14 sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight">What we recruit for</h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          {[
            {
              title: "Healthcare RCM",
              body: "AR calling, denials, charge entry, payment posting, medical coding. Voice and non-voice, from fresher intake to team lead.",
            },
            {
              title: "BPO & customer support",
              body: "Inbound and outbound voice, chat and email support, US and UK shifts, semi-voice process roles.",
            },
            {
              title: "Back office & support",
              body: "Data entry, verification, quality, MIS, HR and admin roles for growing operations teams.",
            },
          ].map((s) => (
            <div key={s.title} className="rounded-lg border border-slate-200 bg-white p-5">
              <div className="font-semibold text-chip-800">{s.title}</div>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{s.body}</p>
            </div>
          ))}
        </div>

        {cities.length > 0 && (
          <div className="mt-8">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Currently hiring in
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {cities.map((c) => (
                <Link
                  key={c}
                  href={`/careers/jobs?location=${encodeURIComponent(c)}`}
                  className="rounded-full border border-slate-300 bg-white px-3 py-1 text-sm text-slate-700 transition hover:border-chip-300 hover:bg-chip-50 hover:text-chip-800"
                >
                  {c}
                </Link>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ── how it works ───────────────────────────────────────────────── */}
      <section className="border-y border-slate-200 bg-slate-50">
        <div className="mx-auto w-full max-w-5xl px-4 py-14 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight">How it works</h2>

          <div className="mt-8 grid gap-10 sm:grid-cols-2">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-chip-600">
                If you are looking for work
              </div>
              <ol className="mt-4 space-y-4">
                {[
                  "Find a role and read the conditions — relieving letter, arrears, qualification, shift. They are on the page before you apply, not after.",
                  "Send your details. It takes a minute and we do not ask you to create an account.",
                  "A recruiter calls you. If you are not a fit for that role we will say so, and keep you in mind for the next one.",
                ].map((step, i) => (
                  <li key={step} className="flex gap-3">
                    <span
                      aria-hidden="true"
                      className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-chip-600 text-xs font-semibold text-white"
                    >
                      {i + 1}
                    </span>
                    <span className="text-sm leading-relaxed text-slate-600">{step}</span>
                  </li>
                ))}
              </ol>
              <p className="mt-5 text-sm font-medium text-chip-700">
                We never charge a candidate a rupee.
              </p>
            </div>

            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-chip-600">
                If you are hiring
              </div>
              <ol className="mt-4 space-y-4">
                {[
                  "Send the requirement — role, experience, budget, shift, location, and whatever else matters.",
                  "A consultant calls you to agree the brief and the terms. Nothing is quoted by a form.",
                  "We start sourcing, and you see screened profiles — people we have spoken to, not a keyword search.",
                ].map((step, i) => (
                  <li key={step} className="flex gap-3">
                    <span
                      aria-hidden="true"
                      className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-chip-600 text-xs font-semibold text-white"
                    >
                      {i + 1}
                    </span>
                    <span className="text-sm leading-relaxed text-slate-600">{step}</span>
                  </li>
                ))}
              </ol>
              <Link href="/careers/hire" className="btn-primary mt-5">
                Send us a requirement
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

/**
 * The whole public site, off.
 *
 * Deliberately says nothing about Blue Chip beyond the name, links nowhere
 * except the contact line, and offers no form. Its counterpart on
 * /careers/jobs is the same idea narrowed to the board.
 */
function CareersClosed() {
  return (
    <div className="mx-auto w-full max-w-lg px-4 py-24 text-center sm:px-6">
      <h1 className="text-2xl font-semibold">Blue Chip HR Solutions</h1>
      <p className="mt-3 text-slate-600">
        Our website is not live at the moment. Please check back soon.
      </p>
    </div>
  );
}
