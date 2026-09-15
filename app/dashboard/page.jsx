// Today — the one screen this app opens on.
//
// This is the old /dashboard and the old /reminders merged. They were two
// half-empty pages: one listed what was due and said "Nothing outstanding" on a
// quiet day; the other showed four counts and nothing to do about them. Neither
// was worth being the first thing anyone saw.
//
// The order is deliberate and it is the order a morning actually goes:
//
//   1. WHAT NEEDS DOING     late first, then today, then coming up.
//   2. WORTH CHASING        the work that is drifting but has not yet tripped a
//                           reminder — CVs sent into silence, candidates with no
//                           next call booked, open roles nobody has sourced for.
//                           On a quiet day this is the page. It is why "nothing
//                           due" is never the last word here.
//   3. THE DESK RIGHT NOW   the counts, and where the pipeline is standing.
//   4. RECENTLY             a fortnight of calls, and this month's result.
//
// Every figure is a count of rows that exist. Nothing on this page is typed in
// by anyone, and nothing is estimated.
//
// SERVER COMPONENT, on purpose. The old reminders page was a client component
// that fetched /api/reminders after the browser had already painted, so the
// first thing the owner saw every morning was an empty screen with "Loading…"
// on it — which is a fair part of why the page "looks blank". Rendering on the
// server means the first paint is the finished page. The two actions on a
// reminder row are server actions, so ticking something off needs no client
// bundle and no dialog.

import { redirect } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { getSession, can } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveFee } from "@/lib/fees";
import { groupReminders, SILENCE_DAYS } from "@/lib/reminders";
import { istDay, IST_OFFSET_MIN, timeLabel } from "@/lib/day";
import { daily, peak } from "@/lib/stats";
import { rupees } from "@/lib/money";
import Shell from "@/components/Shell";

export const dynamic = "force-dynamic";

const MS_DAY = 86400000;

// Literal, never built from a variable. A class name assembled at runtime is a
// class name Tailwind's scanner never saw, so it is not in the stylesheet and
// the colour silently does not happen.
const URGENCY = {
  now: "border-l-4 border-l-red-500",
  normal: "border-l-4 border-l-amber-400",
  later: "border-l-4 border-l-slate-300",
};

const LINK = {
  candidate: (id) => `/candidates?open=${id}`,
  interview: () => "/interviews",
  placement: () => "/placements",
  invoice: () => "/invoices",
  submission: () => "/submissions",
  attendance: () => "/attendance",
};

// The stages a candidate is still in play in. joined and dropped are outcomes,
// not pipeline, and counting them as pipeline is how a dead desk looks busy.
const PIPELINE = [
  ["new", "New"],
  ["contacted", "Contacted"],
  ["shortlisted", "Shortlisted"],
  ["lined-up", "Lined up"],
  ["interviewed", "Interviewed"],
  ["selected", "Selected"],
];

/**
 * Tick a reminder off, or skip it.
 *
 * Scoped by userId in the WHERE rather than checked after loading — anyone can
 * guess an id, nobody should be able to close someone else's work. Same rule as
 * PATCH /api/reminders, which this deliberately mirrors rather than calls: a
 * form post to the page we are already on beats a fetch from a client bundle.
 */
async function markReminder(id, status) {
  "use server";
  const session = await getSession();
  if (!session) return;
  if (!["done", "dismissed", "open"].includes(status)) return;
  await prisma.reminder
    .updateMany({
      where: { id, userId: session.user.id },
      data: { status, doneAt: status === "open" ? null : new Date() },
    })
    .catch((e) => console.error("[dashboard] mark reminder failed", e?.message || e));
  revalidatePath("/dashboard");
}

function daysSince(d, today) {
  if (!d) return 0;
  return Math.max(0, Math.round((today.getTime() - istDay(d).getTime()) / MS_DAY));
}

function shortDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-IN", {
    day: "numeric", month: "short", timeZone: "Asia/Kolkata",
  });
}

function plural(n, one, many) {
  return n === 1 ? one : many;
}

