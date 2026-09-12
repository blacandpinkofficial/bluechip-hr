import { redirect } from "next/navigation";
import { getSession, can } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

async function counts() {
  // Every figure here is a count of rows, not a stored total. That is the
  // whole design: the "Daily productivity" tab of the old workbook was typed
  // out by hand every evening, and every number on it was already knowable.
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [openReqs, candidates, callsToday, interviewsToday] = await Promise.all([
    prisma.requirement.count({ where: { status: "open" } }),
    prisma.candidate.count({ where: { archived: false } }),
    prisma.candidateCall.count({ where: { calledAt: { gte: today } } }),
    prisma.interview.count({ where: { scheduledAt: { gte: today } } }),
  ]);
  return { openReqs, candidates, callsToday, interviewsToday };
}

function Tile({ label, value, note }) {
  return (
    <div className="card p-5">
      <div className="text-3xl font-semibold tabular-nums text-chip-800">{value}</div>
      <div className="text-sm font-medium text-chip-900 mt-1">{label}</div>
      {note && <div className="text-xs text-slate-500 mt-0.5">{note}</div>}
    </div>
  );
}

export default async function Dashboard() {
  const session = await getSession();
  if (!session) redirect("/login");
  const { user } = session;

  let c = null;
  let dbError = null;
  try {
    c = await counts();
  } catch (e) {
    dbError = e?.message || "Database unreachable";
  }

  return (
    <main className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <div>
            <div className="font-bold text-chip-800">Blue Chip HR</div>
            <div className="text-xs text-slate-500">Solutions Pvt. Ltd.</div>
          </div>
          <div className="text-right">
            <div className="text-sm font-medium">{user.name}</div>
            <div className="text-xs text-slate-500 capitalize">{user.role}</div>
          </div>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-semibold">Today</h1>
        <p className="text-sm text-slate-500 mt-1 mb-6">
          {new Date().toLocaleDateString("en-IN", {
            weekday: "long", day: "numeric", month: "long", year: "numeric",
          })}
        </p>

        {dbError ? (
          <div className="card border-red-200 bg-red-50 p-4 text-sm text-red-800">
            Cannot reach the database: {dbError}
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Tile label="Open requirements" value={c.openReqs} />
            <Tile label="Candidates" value={c.candidates} note="not archived" />
            <Tile label="Calls today" value={c.callsToday} note="counted, not typed" />
            <Tile label="Interviews today" value={c.interviewsToday} />
          </div>
        )}

        <div className="card p-5 mt-8">
          <div className="font-medium">Phase A is live</div>
          <p className="text-sm text-slate-600 mt-2 max-w-prose">
            Sign-in, roles and the database are working, and this app has no path
            to any retail data — different application, different database,
            different Postgres login.
          </p>
          <p className="text-sm text-slate-600 mt-3 max-w-prose">
            Next: clients and requirements, imported from the existing job
            description sheet, then the recruiter&rsquo;s call screen.
          </p>
        </div>

        {can(user.role, "revenue.read") && (
          <div className="card p-5 mt-4 border-dashed">
            <div className="text-sm font-medium text-slate-600">
              Placements and revenue appear here once Phase D lands.
            </div>
            <div className="text-xs text-slate-400 mt-1">
              Only owners and managers ever see this panel.
            </div>
          </div>
        )}

        <form action="/api/auth/logout" method="post" className="mt-8">
          <button className="btn-ghost" type="submit">Sign out</button>
        </form>
      </div>
    </main>
  );
}
