// app/careers/jobs/[id] — one opening, and the form to apply for it.
//
// This is the page that has to earn its keep in Google. A job board nobody
// finds is a job board nobody uses, so it carries JobPosting structured data —
// and the rule that governs that markup is that it may only ever state what
// the page itself states. Google penalises structured data that contradicts
// the visible page, and rightly: the two disagreeing is how a listing claims a
// salary the page does not.
//
// So every field in the JSON-LD below is read from the same variables the
// markup above it renders, including the validity date, which is printed on
// the page precisely so that emitting it is honest.
//
// The database read is an allow-list, same as the board. feeType, feeBps and
// feeFlat are not on it, so they cannot leak from here even by accident.

import { cache } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import ApplyForm from "../../ApplyForm";
import {
  payLine,
  expLine,
  shiftLabel,
  cabLabel,
  longDate,
  isoDate,
  validThrough,
} from "../../format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Exactly what a stranger may see. Commercials are absent by construction.
const PUBLIC_JOB_FIELDS = {
  id: true,
  designation: true,
  domain: true,
  processType: true,
  processDetail: true,
  location: true,
  openings: true,
  shift: true,
  expMinMonths: true,
  expMaxMonths: true,
  takeHomeMin: true,
  takeHomeMax: true,
  educationMin: true,
  // docsRequired is deliberately NOT here. It is a recruiter's free-text
  // checklist and has never been published; /api/public/jobs does not
  // return it either. Two public surfaces showing different fields is how
  // one of them ends up showing something nobody meant to publish.
  relievingRequired: true,
  arrearsAllowed: true,
  cabFacility: true,
  openedAt: true,
  client: { select: { name: true } },
};

// Wrapped in React's cache so generateMetadata and the page itself share one
// query per request instead of asking the database the same question twice.
const loadJob = cache(async (id) => {
  const clean = String(id || "").slice(0, 40);
  if (!clean) return null;
  try {
    return await prisma.requirement.findFirst({
      // status and publishOnline are part of the WHERE, not checked afterwards.
      // An unpublished or closed opening is not "found and then hidden"; it is
      // not found, and the page 404s exactly as it would for a made-up id.
      where: { id: clean, status: "open", publishOnline: true },
      select: PUBLIC_JOB_FIELDS,
    });
  } catch (e) {
    console.error("[careers/jobs/:id]", e?.message || e);
    return null;
  }
});

export async function generateMetadata({ params }) {
  const settings = await getSettings().catch(() => null);
  if (!settings?.careersEnabled) return { title: "Openings" };

  const job = await loadJob(params?.id);
  if (!job) return { title: "Opening not found" };

  const where = job.location ? ` in ${job.location}` : "";
  return {
    title: `${job.designation}${where}`,
    description:
      `${job.designation}${where}. ${payLine(job)}. Experience: ${expLine(job)}. ` +
      "Apply through Blue Chip HR Solutions.",
  };
}