/**
 * Everything this page shows, in ONE round of parallel queries.
 *
 * Twelve queries issued together, not twelve awaited in a row. The distinction
 * is the whole performance story of a landing page: in parallel this costs one
 * slow query's worth of time, in series it costs the sum of all of them.
 *
 * Scoping: a telecaller sees their own work, anyone holding report.desk sees the
 * desk. That is checked with can(), never by comparing role strings — a role
 * string comparison is a permission rule with no home, and it is always the one
 * that gets missed when a role is added.
 */
async function load(user) {
  const today = istDay();
  // istDay() is the DAY's label at UTC midnight; the IST day itself began five
  // and a half hours before that. Counting "today's calls" from the label loses
  // every call made between midnight and 5:30am IST, and night shifts are normal
  // on this desk.
  const dayStart = new Date(today.getTime() - IST_OFFSET_MIN * 60000);
  const dayEnd = new Date(dayStart.getTime() + MS_DAY);
  const weekEnd = new Date(dayStart.getTime() + 7 * MS_DAY);
  const fortnightStart = new Date(dayStart.getTime() - 13 * MS_DAY);
  // The IST month, not the UTC one. A placement selected at 2am on the 1st is
  // 20:30 UTC on the last day of the month before, and counting it there is how
  // a month's figures quietly disagree with the month's paperwork.
  const monthStart = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1) - IST_OFFSET_MIN * 60000
  );
  const monthEnd = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1) - IST_OFFSET_MIN * 60000
  );

  const deskWide = can(user.role, "report.desk");
  const showMoney = can(user.role, "revenue.read");

  const mineCandidates = deskWide ? {} : { ownerId: user.id };
  const mineCalls = deskWide ? {} : { userId: user.id };
  const mineInterviews = deskWide ? {} : { candidate: { ownerId: user.id } };
  const mineSubs = deskWide ? {} : { sentById: user.id };
  const minePlacements = deskWide ? {} : { recruiterId: user.id };

  const [
    reminderRows,
    requirementRows,
    stageRows,
    interviewRows,
    silentRows,
    silentTotal,
    noNextCall,
    callRows,
    selectedThisMonth,
    joinedThisMonth,
    revenueAgg,
    overdueRows,
  ] = await Promise.all([
    prisma.reminder.findMany({
      where: { userId: user.id, status: "open" },
      orderBy: [{ dueOn: "asc" }],
      take: 200,
    }),

    // "Which openings can't be billed?" is not a database filter — it is the
    // question resolveFee() already answers, and writing it a second time as a
    // Prisma `where` gives the rule two homes that will disagree the first time
    // the fee logic changes. So: fetch the open requirements with their client's
    // terms and let resolveFee decide. The same rows also answer "how many
    // positions are open" and "which roles has nobody sent a CV for", which is
    // three questions for one round trip.
    prisma.requirement.findMany({
      where: { status: "open" },
      orderBy: [{ openedAt: "asc" }],
      take: 500,
      select: {
        id: true,
        designation: true,
        location: true,
        openings: true,
        openedAt: true,
        feeType: true,
        feeBps: true,
        feeFlat: true,
        client: { select: { name: true, feeType: true, feeBps: true, feeFlat: true } },
        _count: { select: { submissions: true } },
      },
    }),

    prisma.candidate.groupBy({
      by: ["stage"],
      where: { archived: false, ...mineCandidates },
      _count: { _all: true },
    }),

    // Today and the six days after it in one query, split in JavaScript. Two
    // counts would have been two round trips for the same rows.
    prisma.interview.findMany({
      where: { scheduledAt: { gte: dayStart, lt: weekEnd }, ...mineInterviews },
      orderBy: [{ scheduledAt: "asc" }],
      take: 40,
      select: {
        id: true,
        scheduledAt: true,
        mode: true,
        candidate: { select: { name: true } },
        requirement: {
          select: { designation: true, client: { select: { name: true } } },
        },
      },
    }),

    prisma.submission.findMany({
      where: { status: "sent", ...mineSubs },
      orderBy: [{ sentAt: "asc" }],
      take: 6,
      select: {
        id: true,
        sentAt: true,
        candidate: { select: { name: true } },
        client: { select: { name: true } },
        requirement: { select: { designation: true } },
      },
    }),
    prisma.submission.count({ where: { status: "sent", ...mineSubs } }),

    // The quiet-day number that matters most. A candidate in play with no next
    // call booked is not on anybody's list — not here, not in the nightly job,
    // which can only remind you about dates that exist. This is the one thing
    // the app knows and nothing else says out loud.
    prisma.candidate.count({
      where: {
        archived: false,
        nextFollowUpAt: null,
        stage: { notIn: ["joined", "dropped"] },
        ...mineCandidates,
      },
    }),

    prisma.candidateCall.findMany({
      where: { calledAt: { gte: fortnightStart }, ...mineCalls },
      select: { calledAt: true },
      take: 5000,
    }),

    prisma.placement.count({
      where: { selectedOn: { gte: monthStart, lt: monthEnd }, ...minePlacements },
    }),
    prisma.placement.count({
      where: { joinedOn: { gte: monthStart, lt: monthEnd }, ...minePlacements },
    }),

    // Money is desk-wide by definition, so it is fetched only for the people who
    // may see desk-wide money. A team_leader holds report.desk and NOT
    // revenue.read, and these two queries are the line between those.
    showMoney
      ? prisma.placement.aggregate({
          _sum: { revenue: true },
          where: { joinedOn: { gte: monthStart, lt: monthEnd } },
        })
      : Promise.resolve(null),
    showMoney
      ? prisma.invoice.findMany({
          where: {
            status: { notIn: ["paid", "cancelled", "written-off", "draft"] },
            dueOn: { lt: today },
          },
          select: { id: true, totalPaise: true, paidPaise: true },
          take: 500,
        })
      : Promise.resolve(null),
  ]);

  // An invoice-due reminder carries the amount in its title. Those are only ever
  // created for owners and managers, but a person whose role was changed down
  // keeps the rows that were already theirs — so filter on the capability rather
  // than trusting how the rows were made.
  const reminders = Array.isArray(reminderRows) ? reminderRows : [];
  const grouped = groupReminders(
    showMoney ? reminders : reminders.filter((r) => r.kind !== "invoice-due"),
    today
  );

  const requirements = Array.isArray(requirementRows) ? requirementRows : [];
  const stages = Array.isArray(stageRows) ? stageRows : [];
  const interviews = Array.isArray(interviewRows) ? interviewRows : [];
  const silent = Array.isArray(silentRows) ? silentRows : [];
  const calls = Array.isArray(callRows) ? callRows : [];

  const stageCount = (key) =>
    stages.find((s) => s.stage === key)?._count?._all || 0;

  const series = daily(calls, { days: 14, key: "calledAt" });

  const overdue = (Array.isArray(overdueRows) ? overdueRows : [])
    .map((i) => (i.totalPaise || 0) - (i.paidPaise || 0))
    .filter((n) => n > 0);

  return {
    today,
    deskWide,
    showMoney,

    late: grouped.late,
    dueToday: grouped.today,
    ahead: grouped.ahead,

    openReqs: requirements.length,
    openings: requirements.reduce((n, r) => n + (r.openings || 0), 0),
    unbillable: requirements.filter((r) => resolveFee(r, r.client).feeType == null).length,
    coldRoles: requirements.filter((r) => (r._count?.submissions || 0) === 0),

    candidates: stages.reduce((n, s) => n + (s._count?._all || 0), 0),
    pipeline: PIPELINE.map(([key, label]) => ({ key, label, n: stageCount(key) })),
    inPlay: PIPELINE.reduce((n, [key]) => n + stageCount(key), 0),

    interviewsToday: interviews.filter((iv) => iv.scheduledAt < dayEnd),
    interviewsSoon: interviews.filter((iv) => iv.scheduledAt >= dayEnd),

    silent,
    silentTotal,
    noNextCall,

    series,
    callsToday: series[series.length - 1]?.count || 0,
    callsFortnight: calls.length,

    selectedThisMonth,
    joinedThisMonth,
    revenueThisMonth: revenueAgg?._sum?.revenue || 0,
    overdueCount: overdue.length,
    overdueRupees: Math.round(overdue.reduce((n, p) => n + p, 0) / 100),
  };
}

