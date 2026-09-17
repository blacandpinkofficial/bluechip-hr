"use client";
// The chrome every signed-in page sits in.
//
// Nav items are filtered by capability, so a recruiter never sees a link to a
// screen that would refuse them. That is courtesy, not security — every route
// re-checks. But a menu full of doors that don't open is its own kind of bug.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
// Inert module — no prisma, no next/headers. Safe in a client component;
// lib/auth.js is not. See the note at the top of lib/roles.js.
import { roleName } from "@/lib/roles";

// Grouped, not a flat row. This was eighteen links in one horizontally
// scrolling strip — more than fits on a laptop, and on a phone the last third
// simply could not be reached without knowing to swipe a nav bar. Grouping is
// not decoration here; it is the difference between a menu and a scroll.
//
// The five groups are the five jobs somebody actually sits down to do. "Today"
// stays on its own at the front because it is the screen a recruiter opens
// first and returns to all morning.
//
// "Today" now points at /dashboard. The dashboard and the old /reminders screen
// were merged into one landing page, so there is exactly one entry for it here
// rather than a "Today" and a "Dashboard" that both opened the same thing —
// two names for one screen is how a menu stops being trusted. /reminders still
// exists and redirects, so old bookmarks land in the right place.

const GROUPS = [
  { label: "Today", href: "/dashboard", cap: "candidate.read" },
  {
    label: "Pipeline",
    cap: "candidate.read",
    items: [
      { href: "/candidates",   label: "Calls",        cap: "candidate.read" },
      { href: "/submissions",  label: "Submissions",  cap: "candidate.read" },
      { href: "/interviews",   label: "Interviews",   cap: "interview.read" },
      { href: "/placements",   label: "Placements",   cap: "report.own" },
    ],
  },
  {
    label: "Work",
    cap: "requirement.read",
    items: [
      { href: "/requirements", label: "Requirements", cap: "requirement.read" },
      { href: "/leads",        label: "Website leads", cap: "requirement.write" },
      { href: "/clients",      label: "Clients",      cap: "client.read" },
      { href: "/social",       label: "Post a job",   cap: "social.use" },
      { href: "/import",       label: "Import openings", cap: "import.run" },
      // A telecaller loads their own calling list; they do not import openings.
      // Two entries, two capabilities — see the note on import.* in lib/auth.js.
      { href: "/import/candidates", label: "Import candidates", cap: "import.candidates" },
    ],
  },
  {
    label: "Finance",
    cap: "payroll.own",
    items: [
      { href: "/invoices",     label: "Invoices",     cap: "revenue.read" },
      { href: "/payroll",      label: "Payroll",      cap: "payroll.own" },
      { href: "/payroll/setup", label: "Pay setup",   cap: "salary.write" },
      { href: "/attendance",   label: "Attendance",   cap: "attendance.own" },
    ],
  },
  {
    label: "Desk",
    cap: null,
    items: [
      // No "Dashboard" entry: it is the "Today" link at the front of this bar.
      // Settings below has no capability, so this group can never empty out.
      { href: "/reports",      label: "Reports",      cap: "report.own" },
      // The evening sheet. Sits under Reports, not beside it: /reports is the
      // trend and the funnel, this is one day read row by row. isOn() below
      // keeps the longer path from lighting both entries up at once.
      { href: "/reports/daily", label: "Daily report", cap: "report.own" },
      { href: "/knowledge",    label: "Knowledge",    cap: "candidate.read" },
      { href: "/training",     label: "Practice",     cap: "training.use" },
      { href: "/chat",         label: "Chat",         cap: "chat.use" },
      { href: "/users",        label: "Team",         cap: "user.read" },
      { href: "/settings",     label: "Settings",     cap: null },
    ],
  },
];

/**
 * Is this nav entry the one the current page belongs to?
 *
 * The prefix test alone lit up BOTH "Payroll" and "Pay setup" on /payroll/setup,
 * because /payroll is a prefix of it. So a prefix match only counts when no
 * other entry in the group is a longer, better match for the same path.
 */
function isOn(pathname, href, siblings = []) {
  if (pathname === href) return true;
  if (!pathname.startsWith(href + "/")) return false;
  return !siblings.some(
    (s) => s.href !== href && s.href.length > href.length &&
      (pathname === s.href || pathname.startsWith(s.href + "/"))
  );
}

