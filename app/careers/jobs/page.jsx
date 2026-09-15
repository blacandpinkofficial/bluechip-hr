// app/careers/jobs — the job board.
//
// Server-rendered and searched with a plain GET form, so it works with
// JavaScript off, every listing has a real URL a candidate can send to a
// friend, and Google can crawl the whole board without running anything.
//
// The query is an ALLOW-LIST of columns, not a row with the dangerous parts
// removed. Requirement carries feeType, feeBps and feeFlat — what the client
// pays Blue Chip — and the way to guarantee those never reach a public page is
// to never fetch them. A filter forgets a column the day someone adds one; a
// select cannot.

import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { payLine, expLine, shiftLabel, cabLabel } from "../format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Current openings",
  description:
    "Live vacancies from Blue Chip HR Solutions — BPO, healthcare RCM, " +
    "customer support and back-office roles, with pay and shift stated up front.",
};

// Exactly what a stranger may see about an opening. Nothing else is read.
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
  relievingRequired: true,
  arrearsAllowed: true,
  cabFacility: true,
  openedAt: true,
  // The client's NAME, and nothing else about them. A candidate needs to know
  // who they would be working for; the HR contact, the credit period and the
  // commercials are not on this list and so are never loaded.
  client: { select: { name: true } },
};

export default async function JobBoard({ searchParams }) {
  const settings = await getSettings().catch(() => null);
  if (!settings?.careersEnabled) return <Closed />;

  // Both are cut to 80 characters before they touch a query. Prisma
  // parameterises the value either way, so this is about bounding the work the
  // database is asked to do, not about escaping.
  const q = String(searchParams?.q || "").trim().slice(0, 80);
  const location = String(searchParams?.location || "").trim().slice(0, 80);

  let jobs = [];
  let locations = [];
  let failed = false;
  try {
    jobs = await prisma.requirement.findMany({
      where: {
        status: "open",
        publishOnline: true,
        ...(location ? { location: { contains: location, mode: "insensitive" } } : {}),
        ...(q
          ? {
              OR: [
                { designation: { contains: q, mode: "insensitive" } },
                { domain: { contains: q, mode: "insensitive" } },
                { processDetail: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: [{ priority: "desc" }, { openedAt: "desc" }],
      take: 100,
      select: PUBLIC_JOB_FIELDS,
    });

    const all = await prisma.requirement.findMany({
      where: { status: "open", publishOnline: true },
      select: { location: true },
      take: 200,
    });
    locations = [...new Set(all.map((r) => r.location).filter(Boolean))].sort();
  } catch (e) {
    console.error("[careers/jobs]", e?.message || e);
    failed = true;
  }

  const rows = Array.isArray(jobs) ? jobs : [];
  const locs = Array.isArray(locations) ? locations : [];
  const filtered = !!(q || location);

  return (
    <>
      <section className="border-b border-slate-200 bg-chip-800 text-white">
        <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Current openings</h1>
          <p className="mt-3 max-w-2xl text-chip-100">
            Every listing states the pay, the shift and the conditions before you
            apply. Applying is free and takes a minute.
          </p>
        </div>
      </section>

      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
        {/* A plain GET form. No JavaScript, and every result set has a URL. */}
        <form method="get" action="/careers/jobs" className="flex flex-col gap-2 sm:flex-row">
          <div className="flex-1">
            <label htmlFor="q" className="sr-only">
              Search role or skill
            </label>
            <input
              id="q"
              name="q"
              type="search"
              defaultValue={q}
              placeholder="Search role or skill — AR caller, voice process…"
              maxLength={80}
              className="input"
            />
          </div>
          <div className="sm:w-56">
            <label htmlFor="location" className="sr-only">
              Location
            </label>
            <select id="location" name="location" defaultValue={location} className="input">
              <option value="">All locations</option>
              {locs.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn-primary sm:w-auto">
            Search
          </button>
          {filtered && (
            <Link href="/careers/jobs" className="btn-ghost sm:w-auto">
              Clear
            </Link>
          )}
        </form>

        <p className="mt-5 text-sm text-slate-500" aria-live="polite">
          {failed
            ? "We could not load the openings just now. Please try again in a moment."
            : `${rows.length} opening${rows.length === 1 ? "" : "s"}${filtered ? " match your search" : ""}.`}
        </p>

        {rows.length === 0 && !failed ? (
          <div className="mt-6 rounded-lg border border-slate-200 bg-slate-50 p-10 text-center">
            <p className="text-slate-600">
              {filtered
                ? "Nothing matches that search right now."
                : "No openings are listed publicly at the moment."}
            </p>
            <p className="mt-2 text-sm text-slate-500">
              Send us your details anyway — most of our roles are filled before
              they reach a job board.
            </p>
            <Link href="/careers/jobs" className="btn-ghost mt-5">
              See all openings
            </Link>
          </div>
        ) : (
          <ul className="mt-6 space-y-3">
            {rows.map((j) => (
              <li key={j.id}>
                <JobCard job={j} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function JobCard({ job }) {
  const tags = [
    shiftLabel(job.shift),
    job.processType ? titleCase(job.processType) : null,
    cabLabel(job.cabFacility),
  ].filter(Boolean);

  return (
    <article className="rounded-lg border border-slate-200 bg-white p-5 transition hover:border-chip-300 hover:shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold leading-snug text-chip-900">
            <Link href={`/careers/jobs/${job.id}`} className="hover:underline">
              {job.designation}
            </Link>
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            {[job.client?.name, job.location].filter(Boolean).join(" · ")}
          </p>
        </div>
        <Link href={`/careers/jobs/${job.id}`} className="btn-primary shrink-0">
          View &amp; apply
        </Link>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Take home</dt>
          <dd className="mt-0.5 font-medium text-chip-900">{payLine(job)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Experience</dt>
          <dd className="mt-0.5 text-chip-900">{expLine(job)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Openings</dt>
          <dd className="mt-0.5 text-chip-900">{job.openings}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Location</dt>
          <dd className="mt-0.5 text-chip-900">{job.location}</dd>
        </div>
      </dl>

      {(tags.length > 0 || job.relievingRequired || job.arrearsAllowed === false) && (
        <div className="mt-4 flex flex-wrap gap-1.5 border-t border-slate-100 pt-3">
          {job.relievingRequired && (
            <span className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-900">
              Relieving letter required
            </span>
          )}
          {job.arrearsAllowed === false && (
            <span className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-900">
              No arrears or backlogs
            </span>
          )}
          {tags.map((t) => (
            <span
              key={t}
              className="rounded border border-slate-300 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-700"
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

function Closed() {
  return (
    <div className="mx-auto w-full max-w-lg px-4 py-24 text-center sm:px-6">
      <h1 className="text-2xl font-semibold">No openings listed just now</h1>
      <p className="mt-3 text-slate-600">
        Our job board is not live at the moment. Please check back soon.
      </p>
      <Link href="/careers" className="btn-ghost mt-6">
        Back to Blue Chip HR
      </Link>
    </div>
  );
}

function titleCase(s) {
  const x = String(s || "").trim();
  if (!x) return "";
  return x.charAt(0).toUpperCase() + x.slice(1);
}