// ── pieces ──────────────────────────────────────────────────────────────────

function SectionHead({ title, note, children }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
      <h2 className="text-sm font-medium text-chip-900">
        {title}
        {note && <span className="text-slate-400 font-normal"> · {note}</span>}
      </h2>
      {children}
    </div>
  );
}

function Tile({ label, value, note, href }) {
  const body = (
    <>
      <div className="text-3xl font-semibold tabular-nums text-chip-800">{value}</div>
      <div className="text-sm font-medium text-chip-900 mt-1">{label}</div>
      {note && <div className="text-xs text-slate-500 mt-0.5">{note}</div>}
    </>
  );
  if (!href) return <div className="card p-5">{body}</div>;
  return (
    <Link href={href} className="card p-5 block transition hover:border-chip-300 hover:bg-chip-50/40">
      {body}
    </Link>
  );
}

function ReminderRow({ r, muted }) {
  const href = LINK[r.refType] ? LINK[r.refType](r.refId) : null;
  return (
    <div
      className={
        "card p-4 flex flex-wrap items-start gap-3 " +
        (URGENCY[r.urgency] || URGENCY.later) +
        (muted ? " opacity-75" : "")
      }
    >
      <div className="flex-1 min-w-[12rem]">
        <div className="font-medium text-chip-900">{r.title}</div>
        {r.body && <div className="text-sm text-slate-600 mt-0.5">{r.body}</div>}
        <div className="text-xs text-slate-400 mt-1">
          {r.kind}
          {r.daysLate > 0 && ` · ${r.daysLate} ${plural(r.daysLate, "day", "days")} late`}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {href && <Link href={href} className="btn-ghost text-sm">Open</Link>}
        <form action={markReminder.bind(null, r.id, "done")}>
          <button type="submit" className="btn-primary text-sm">Done</button>
        </form>
        <form action={markReminder.bind(null, r.id, "dismissed")}>
          <button
            type="submit"
            title="Not something I need to do"
            className="text-xs text-slate-400 hover:text-slate-600 px-1 py-2"
          >
            Skip
          </button>
        </form>
      </div>
    </div>
  );
}

