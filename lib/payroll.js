// lib/payroll.js — what each person is actually owed this month.
//
// THE RULE THAT MATTERS: pay is pro-rated by HOURS ACTUALLY WORKED, not by
// counting days that have an attendance row. A six-hour day on an eight-hour
// shift is six-eighths of that day's pay, not a full day. Counting days is the
// mistake that quietly overpays every short day and underpays every long one,
// and nobody notices until someone works out their own hourly rate.
//
// Money is integer rupees throughout, same as everywhere else in this app.
// A payroll that ends in .00000000004 is a payroll somebody has to explain.

/** Days in a calendar month. month is "2026-09". */
export function daysInMonth(month) {
  const [y, m] = String(month).split("-").map(Number);
  if (!y || !m) return 30;
  return new Date(y, m, 0).getDate();
}

/**
 * How many hours does a full month represent for this person?
 *
 * Based on their contracted working days per week, not on how many days the
 * month happens to have. Otherwise a 31-day month silently pays 3% more than a
 * 30-day month for identical work, which is the sort of thing that turns into
 * an argument nobody can win because both sides are reading the same payslip.
 */
export function standardMonthHours({ standardHoursPerDay = 8, workingDaysPerWeek = 6 } = {}) {
  const weeksPerMonth = 52 / 12; // 4.333…
  return Math.round(standardHoursPerDay * workingDaysPerWeek * weeksPerMonth * 100) / 100;
}

/** Hours between check-in and check-out, to two decimals. Null if incomplete. */
export function hoursWorked(checkIn, checkOut) {
  if (!checkIn || !checkOut) return null;
  const a = new Date(checkIn).getTime();
  const b = new Date(checkOut).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  // A shift longer than 16 hours is a forgotten check-out, not a heroic day.
  // Counting it would pay double for an admin mistake.
  const h = (b - a) / 3600000;
  return h > 16 ? null : Math.round(h * 100) / 100;
}

/**
 * Total hours from a month's attendance rows.
 *
 * Rows with a status that means "paid but not worked" (approved leave, a public
 * holiday, the weekly off) contribute a standard day so the person is not
 * docked for them. Rows with no check-out contribute nothing and are counted
 * separately, so the screen can say "three days are missing a check-out" rather
 * than silently short-paying someone.
 */
export function summariseAttendance(rows = [], { standardHoursPerDay = 8 } = {}) {
  let worked = 0;
  let present = 0;
  let paidLeave = 0;
  let absent = 0;
  let incomplete = 0;
  let overtime = 0;

  for (const r of rows) {
    if (r.status === "absent") { absent += 1; continue; }
    if (r.status === "leave" || r.status === "holiday" || r.status === "week-off") {
      paidLeave += 1;
      worked += standardHoursPerDay;
      continue;
    }
    const h = hoursWorked(r.checkIn, r.checkOut);
    if (h == null) {
      if (r.checkIn) incomplete += 1;
      else absent += 1;
      continue;
    }
    present += 1;
    worked += h;
    if (h > standardHoursPerDay) overtime += h - standardHoursPerDay;
  }

  return {
    workedHours: Math.round(worked * 100) / 100,
    presentDays: present,
    paidLeaveDays: paidLeave,
    absentDays: absent,
    incompleteDays: incomplete,
    overtimeHours: Math.round(overtime * 100) / 100,
  };
}

/**
 * Earned salary for the month.
 *
 * Capped at the full monthly figure: working extra hours does not inflate base
 * pay. Overtime, if it is paid at all, is a separate decision and a separate
 * line — rolling it into the base silently makes every long month a pay rise.
 */
export function earnedSalary({ monthlyGross, workedHours, standardHours }) {
  if (!monthlyGross || !standardHours) return 0;
  const ratio = Math.min(workedHours / standardHours, 1);
  return Math.round(monthlyGross * ratio);
}

// ── incentives ──────────────────────────────────────────────────────────────

/**
 * What a recruiter earns on top, from the placements they closed.
 *
 * Only JOINED, not-dropped placements count. A selection that never turned up
 * earns the business nothing, and paying incentive on it means paying twice for
 * work that produced no revenue — once in the incentive and again in the
 * replacement.
 *
 * rule shapes:
 *   { kind: "per-joining", perJoining: 2000 }
 *   { kind: "percent-of-revenue", revenueBps: 500 }          // 5%
 *   { kind: "slab", slabs: [{ min: 3, amount: 5000 }, …] }   // highest met wins
 */
