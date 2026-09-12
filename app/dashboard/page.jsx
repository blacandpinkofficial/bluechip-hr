import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession, can } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveFee } from "@/lib/fees";
import Shell from "@/components/Shell";

export const dynamic = "force-dynamic";

async function counts() {
  // Every figure here is a count of rows, not a stored total. That is the whole
  // design: the "Daily productivity" tab of the old workbook was typed out by
  // hand every evening, and every number on it was already knowable.
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // "Which openings can't be billed?" is not a database filter — it is the
  // question resolveFee() already answers, and writing it a second time as a
  // Prisma `where` gives the rule two homes that will disagree the first time
  // the fee logic changes. So: fetch the open requirements with their client's
  // terms and let resolveFee decide. There are a hundred of these, not a
  // million; the clarity is worth more than the round trip saved.
  const [open, candidates, callsToday, interviewsToday] = await Promise.all([
    prisma.requirement.findMany({
      where: { status: "open" },
      select: {
        openings: true,
        feeType: true,
        feeBps: true,
        feeFlat: true,
        client: { select: { feeType: true, feeBps: true, feeFlat: true } },
      },
    }),
    prisma.candidate.count({ where: { archived: false } }),
    prisma.candidateCall.count({ where: { calledAt: { gte: today } } }),
    prisma.interview.count({ where: { scheduledAt: { gte: today } } }),
  ]);

  return {
    openReqs: open.length,
    openings: open.reduce((n, r) => n + (r.openings || 0), 0),
    candidates,
    callsToday,
    interviewsToday,
    unbillable: open.filter((r) => resolveFee(r, r.client).feeType == null).length,
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

  // A failed query is not an unreachable database, and saying so sends whoever
  // reads it looking in the wrong place. Check the connection separately, so
  // the screen can tell the difference between "Postgres is down" and "one of
  // my queries is wrong".
  let c = null;
  let dbDown = false;
  let queryError = null;
  try {
    c = await counts();
  } catch (e) {
    queryError = e?.message || String(e);
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      dbDown = true;
    }
  }

  const today = new Date().toLocaleDateString("en-IN", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  return (
    <Shell title="Today" subtitle={today}>
      {queryError ? (
        <div role="alert" className="card border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <div className="font-medium">
            {dbDown
              ? "The database is not responding."
              : "Today's figures could not be loaded."}
          </div>
          <p className="mt-1 text-red-700">
            {dbDown
              ? "Everything else will fail too until it is back. This is a server problem, not something you did."
              : "The database is up — one of the queries behind this page is at fault. The rest of the app is unaffected; send this to Ram."}
          </p>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-[11px] text-red-900/80">
            {queryError}
          </pre>
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
        <div className="card p-5 mt-6">
          <div className="text-sm font-medium text-chip-900">Money</div>
          <p className="text-xs text-slate-500 mt-1 mb-3">
            Only owners and managers see this.
          </p>
          <div className="flex flex-wrap gap-2">
            <a href="/placements" className="btn-ghost text-sm">Placements this month</a>
            <a href="/invoices" className="btn-ghost text-sm">Invoices &amp; what is overdue</a>
            <a href="/reports" className="btn-ghost text-sm">Desk performance</a>
            <a href="/payroll" className="btn-ghost text-sm">Payroll</a>
          </div>
        </div>
      )}
    </Shell>
  );
}
