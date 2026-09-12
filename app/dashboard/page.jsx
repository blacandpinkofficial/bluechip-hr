import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession, can } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import Shell from "@/components/Shell";

export const dynamic = "force-dynamic";

async function counts() {
  // Every figure here is a count of rows, not a stored total. That is the whole
  // design: the "Daily productivity" tab of the old workbook was typed out by
  // hand every evening, and every number on it was already knowable.
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [openReqs, openings, candidates, callsToday, interviewsToday, unbillable] =
    await Promise.all([
      prisma.requirement.count({ where: { status: "open" } }),
      prisma.requirement.aggregate({ where: { status: "open" }, _sum: { openings: true } }),
      prisma.candidate.count({ where: { archived: false } }),
      prisma.candidateCall.count({ where: { calledAt: { gte: today } } }),
      prisma.interview.count({ where: { scheduledAt: { gte: today } } }),
      // No terms on the opening AND none on the client — nothing to bill against.
      prisma.requirement.count({
        where: { status: "open", feeType: null, client: { feeType: null } },
      }),
    ]);

  return {
    openReqs,
    openings: openings._sum.openings || 0,
    candidates,
    callsToday,
    interviewsToday,
    unbillable,
  };
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

  const today = new Date().toLocaleDateString("en-IN", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  return (
    <Shell title="Today" subtitle={today}>
      {dbError ? (
        <div role="alert" className="card border-red-200 bg-red-50 p-4 text-sm text-red-800">
          Cannot reach the database: {dbError}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Tile label="Open requirements" value={c.openReqs} note={`${c.openings} positions to fill`} />
            <Tile label="Candidates" value={c.candidates} note="not archived" />
            <Tile label="Calls today" value={c.callsToday} note="counted, never typed" />
            <Tile label="Interviews today" value={c.interviewsToday} />
          </div>

          {c.unbillable > 0 && can(user.role, "client.fees") && (
            <Link
              href="/requirements"
              className="block card border-amber-200 bg-amber-50 p-4 mt-4 hover:bg-amber-100 transition"
            >
              <div className="text-sm text-amber-900">
                <b className="tabular-nums">{c.unbillable}</b> open requirement
                {c.unbillable === 1 ? " has" : "s have"} no commercials — neither on the
                opening nor on the client. A placement against{" "}
                {c.unbillable === 1 ? "it" : "them"} cannot be billed.
              </div>
            </Link>
          )}

          {c.openReqs === 0 && c.candidates === 0 && (
            <div className="card p-8 mt-6 text-center">
              <div className="text-chip-900 font-medium">Nothing in here yet.</div>
              <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
                Import the job description sheet and every client and opening in it
                lands here. You review it before anything is saved.
              </p>
              {can(user.role, "import.run") && (
                <Link href="/import" className="btn-primary mt-4 inline-flex">
                  Import the sheet
                </Link>
              )}
            </div>
          )}
        </>
      )}

      {can(user.role, "revenue.read") && (
        <div className="card p-5 mt-6 border-dashed">
          <div className="text-sm font-medium text-slate-600">
            Placements and revenue appear here once Phase D lands.
          </div>
          <div className="text-xs text-slate-400 mt-1">
            Only owners and managers ever see this panel.
          </div>
        </div>
      )}
    </Shell>
  );
}