export default function Shell({ children, title, subtitle, actions }) {
  const pathname = usePathname();
  const [me, setMe] = useState(null);
  // "loading" | "ready" | "failed". It was a bare null before, which made a
  // failed /me indistinguishable from a slow one: the nav collapsed to the
  // handful of links that need no capability and simply stayed that way, so a
  // dropped connection looked exactly like being demoted. Nobody reports that
  // as a bug; they report that the app has lost half its menu.
  const [status, setStatus] = useState("loading");

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/me")
      .then(async (r) => {
        // 401 is not a failed check, it is an expired or revoked session, and
        // the two want opposite words. middleware.js only looks for the COOKIE,
        // never for a valid one, so a fortnight-old tab loads the page and
        // fails here — telling that person "reload and it comes back" is
        // telling them to do the one thing that cannot work. Send them to sign
        // in, keeping where they were so they land back on it.
        if (r.status === 401) {
          const next = window.location.pathname + window.location.search;
          window.location.href = `/login?next=${encodeURIComponent(next)}`;
          return null;
        }
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((j) => { if (alive && j) { setMe(j); setStatus("ready"); } })
      .catch(() => { if (alive) setStatus("failed"); });
    return () => { alive = false; };
  }, []);

  const caps = me?.capabilities || [];
  const allowed = (n) => !n.cap || caps.includes(n.cap);

  // Until /me answers, show only what everyone has. Better a menu that fills in
  // than one that flashes links and takes them away again. A group whose every
  // item is filtered out disappears with them rather than opening onto nothing.
  const visible = GROUPS
    .map((g) => (g.items ? { ...g, items: g.items.filter(allowed) } : g))
    .filter((g) => (g.items ? g.items.length > 0 : allowed(g)));

  const [openGroup, setOpenGroup] = useState(null);
  useEffect(() => setOpenGroup(null), [pathname]);

  // Escape closes it. An open menu could only be dismissed by picking something
  // or by clicking the invisible sheet behind it — fine with a mouse, nothing
  // at all from the keyboard, where the menu became a trap you tabbed through
  // to the end of.
  useEffect(() => {
    if (!openGroup) return;
    const onKey = (e) => { if (e.key === "Escape") setOpenGroup(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openGroup]);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-6xl mx-auto px-6">
          <div className="flex items-center justify-between gap-4 py-3">
            <Link href="/dashboard" className="leading-tight">
              <div className="font-bold text-chip-800">Blue Chip HR</div>
              <div className="text-[11px] text-slate-500">Solutions Pvt. Ltd.</div>
            </Link>
            <div className="flex items-center gap-4">
              {me?.user && (
                <div className="text-right leading-tight hidden sm:block">
                  <div className="text-sm font-medium">{me.user.name}</div>
                  <div className="text-[11px] text-slate-500">{roleName(me.user.role)}</div>
                </div>
              )}
              <form action="/api/auth/logout" method="post">
                <button className="text-xs text-slate-500 hover:text-chip-700 underline underline-offset-2">
                  Sign out
                </button>
              </form>
            </div>
          </div>
          <nav className="flex gap-1 -mb-px">
            {visible.map((g, gi) => {
              const isLast = gi === visible.length - 1;
              if (!g.items) {
                const active = pathname === g.href;
                return (
                  <Link
                    key={g.href}
                    href={g.href}
                    aria-current={active ? "page" : undefined}
                    className={
                      "px-3 py-2 text-sm border-b-2 whitespace-nowrap transition " +
                      (active
                        ? "border-chip-600 text-chip-800 font-medium"
                        : "border-transparent text-slate-500 hover:text-chip-700")
                    }
                  >
                    {g.label}
                  </Link>
                );
              }
              const active = g.items.some((n) => isOn(pathname, n.href, g.items));
              const open = openGroup === g.label;
              // The rightmost group's panel opened leftwards from its button
              // and ran off the screen; on a narrow window "Settings" and
              // "Team" were simply not there. It opens rightwards from its own
              // right edge instead. Written as two whole class names — a
              // built-up one is invisible to Tailwind's scanner.
              const dropClass = isLast
                ? "absolute right-0 top-full z-20 mt-px min-w-[12rem] rounded-b border border-slate-200 bg-white shadow-lg py-1"
                : "absolute left-0 top-full z-20 mt-px min-w-[12rem] rounded-b border border-slate-200 bg-white shadow-lg py-1";
              return (
                <div key={g.label} className="relative">
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-haspopup="true"
                    onClick={() => setOpenGroup(open ? null : g.label)}
                    className={
                      "px-3 py-2 text-sm border-b-2 whitespace-nowrap transition " +
                      (active
                        ? "border-chip-600 text-chip-800 font-medium"
                        : "border-transparent text-slate-500 hover:text-chip-700")
                    }
                  >
                    {g.label}
                    <span className="text-[10px] ml-1 align-middle">▾</span>
                  </button>
                  {open && (
                    <>
                      {/* Catches the click that closes the menu. Without it the
                          only way out is to pick something. */}
                      <button
                        className="fixed inset-0 z-10 cursor-default"
                        aria-label="Close menu"
                        onClick={() => setOpenGroup(null)}
                      />
                      <div className={dropClass}>
                        {g.items.map((n) => {
                          const here = isOn(pathname, n.href, g.items);
                          return (
                            <Link
                              key={n.href}
                              href={n.href}
                              onClick={() => setOpenGroup(null)}
                              aria-current={here ? "page" : undefined}
                              className={
                                "block px-4 py-2 text-sm transition " +
                                (here
                                  ? "bg-chip-50 text-chip-900 font-medium"
                                  : "text-slate-600 hover:bg-slate-50 hover:text-chip-800")
                              }
                            >
                              {n.label}
                            </Link>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </nav>
        </div>
        {status === "failed" && (
          // Not a toast and not a console line: the menu above is visibly
          // short, and this is the sentence that explains why.
          <div role="status" className="bg-amber-50 border-t border-amber-200">
            <div className="max-w-6xl mx-auto px-6 py-2 text-xs text-amber-900 flex items-center gap-3">
              <span>
                Couldn&rsquo;t check what you have access to, so the menu is showing less than usual.
                Nothing is lost — reload and it comes back.
              </span>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="underline underline-offset-2 hover:text-amber-950 shrink-0"
              >
                Reload
              </button>
            </div>
          </div>
        )}
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-6 py-7">
        {(title || actions) && (
          <div className="flex items-start justify-between gap-4 mb-6">
            <div>
              {title && <h1 className="text-2xl font-semibold text-chip-900">{title}</h1>}
              {subtitle && <p className="text-sm text-slate-500 mt-1 max-w-prose">{subtitle}</p>}
            </div>
            {actions && <div className="flex gap-2 shrink-0">{actions}</div>}
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