function ReminderGroup({ title, rows, tone, muted }) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return (
    <div>
      <div className={"text-sm font-medium mb-2 " + (tone || "text-chip-900")}>
        {title} <span className="text-slate-400 font-normal">· {rows.length}</span>
      </div>
      <div className="space-y-2">
        {rows.map((r) => (
          <ReminderRow key={r.id} r={r} muted={muted} />
        ))}
      </div>
    </div>
  );
}

/** A fortnight of calls. Zero days are drawn, faintly — a week where nobody
 *  called on Tuesday must not look like a week where they did. */
function CallStrip({ series, total, deskWide }) {
  const top = peak(series);
  const w = 100 / Math.max(series.length, 1);
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <div className="text-sm font-medium text-chip-900">
          {deskWide ? "Calls, last 14 days" : "Your calls, last 14 days"}
        </div>
        <div className="text-xs text-slate-500 tabular-nums">
          {total} in 14 days · busiest {top}
        </div>
      </div>
      <svg
        viewBox="0 0 100 34"
        preserveAspectRatio="none"
        className="w-full h-20"
        role="img"
        aria-label={`Calls per day over 14 days, ${total} in total, busiest day ${top}`}
      >
        <line x1="0" y1="2" x2="100" y2="2" stroke="#e2e8f0" strokeWidth="0.3" />
        {series.map((s, i) => {
          const h = (s.count / top) * 30;
          return (
            <rect
              key={s.date}
              x={i * w + w * 0.15}
              y={32 - h}
              width={w * 0.7}
              height={Math.max(h, s.count ? 0.6 : 0)}
              fill="#2c60a0"
              opacity={s.count ? 1 : 0.15}
            >
              <title>{`${s.label}: ${s.count}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="flex justify-between text-[10px] text-slate-400 tabular-nums">
        <span>{series[0]?.label}</span>
        <span>{series[series.length - 1]?.label}</span>
      </div>
    </div>
  );
}

// ── page ────────────────────────────────────────────────────────────────────

export default async function Dashboard() {
  const session = await getSession();
  if (!session) redirect("/login");
  const { user } = session;

  // A failed query is not an unreachable database, and saying so sends whoever
  // reads it looking in the wrong place. Check the connection separately, so the
  // screen can tell the difference between "Postgres is down" and "one of my
  // queries is wrong".
  let d = null;
  let dbDown = false;
  let queryError = null;
  try {
    d = await load(user);
  } catch (e) {
    queryError = e?.message || String(e);
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      dbDown = true;
    }
  }

  const heading = new Date().toLocaleDateString("en-IN", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata",
  });

  if (queryError || !d) {
    return (
      <Shell title="Today" subtitle={heading}>
        <div role="alert" className="card border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <div className="font-medium">
            {dbDown ? "The database is not responding." : "Today's figures could not be loaded."}
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
      </Shell>
    );
  }

  const nothingDue = d.late.length === 0 && d.dueToday.length === 0;
  const chasing = d.silentTotal > 0 || d.noNextCall > 0 || d.coldRoles.length > 0;
  // A fresh install, as opposed to a quiet day. Every one of these has to be
  // empty, not just the candidate count: for a telecaller the candidate count is
  // scoped to their own list, and a new joiner with nothing assigned yet must
  // not be told the whole company database is empty and offered an import.
  const fresh =
    d.candidates === 0 &&
    d.openReqs === 0 &&
    d.callsFortnight === 0 &&
    d.late.length === 0 &&
    d.dueToday.length === 0 &&
    d.ahead.length === 0 &&
    !chasing;

  return (
    <Shell title="Today" subtitle={heading}>
      {/* ── 1. what needs doing ─────────────────────────────────────────── */}
      <section>
        {nothingDue ? (
          <div className="card p-4 border-l-4 border-l-emerald-400">
            <div className="text-chip-900 font-medium">Nothing is due today.</div>
            <p className="text-sm text-slate-500 mt-0.5">
              No follow-up is late and nothing needs confirming.{" "}
              {chasing
                ? "So today is for the work below — it has not gone wrong yet, which is exactly why nobody is being reminded about it."
                : fresh
                ? "There is nothing in the app yet either."
                : d.candidates === 0
                ? "Nothing is assigned to you yet either — ask for a calling list, or load one yourself."
                : "Nothing is drifting either, which is rarer than it sounds."}
            </p>
          </div>
        ) : (
          <div className="space-y-5">
            <ReminderGroup title="Late" rows={d.late} tone="text-red-700" />
            <ReminderGroup title="Due today" rows={d.dueToday} />
          </div>
        )}

        {d.ahead.length > 0 && (
          <div className="mt-5">
            <ReminderGroup title="Coming up" rows={d.ahead} muted />
          </div>
        )}
      </section>

      {/* ── 2. worth chasing — the quiet-day content ─────────────────────── */}
      {!fresh && chasing && (
        <section className="mt-7">
          <SectionHead
            title="Worth chasing"
            note="nothing here is overdue yet"
          />
          <div className="grid gap-4 md:grid-cols-3">
            {d.silentTotal > 0 && (
              <div className="card p-4">
                <div className="flex items-baseline justify-between gap-2">
                  <div className="text-sm font-medium text-chip-900">No reply yet</div>
                  <span className="text-xs text-slate-400 tabular-nums">{d.silentTotal}</span>
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  CVs sent and not answered. After {SILENCE_DAYS} days the client has
                  moved on, not forgotten.
                </p>
                <ul className="mt-3 space-y-2">
                  {d.silent.slice(0, 5).map((s) => {
                    const n = daysSince(s.sentAt, d.today);
                    return (
                      <li key={s.id} className="text-sm leading-tight">
                        <span className="text-chip-900">{s.candidate?.name || "Someone"}</span>
                        <span className="text-slate-400"> at </span>
                        <span className="text-slate-600">{s.client?.name || "a client"}</span>
                        <div className="text-xs text-slate-400">
                          {s.requirement?.designation || "opening"} · sent {shortDate(s.sentAt)}
                          <span className={n >= SILENCE_DAYS ? "text-red-600" : "text-slate-400"}>
                            {" · "}
                            {n} {plural(n, "day", "days")} silent
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <Link href="/submissions" className="btn-ghost text-sm mt-3 inline-flex">
                  Chase these
                </Link>
              </div>
            )}

            {d.noNextCall > 0 && (
              <div className="card p-4">
                <div className="text-sm font-medium text-chip-900">No next call booked</div>
                <div className="text-3xl font-semibold tabular-nums text-chip-800 mt-1">
                  {d.noNextCall}
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  {plural(d.noNextCall, "candidate is", "candidates are")} still in play with no
                  follow-up date set, so nothing will ever remind you about{" "}
                  {plural(d.noNextCall, "it", "them")} — the nightly job can only work from
                  dates that exist.
                </p>
                <Link href="/candidates" className="btn-ghost text-sm mt-3 inline-flex">
                  Open the calling list
                </Link>
              </div>
            )}

            {d.coldRoles.length > 0 && (
              <div className="card p-4">
                <div className="flex items-baseline justify-between gap-2">
                  <div className="text-sm font-medium text-chip-900">No CV sent yet</div>
                  <span className="text-xs text-slate-400 tabular-nums">{d.coldRoles.length}</span>
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  Open roles nobody has submitted anyone for.
                </p>
                <ul className="mt-3 space-y-2">
                  {d.coldRoles.slice(0, 5).map((r) => (
                    <li key={r.id} className="text-sm leading-tight">
                      <span className="text-chip-900">{r.designation}</span>
                      <div className="text-xs text-slate-400">
                        {[r.client?.name, r.location].filter(Boolean).join(" · ")}
                        {r.openedAt ? ` · open ${daysSince(r.openedAt, d.today)}d` : ""}
                      </div>
                    </li>
                  ))}
                </ul>
                <Link href="/requirements" className="btn-ghost text-sm mt-3 inline-flex">
                  See the openings
                </Link>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── 3. the desk right now ────────────────────────────────────────── */}
      <section className="mt-7">
        <SectionHead
          title={d.deskWide ? "The desk right now" : "Your desk right now"}
          note="counted, never typed"
        />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Tile
            label="Open requirements"
            value={d.openReqs}
            note={`${d.openings} ${plural(d.openings, "position", "positions")} to fill`}
            href="/requirements"
          />
          <Tile
            label="Candidates"
            value={d.candidates}
            note={`${d.inPlay} still in play`}
            href="/candidates"
          />
          <Tile
            label="Calls today"
            value={d.callsToday}
            note={d.callsFortnight > 0 ? `${d.callsFortnight} in 14 days` : "none logged yet"}
            href="/candidates"
          />
          <Tile
            label="Interviews today"
            value={d.interviewsToday.length}
            note={
              d.interviewsSoon.length > 0
                ? `${d.interviewsSoon.length} more this week`
                : "none later this week"
            }
            href="/interviews"
          />
        </div>

        {d.interviewsToday.length > 0 && (
          <div className="card p-4 mt-4">
            <div className="text-sm font-medium text-chip-900 mb-2">Today&rsquo;s interviews</div>
            <ul className="space-y-2">
              {d.interviewsToday.map((iv) => (
                <li key={iv.id} className="text-sm leading-tight">
                  <span className="tabular-nums text-chip-800 font-medium">
                    {timeLabel(iv.scheduledAt)}
                  </span>
                  <span className="text-slate-400"> · </span>
                  <span className="text-chip-900">{iv.candidate?.name || "Someone"}</span>
                  <div className="text-xs text-slate-400">
                    {[iv.requirement?.designation, iv.requirement?.client?.name, iv.mode]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {d.inPlay > 0 && (
          <div className="card p-4 mt-4">
            <div className="text-sm font-medium text-chip-900 mb-3">
              Where the pipeline is standing
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
              {d.pipeline.map((s) => (
                <div key={s.key}>
                  <div className="text-2xl font-semibold tabular-nums text-chip-800">{s.n}</div>
                  <div className="text-[11px] text-slate-500 leading-tight">{s.label}</div>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-slate-400 mt-3">
              Live counts of people, not a history. Someone who joined or dropped has left
              the pipeline and is not counted here.
            </p>
          </div>
        )}

        {d.unbillable > 0 && can(user.role, "client.fees") && (
          <Link
            href="/requirements"
            className="block card border-amber-200 bg-amber-50 p-4 mt-4 hover:bg-amber-100 transition"
          >
            <div className="text-sm text-amber-900">
              <b className="tabular-nums">{d.unbillable}</b> open requirement
              {d.unbillable === 1 ? " has" : "s have"} no commercials — neither on the
              opening nor on the client. A placement against{" "}
              {d.unbillable === 1 ? "it" : "them"} cannot be billed.
            </div>
          </Link>
        )}

        {fresh && (
          <div className="card p-8 mt-4 text-center">
            <div className="text-chip-900 font-medium">Nothing in here yet.</div>
            <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
              The zeros above are honest, not broken — there are no openings and no
              candidates in the database. Import the job description sheet and every
              client and opening in it lands here. You review it before anything is saved.
            </p>
            <div className="flex flex-wrap gap-2 justify-center mt-4">
              {can(user.role, "import.run") && (
                <Link href="/import" className="btn-primary inline-flex">
                  Import the sheet
                </Link>
              )}
              {can(user.role, "import.candidates") && (
                <Link href="/import/candidates" className="btn-ghost inline-flex">
                  Import a calling list
                </Link>
              )}
            </div>
          </div>
        )}
      </section>

      {/* ── 4. recently ──────────────────────────────────────────────────── */}
      {!fresh && (
        <section className="mt-7">
          <SectionHead title="Recently" note="this month, and the last fortnight" />
          <div className="grid gap-4 lg:grid-cols-2">
            <CallStrip
              series={d.series}
              total={d.callsFortnight}
              deskWide={d.deskWide}
            />
            <div className="card p-4">
              <div className="text-sm font-medium text-chip-900 mb-3">
                {d.deskWide ? "This month" : "Your month"}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-2xl font-semibold tabular-nums text-chip-800">
                    {d.selectedThisMonth}
                  </div>
                  <div className="text-[11px] text-slate-500 leading-tight">Selected</div>
                </div>
                <div>
                  <div className="text-2xl font-semibold tabular-nums text-chip-800">
                    {d.joinedThisMonth}
                  </div>
                  <div className="text-[11px] text-slate-500 leading-tight">Joined</div>
                </div>
              </div>
              <p className="text-[11px] text-slate-400 mt-3">
                A selection is a promise; only a joining can be invoiced. Adding the two
                together is how a month looks better than it was.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* ── finance — desk money, and only for the people who may see it ──── */}
      {d.showMoney && (
        <section className="mt-7">
          <SectionHead title="Finance" note="owners and managers only" />
          <div className="card p-5">
            <div className="grid grid-cols-2 gap-4">
              <div className="min-w-0">
                <div className="text-xl sm:text-2xl font-semibold tabular-nums text-chip-800 break-words">
                  {rupees(d.revenueThisMonth)}
                </div>
                <div className="text-[11px] text-slate-500 leading-tight">
                  Billable from joinings this month
                </div>
              </div>
              <div className="min-w-0">
                <div
                  className={
                    "text-xl sm:text-2xl font-semibold tabular-nums break-words " +
                    (d.overdueCount > 0 ? "text-red-700" : "text-chip-800")
                  }
                >
                  {rupees(d.overdueRupees)}
                </div>
                <div className="text-[11px] text-slate-500 leading-tight">
                  Overdue across {d.overdueCount} {plural(d.overdueCount, "invoice", "invoices")}
                </div>
              </div>
            </div>
            <p className="text-xs text-slate-500 mt-3">
              Team leaders see the work, not the money.
            </p>
            <div className="flex flex-wrap gap-2 mt-3">
              <Link href="/placements" className="btn-ghost text-sm">Placements this month</Link>
              <Link href="/invoices" className="btn-ghost text-sm">Invoices &amp; what is overdue</Link>
              <Link href="/reports" className="btn-ghost text-sm">Desk performance</Link>
              <Link href="/payroll" className="btn-ghost text-sm">Payroll</Link>
            </div>
          </div>
        </section>
      )}

      <p className="text-xs text-slate-500 mt-7 max-w-prose">
        The list at the top is rebuilt every night from dates already in the app. Something
        you tick off stays ticked off; something still outstanding comes back with the number
        of days updated. If an item disappears on its own, the reason for it went away — the
        invoice was paid, or the call was made. Everything below it is counted live, right
        now, from the rows themselves.
      </p>
    </Shell>
  );
}