export default async function JobDetail({ params }) {
  const settings = await getSettings().catch(() => null);
  if (!settings?.careersEnabled) notFound();

  const job = await loadJob(params?.id);
  if (!job) notFound();

  const company = settings?.companyName || "Blue Chip HR Solutions";
  const clientName = job.client?.name || null;
  const employer = clientName || company;

  const posted = longDate(job.openedAt);
  const validUntilDate = validThrough(job.openedAt);
  const validUntil = longDate(validUntilDate);

  const pay = payLine(job);
  const experience = expLine(job);
  const shift = shiftLabel(job.shift);
  const cab = cabLabel(job.cabFacility);

  const conditions = [];
  if (job.relievingRequired) {
    conditions.push("A relieving letter from your current or previous employer is required.");
  }
  if (job.arrearsAllowed === false) {
    conditions.push("No standing arrears or backlogs.");
  }
  if (job.educationMin) conditions.push(`Qualification: ${job.educationMin}.`);

  const jsonLd = buildJobPosting({
    job,
    employer,
    company,
    pay,
    experience,
    conditions,
    validUntilDate,
  });

  return (
    <>
      {/* Structured data. JSON.stringify then escape the three characters that
          could close this script tag early — see safeJsonLd below. */}
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: safeJsonLd(jsonLd) }}
      />

      <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 sm:py-10">
        <nav aria-label="Breadcrumb" className="text-sm">
          <Link href="/careers/jobs" className="text-chip-600 hover:underline">
            &larr; All openings
          </Link>
        </nav>

        <header className="mt-5">
          <h1 className="text-2xl font-bold leading-tight tracking-tight sm:text-3xl">
            {job.designation}
          </h1>
          <p className="mt-2 text-slate-600">
            {[employer, job.location].filter(Boolean).join(" · ")}
          </p>

          <div className="mt-4 flex flex-wrap gap-1.5">
            {shift && <Tag>{shift}</Tag>}
            {job.processType && <Tag>{titleCase(job.processType)}</Tag>}
            <Tag>Full time</Tag>
            {cab && <Tag tone="good">{cab}</Tag>}
            {job.openings > 1 && <Tag>{job.openings} positions</Tag>}
          </div>
        </header>

        <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_20rem]">
          <div className="min-w-0">
            <dl className="grid grid-cols-1 gap-4 rounded-lg border border-slate-200 bg-slate-50 p-5 sm:grid-cols-3">
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Take home</dt>
                <dd className="mt-1 font-semibold text-chip-900">{pay}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Experience</dt>
                <dd className="mt-1 font-medium text-chip-900">{experience}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Location</dt>
                <dd className="mt-1 font-medium text-chip-900">{job.location}</dd>
              </div>
            </dl>

            <section className="mt-8">
              <h2 className="text-lg font-semibold">About the role</h2>
              <div className="mt-3 space-y-3 text-sm leading-relaxed text-slate-700">
                <p>
                  {employer} {clientName ? "is hiring" : "is recruiting"} for{" "}
                  {job.openings > 1 ? `${job.openings} ${job.designation} positions` : `a ${job.designation}`}{" "}
                  in {job.location}.
                  {job.domain ? ` The work sits in ${job.domain}.` : ""}
                </p>
                {job.processDetail && <p>{job.processDetail}</p>}
                {job.processType && (
                  <p>
                    This is a {job.processType} process
                    {shift ? `, on a ${shift.toLowerCase()} shift` : ""}.
                    {cab ? ` Transport is provided — ${cab.toLowerCase()}.` : ""}
                  </p>
                )}
              </div>
            </section>

            {conditions.length > 0 && (
              <section className="mt-8">
                <h2 className="text-lg font-semibold">Before you apply</h2>
                <p className="mt-2 text-sm text-slate-600">
                  These are the client&rsquo;s conditions. They are stated here so
                  you find out now rather than in week two.
                </p>
                <ul className="mt-3 space-y-2">
                  {conditions.map((c) => (
                    <li key={c} className="flex gap-2.5 text-sm leading-relaxed text-slate-700">
                      <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-chip-500" />
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="mt-8">
              <h2 className="text-lg font-semibold">Details</h2>
              <dl className="mt-3 divide-y divide-slate-100 border-y border-slate-100 text-sm">
                <Row label="Employment type" value="Full time" />
                <Row label="Openings" value={String(job.openings)} />
                {shift && <Row label="Shift" value={shift} />}
                {job.educationMin && <Row label="Qualification" value={job.educationMin} />}
                {posted && <Row label="Posted" value={posted} />}
                {validUntil && <Row label="Listing valid until" value={validUntil} />}
              </dl>
            </section>

            <p className="mt-8 rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs leading-relaxed text-slate-600">
              {company} never charges a candidate any fee at any stage. If
              anyone asks you to pay for this job, it is not us.
            </p>
          </div>

          <aside className="lg:sticky lg:top-24 lg:self-start">
            <div id="apply" className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold">Apply for this role</h2>
              <p className="mt-1 text-sm text-slate-600">
                A minute, and no account to create.
              </p>
              <ApplyForm requirementId={job.id} designation={job.designation} />
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}

// ── pieces ──────────────────────────────────────────────────────────────────

function Tag({ children, tone = "plain" }) {
  // Written out in full rather than composed from a variable. A Tailwind class
  // built at runtime is a class Tailwind's scanner never saw and never emitted.
  const cls =
    tone === "good"
      ? "rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-800"
      : "rounded border border-slate-300 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-700";
  return <span className={cls}>{children}</span>;
}

function Row({ label, value }) {
  return (
    <div className="flex justify-between gap-6 py-2.5">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-medium text-chip-900">{value}</dd>
    </div>
  );
}

function titleCase(s) {
  const x = String(s || "").trim();
  if (!x) return "";
  return x.charAt(0).toUpperCase() + x.slice(1);
}

// ── structured data ─────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * JobPosting.description is HTML, and it is built from the SAME facts rendered
 * above — the role, the process, the pay line, the experience band and the
 * client's conditions, in the same words. Anything the page does not say does
 * not appear here.
 */
function buildDescriptionHtml({ job, employer, pay, experience, conditions }) {
  const parts = [];
  const openings =
    job.openings > 1
      ? `${job.openings} ${escapeHtml(job.designation)} positions`
      : `a ${escapeHtml(job.designation)}`;

  parts.push(
    `<p>${escapeHtml(employer)} is hiring ${openings} in ${escapeHtml(job.location)}.` +
      (job.domain ? ` The work sits in ${escapeHtml(job.domain)}.` : "") +
      "</p>"
  );
  if (job.processDetail) parts.push(`<p>${escapeHtml(job.processDetail)}</p>`);

  const facts = [
    `Take home: ${escapeHtml(pay)}`,
    `Experience: ${escapeHtml(experience)}`,
    job.shift ? `Shift: ${escapeHtml(job.shift)}` : null,
    job.processType ? `Process: ${escapeHtml(job.processType)}` : null,
    // Qualification is not repeated here: when it is set it is already one of
    // the conditions below, and saying it twice in one description reads as
    // padding to a person and as nothing at all to a crawler.
  ].filter(Boolean);
  parts.push(`<ul>${facts.map((f) => `<li>${f}</li>`).join("")}</ul>`);

  if (conditions.length > 0) {
    parts.push(
      "<p>Before you apply:</p><ul>" +
        conditions.map((c) => `<li>${escapeHtml(c)}</li>`).join("") +
        "</ul>"
    );
  }
  return parts.join("");
}

function buildJobPosting({ job, employer, company, pay, experience, conditions, validUntilDate }) {
  const posting = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: job.designation,
    description: buildDescriptionHtml({ job, employer, pay, experience, conditions }),
    identifier: {
      "@type": "PropertyValue",
      name: company,
      value: job.id,
    },
    datePosted: isoDate(job.openedAt),
    // Full time everywhere on this desk, and the page says "Full time" in the
    // details table. If part-time roles ever appear, this must stop being a
    // constant before the page stops saying it.
    employmentType: "FULL_TIME",
    hiringOrganization: {
      "@type": "Organization",
      // The employer NAMED ON THE PAGE. Where an opening carries a client name
      // the page shows it, so the markup says the same; where it does not, both
      // say the agency. The two can never disagree because they read one value.
      name: employer,
    },
    jobLocation: {
      "@type": "Place",
      address: {
        "@type": "PostalAddress",
        addressLocality: job.location,
        addressCountry: "IN",
        // No addressRegion and no postalCode. The database stores a city and
        // nothing else, and inventing "Tamil Nadu" for a Bangalore opening
        // would be a false claim in markup Google reads literally.
      },
    },
    // The apply form is on this page, so the application really does start and
    // finish here.
    directApply: true,
  };

  if (job.openings > 0) posting.totalJobOpenings = job.openings;

  // Printed on the page as "Listing valid until", which is why it can be said
  // here. See LISTING_VALID_DAYS in ../../format.js.
  if (validUntilDate) posting.validThrough = validUntilDate.toISOString();

  // Only when there is a real figure. A baseSalary of zero, or a range the page
  // does not show, is worse than no baseSalary at all.
  const lo = job.takeHomeMin;
  const hi = job.takeHomeMax;
  if (lo != null || hi != null) {
    const value = { "@type": "QuantitativeValue", unitText: "MONTH" };
    if (lo != null && hi != null && lo !== hi) {
      value.minValue = lo;
      value.maxValue = hi;
    } else {
      value.value = lo != null ? lo : hi;
    }
    posting.baseSalary = {
      "@type": "MonetaryAmount",
      currency: "INR",
      value,
    };
  }

  if (job.educationMin) {
    posting.qualifications = job.educationMin;
  }
  if (job.expMinMonths != null) {
    posting.experienceRequirements = {
      "@type": "OccupationalExperienceRequirements",
      monthsOfExperience: job.expMinMonths,
    };
  }

  return posting;
}

/**
 * The one dangerous thing on this page.
 *
 * A designation, a domain or a process note is typed by a recruiter and ends up
 * inside a <script> block. JSON.stringify escapes quotes and backslashes but
 * NOT "</script>", so a value containing it would close the block early and
 * everything after it would be parsed as HTML. Escaping < and > as < and
 * > makes that impossible while leaving the JSON identical once parsed.
 * & is escaped for the same reason in a different parser, and U+2028/U+2029 are
 * escaped because they are valid in JSON and are line terminators in JavaScript.
 */
function safeJsonLd(obj) {
  // Built with fromCharCode rather than written out: U+2028 and U+2029 are
  // themselves line terminators in JavaScript source, so a regex literal
  // containing one does not survive being saved.
  const LINE_SEP = String.fromCharCode(0x2028);
  const PARA_SEP = String.fromCharCode(0x2029);
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .split(LINE_SEP)
    .join("\\u2028")
    .split(PARA_SEP)
    .join("\\u2029");
}
