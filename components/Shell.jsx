"use client";
// The chrome every signed-in page sits in.
//
// Nav items are filtered by capability, so a recruiter never sees a link to a
// screen that would refuse them. That is courtesy, not security — every route
// re-checks. But a menu full of doors that don't open is its own kind of bug.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const NAV = [
  { href: "/dashboard",    label: "Today",        cap: null },
  { href: "/candidates",   label: "Calls",        cap: "candidate.read" },
  { href: "/interviews",   label: "Interviews",   cap: "interview.read" },
  { href: "/requirements", label: "Requirements", cap: "requirement.read" },
  { href: "/clients",      label: "Clients",      cap: "client.read" },
  { href: "/placements",   label: "Placements",   cap: "report.own" },
  { href: "/reports",      label: "Reports",      cap: "report.own" },
  { href: "/import",       label: "Import",       cap: "import.run" },
  { href: "/users",        label: "Team",         cap: "user.read" },
  { href: "/settings",     label: "Settings",     cap: null },
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
  // Until /me answers, show only what everyone has. Better a menu that fills in
  // than one that flashes links and takes them away again.
  const visible = NAV.filter((n) => !n.cap || caps.includes(n.cap));

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
          <nav className="flex gap-1 -mb-px overflow-x-auto">
            {visible.map((n) => {
              const active = pathname === n.href || pathname.startsWith(n.href + "/");
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={
                    "px-3 py-2 text-sm border-b-2 whitespace-nowrap transition " +
                    (active
                      ? "border-chip-600 text-chip-800 font-medium"
                      : "border-transparent text-slate-500 hover:text-chip-700")
                  }
                >
                  {n.label}
                </Link>
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