export function incentive(rule, { joinings = 0, revenue = 0 } = {}) {
  if (!rule || rule.active === false) return { amount: 0, basis: "no rule set" };

  if (rule.kind === "per-joining") {
    const per = Math.round(rule.perJoining || 0);
    return {
      amount: per * joinings,
      basis: joinings ? `${joinings} joining${joinings === 1 ? "" : "s"} × ₹${per.toLocaleString("en-IN")}` : "no joinings",
    };
  }

  if (rule.kind === "percent-of-revenue") {
    const bps = Math.round(rule.revenueBps || 0);
    // Integer maths, same as the fee calculation: multiply, divide once, round
    // once. A percentage of a percentage is where rounding drift compounds.
    const amount = Math.round((Math.round(revenue) * bps) / 10000);
    return {
      amount,
      basis: revenue ? `${(bps / 100).toFixed(2).replace(/\.00$/, "")}% of ₹${revenue.toLocaleString("en-IN")}` : "no revenue",
    };
  }

  if (rule.kind === "slab") {
    const slabs = [...(rule.slabs || [])].sort((a, b) => b.min - a.min);
    const hit = slabs.find((s) => joinings >= s.min);
    return {
      amount: hit ? Math.round(hit.amount) : 0,
      basis: hit
        ? `${joinings} joinings reaches the ${hit.min}+ slab`
        : `${joinings} joinings — below the lowest slab (${slabs.length ? slabs[slabs.length - 1].min : "?"})`,
    };
  }

  return { amount: 0, basis: `unknown incentive type "${rule.kind}"` };
}

/**
 * One person's payslip for the month.
 * Every figure is derived; nothing here is typed by anyone.
 */
export function payslip({
  user,
  structure,
  attendance = [],
  joinings = 0,
  revenue = 0,
  incentiveRule = null,
  deductions = 0,
  month,
}) {
  const hpd = structure?.standardHoursPerDay ?? 8;
  const summary = summariseAttendance(attendance, { standardHoursPerDay: hpd });
  const standardHours = standardMonthHours(structure || {});
  const monthlyGross = structure?.monthlyGross ?? 0;

  const base = earnedSalary({
    monthlyGross,
    workedHours: summary.workedHours,
    standardHours,
  });
  const inc = incentive(incentiveRule, { joinings, revenue });
  const net = Math.max(0, base + inc.amount - Math.round(deductions || 0));

  return {
    userId: user?.id,
    name: user?.name,
    month,
    monthlyGross,
    standardHours,
    ...summary,
    earnedBasic: base,
    // Shown so nobody has to work out why the number is not the full salary.
    proRataPct: standardHours ? Math.round(Math.min(summary.workedHours / standardHours, 1) * 1000) / 10 : 0,
    incentive: inc.amount,
    incentiveBasis: inc.basis,
    joinings,
    revenue,
    deductions: Math.round(deductions || 0),
    netPay: net,
    // A month with missing check-outs is not ready to pay.
    needsAttention: summary.incompleteDays > 0,
  };
}

/**
 * Who did best this month.
 *
 * Ranked on joinings first and revenue second, deliberately. Revenue alone
 * rewards whoever happened to be handed the highest-paying requirement;
 * joinings measures the work. Ties broken by revenue, then by name so the order
 * is stable between refreshes.
 */
export function achiever(rows = []) {
  const ranked = [...rows]
    .filter((r) => (r.joinings || 0) > 0)
    .sort((a, b) =>
      (b.joinings || 0) - (a.joinings || 0) ||
      (b.revenue || 0) - (a.revenue || 0) ||
      String(a.name).localeCompare(String(b.name))
    );
  if (ranked.length === 0) return null;

  const top = ranked[0];
  const tied = ranked.filter((r) => r.joinings === top.joinings && r.revenue === top.revenue);
  return {
    ...top,
    // Announcing one winner when two people tied exactly is how a desk decides
    // the numbers are rigged.
    sharedWith: tied.length > 1 ? tied.slice(1).map((t) => t.name) : [],
    runnerUp: ranked[1] || null,
  };
}
