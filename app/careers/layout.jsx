// app/careers/layout.jsx — the chrome of the public site.
//
// Deliberately NOT components/Shell.jsx. Shell is the signed-in application:
// it fetches /api/auth/me, renders a capability-filtered menu and assumes a
// session. None of that belongs on a page served to the open internet, and
// importing it here would mean a stranger's browser calling an authenticated
// endpoint on every page load and a nav bar full of doors that 401.
//
// So this is a separate, much smaller shell: a header, a footer, two links.
// Nothing in this subtree reads a session, and nothing in it should.

import Link from "next/link";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const settings = await getSettings().catch(() => null);
  const company = settings?.companyName || "Blue Chip HR Solutions";
  return {
    title: {
      default: `Careers — ${company}`,
      template: `%s — ${company}`,
    },
    description:
      "Blue Chip HR Solutions is a recruitment consultancy in Chennai. " +
      "See current openings, or tell us who you are hiring.",
  };
}

export default async function CareersLayout({ children }) {
  const settings = await getSettings().catch(() => null);
  const company = settings?.companyName || "Blue Chip HR Solutions";
  const email = settings?.careersEmail || null;

  return (
    <div className="min-h-screen bg-white text-chip-900 flex flex-col">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto w-full max-w-5xl px-4 sm:px-6">
          <div className="flex h-16 items-center justify-between gap-3">
            <Link href="/careers" className="flex items-center gap-2.5 min-w-0">
              <span
                aria-hidden="true"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-chip-700 text-sm font-bold text-white"
              >
                BC
              </span>
              <span className="truncate text-sm font-semibold sm:text-base">Blue Chip HR</span>
            </Link>

            <nav className="flex items-center gap-1 sm:gap-2" aria-label="Careers">
              <Link
                href="/careers/jobs"
                className="rounded-md px-2.5 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-chip-800 sm:px-3"
              >
                Jobs
              </Link>
              <Link
                href="/careers/hire"
                className="rounded-md bg-chip-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-chip-700"
              >
                Hire with us
              </Link>
            </nav>
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="mt-16 border-t border-slate-200 bg-slate-50">
        <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
            <div className="max-w-sm">
              <div className="text-sm font-semibold">{company}</div>
              <p className="mt-2 text-sm text-slate-600">
                Recruitment and staffing, based in Chennai. We place people in
                BPO, healthcare RCM, customer support and back-office roles
                across Tamil Nadu and beyond.
              </p>
            </div>

            <div className="text-sm">
              <div className="font-semibold">Get in touch</div>
              <ul className="mt-2 space-y-1.5 text-slate-600">
                <li>
                  <Link href="/careers/jobs" className="hover:text-chip-700 hover:underline">
                    Current openings
                  </Link>
                </li>
                <li>
                  <Link href="/careers/hire" className="hover:text-chip-700 hover:underline">
                    Hiring? Tell us what you need
                  </Link>
                </li>
                {email && (
                  <li>
                    <a href={`mailto:${email}`} className="hover:text-chip-700 hover:underline">
                      {email}
                    </a>
                  </li>
                )}
              </ul>
            </div>
          </div>

          <p className="mt-8 border-t border-slate-200 pt-6 text-xs text-slate-500">
            We never charge candidates a fee. If anyone asks you to pay for a job
            in our name, it is not us — please tell us.
          </p>
        </div>
      </footer>
    </div>
  );
}
