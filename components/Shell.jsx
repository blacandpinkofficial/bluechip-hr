"use client";
// The chrome every signed-in page sits in.
//
// Nav items are filtered by capability, so a recruiter never sees a link to a
// screen that would refuse them. That is courtesy, not security — every route
// re-checks. But a menu full of doors that don't open is its own kind of bug.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

// Grouped, not a flat row. This was eighteen links in one horizontally
// scrolling strip — more than fits on a laptop, and on a phone the last third
// simply could not be reached without knowing to swipe a nav bar. Grouping is
// not decoration here; it is the difference between a menu and a scroll.
//
// The five groups are the five jobs somebody actually sits down to do. "Today"
// stays on its own at the front because it is the screen a recruiter opens
// first and returns to all morning.
const GROUPS = [
  { label: "Today", href: "/reminders", cap: "candidate.read" },
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
      { href: "/clients",      label: "Clients",      cap: "client.read" },
      { href: "/social",       label: "Post a job",   cap: "social.use" },
      { href: "/import",       label: "Import",       cap: "import.run" },
    ],
  },
  {
    label: "Money",
    cap: "payroll.own",
    items: [
      { href: "/invoices",     label: "Invoices",     cap: "revenue.read" },
      { href: "/payroll",      label: "Payroll",      cap: "payroll.own" },
      { href: "/attendance",   label: "Attendance",   cap: "attendance.own" },
    ],
  },
  {
    label: "Desk",
    cap: null,
    items: [
      { href: "/dashboard",    label: "Dashboard",    cap: null },
      { href: "/reports",      label: "Reports",      cap: "report.own" },
      { href: "/knowledge",    label: "Knowledge",    cap: "candidate.read" },
      { href: "/chat",         label: "Chat",         cap: "chat.use" },
      { href: "/users",        label: "Team",         cap: "user.read" },
      { href: "/settings",     label: "Settings",     cap: null },
    ],
  },
];

export default function Shell({ children, title, subtitle, actions }) {
  const pathname = usePathname();
  const [me, setMe] = useState(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive && j) setMe(j); })
      .catch(() => {});
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
                  <div className="text-[11px] text-slate-500 capitalize">{me.user.role}</div>
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
            {visible.map((g) => {
              if (!g.items) {
                const active = pathname === g.href;
                return (
                  <Link
                    key={g.href}
                    href={g.href}
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
              const active = g.items.some(
                (n) => pathname === n.href || pathname.startsWith(n.href + "/")
              );
              const open = openGroup === g.label;
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
                      <div className="absolute left-0 top-full z-20 mt-px min-w-[12rem] rounded-b border border-slate-200 bg-white shadow-lg py-1">
                        {g.items.map((n) => {
                          const here = pathname === n.href || pathname.startsWith(n.href + "/");
                          return (
                            <Link
                              key={n.href}
                              href={n.href}
                              onClick={() => setOpenGroup(null)}
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
