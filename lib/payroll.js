// lib/payroll.js — what each person is actually owed this month.
//
// THE RULE THAT MATTERS (owner's decision, BC-06):
//
//   FIXED MONTHLY SALARY. DEDUCT ONLY FOR UNPAID ABSENCE.
//
//   Everyone on a monthly salary receives their full monthly gross. Weekly
//   offs, public holidays and approved paid leave are paid, and they are NOT
//   arithmetic — they do not appear in the numerator or the denominator. The
//   only thing that reduces pay is an unapproved absence or unpaid leave,
//   valued at one day's pay:
//
//       one day = monthly gross ÷ scheduled working days in that month
//       scheduled working days = days in month − that person's weekly offs
//
// This replaces the old hours-ratio model, which was wrong in both directions
// and depended on whether a manager had remembered to tick the Sundays:
//
//   • Weekly offs WERE recorded: each off silently added a standard day of
//     credit to the numerator while the denominator stayed at the annualised
//     figure, so the first few absences of every month cost nothing at all
//     (two free absences in a 28-day month, five in a 31-day month).
//   • Weekly offs were NOT recorded: the same person with perfect attendance
//     was paid 192/208 of their salary — an unexplained 7.7% cut.
//
// Under the rule below, recorded weekly offs and unrecorded weekly offs produce
// exactly the same pay. Nothing about a payslip depends on an administrative
// tick any more.
//
// Hours are still tracked and still shown, because a short shift and a
// forgotten check-out are both worth surfacing. They no longer scale base pay,
// and everything that displays them says what they are: hours recorded.
//
// Money is integer rupees throughout, same as everywhere else in this app.
// A payroll that ends in .00000000004 is a payroll somebody has to explain.

/**
 * A shift longer than this is a forgotten check-out, not a heroic day.
 * Shared with the attendance route so the overnight check-out fallback and the
 * hours calculation cannot drift apart.
 */
export const MAX_SHIFT_HOURS = 16;

/** Statuses that are paid and contribute no deduction and no arithmetic. */
const PAID_NON_WORKING = new Set(["leave", "holiday", "week-off"]);

/** Statuses that reduce pay, in halves of a day. */
const UNPAID_HALVES = { absent: 2, "unpaid-leave": 2, "half-day": 1 };

/** Days in a calendar month. month is "2026-09". */
export function daysInMonth(month) {
  const [y, m] = String(month).split("-").map(Number);
  if (!y || !m) return 30;
  return new Date(y, m, 0).getDate();
}

/**
 * How many days this person was scheduled to work in this specific month.
 *
 * Calendar days minus their weekly offs, derived from the contracted pattern
 * (workingDaysPerWeek). This is the DENOMINATOR for a day's pay, and it is
 * deliberately per-month: a day off in February is worth slightly more than a
 * day off in March because there are fewer working days to spread the salary
 * across. That is what "monthly salary" means.
 *
 * Note this is the SCHEDULE, not the attendance sheet. It does not care whether
 * anyone recorded the weekly offs — that is the entire point of the fix.
 */
export function scheduledWorkingDays({ month, workingDaysPerWeek = 6 } = {}) {
  const dim = daysInMonth(month);
  const dpw = Math.min(7, Math.max(1, Math.round(workingDaysPerWeek || 6)));
  // Nearest whole day. A month is not a whole number of weeks, so some rounding
  // is unavoidable; rounding once here keeps every downstream figure integral.
  return Math.max(1, Math.round((dim * dpw) / 7));
}

/**
 * Contracted hours in an average month, from the weekly pattern.
 *
 * INFORMATIONAL ONLY. This no longer touches pay — it is kept because the
 * salary-setup screen shows it so somebody can sanity-check an hourly rate
 * against a monthly figure. It is imported by /api/payroll/salary.
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
  return h > MAX_SHIFT_HOURS ? null : Math.round(h * 100) / 100;
}

/**
 * Summarise a month's attendance rows.
 *
 * Two things are counted separately and must not be confused:
 *
 *   workedHours   — hours ACTUALLY CLOCKED. Paid leave and weekly offs no
 *                   longer inflate this with synthetic credit; that synthetic
 *                   credit was half of the old bug.
 *
 *   unpaidHalves  — halves of a day that reduce pay. ONLY an explicit "absent"
 *                   or "unpaid-leave" row (2 halves) and a "half-day" (1 half).
 *
 * Everything else is paid. In particular:
 *
 *   • A day with NO ROW AT ALL is not an absence. Nothing creates weekly-off
 *     rows automatically, so treating a missing row as absence is precisely how
 *     an unticked Sunday became a pay cut.
 *   • A forgotten check-out is a day the person was present. It is paid in full
 *     and flagged, never silently valued at zero hours.
 *   • A row marked present with no times at all is a data gap, not an absence.
 *     It is flagged for a manager, and it does not dock anyone.
 *
 * A deduction requires somebody to have deliberately marked the day unpaid.
 */
export function summariseAttendance(rows = [], { standardHoursPerDay = 8 } = {}) {
  let worked = 0;
  let present = 0;
  let leaveDays = 0;
  let holidayDays = 0;
  let weekOffDays = 0;
  let absent = 0;
  let unpaidLeave = 0;
  let halfDays = 0;
  let incomplete = 0;
  let overtime = 0;
  let unpaidHalves = 0;

  for (const r of rows) {
    const status = String(r.status || "present");

    if (PAID_NON_WORKING.has(status)) {
      if (status === "leave") leaveDays += 1;
      else if (status === "holiday") holidayDays += 1;
      else weekOffDays += 1;
      continue; // paid, and contributes no hours and no deduction
    }

    if (status === "absent" || status === "unpaid-leave") {
      if (status === "absent") absent += 1;
      else unpaidLeave += 1;
      unpaidHalves += UNPAID_HALVES[status];
      continue;
    }

    // present | half-day | anything unrecognised: a day that should carry times.
    if (status === "half-day") {
      halfDays += 1;
      unpaidHalves += UNPAID_HALVES["half-day"];
    }

    const h = hoursWorked(r.checkIn, r.checkOut);
    if (h == null) {
      // Missing or unusable times. Paid, but somebody has to fix it before the
      // month can be locked — see needsAttention.
      incomplete += 1;
      continue;
    }

    if (status !== "half-day") present += 1;
    worked += h;
    if (h > standardHoursPerDay) overtime += h - standardHoursPerDay;
  }

  return {
    workedHours: Math.round(worked * 100) / 100,
    presentDays: present,
    halfDays,
    leaveDays,
    holidayDays,
    weekOffDays,
    // Kept as the combined "paid but not worked" count, which is what the
    // payslip column and PayrollItem.paidLeaveDays have always meant.
    paidLeaveDays: leaveDays + holidayDays + weekOffDays,
    absentDays: absent,
    unpaidLeaveDays: unpaidLeave,
    incompleteDays: incomplete,
    overtimeHours: Math.round(overtime * 100) / 100,
    unpaidHalves,
    // Whole days, one decimal, for display: 3 absences + 1 half-day = 3.5.
    unpaidDays: Math.round((unpaidHalves / 2) * 10) / 10,
  };
}

/**
 * Base pay for the month: the full salary, less unpaid absence.
 *
 * Integer arithmetic in halves of a day so a half-day does not introduce a
 * fraction: multiply, divide once, round once. Clamped to the monthly gross at
 * the top (nobody earns more than their salary from attendance) and to zero at
 * the bottom (more unpaid days than working days does not create a debt — it
 * creates a conversation, and the row is flagged for one).
 */
export function earnedSalaryFixedMonthly({ monthlyGross, scheduledDays, unpaidHalves = 0 }) {
  const gross = Math.round(monthlyGross || 0);
  if (!gross) return { base: 0, deduction: 0, dayValue: 0 };
  const days = Math.max(1, Math.round(scheduledDays || 0));
  const halves = Math.max(0, Math.round(unpaidHalves || 0));

  const deduction = Math.min(gross, Math.round((gross * halves) / (days * 2)));
  return {
    base: Math.max(0, gross - deduction),
    deduction,
    // One day's pay, rounded for display only — never used as the basis.
    dayValue: Math.round(gross / days),
  };
}

/**
 * SUPERSEDED — the old hours-ratio rule. Retained, unused, for one reason: it
 * is the only record of how PayrollRuns locked before this change were
 * computed. Locked months keep their stored figures and are never recomputed,
 * so this must not be called for new pay. See earnedSalaryFixedMonthly.
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
  const dpw = structure?.workingDaysPerWeek ?? 6;
  const summary = summariseAttendance(attendance, { standardHoursPerDay: hpd });
  const monthlyGross = structure?.monthlyGross ?? 0;

  const scheduledDays = scheduledWorkingDays({ month, workingDaysPerWeek: dpw });
  const { base, deduction, dayValue } = earnedSalaryFixedMonthly({
    monthlyGross,
    scheduledDays,
    unpaidHalves: summary.unpaidHalves,
  });

  const inc = incentive(incentiveRule, { joinings, revenue });
  const net = Math.max(0, base + inc.amount - Math.round(deductions || 0));

  return {
    userId: user?.id,
    name: user?.name,
    month,
    monthlyGross,
    // Informational only — shown, never used to scale pay.
    standardHours: standardMonthHours({ standardHoursPerDay: hpd, workingDaysPerWeek: dpw }),
    ...summary,
    workingDaysPerWeek: dpw,
    scheduledWorkingDays: scheduledDays,
    dayValue,
    unpaidDeduction: deduction,
    earnedBasic: base,
    // Said in words so nobody has to reverse-engineer the number.
    payBasis: summary.unpaidHalves
      ? `Full salary less ${summary.unpaidDays} unpaid day${summary.unpaidDays === 1 ? "" : "s"} at ₹${dayValue.toLocaleString("en-IN")} (₹${(monthlyGross || 0).toLocaleString("en-IN")} ÷ ${scheduledDays} scheduled working days)`
      : "Full monthly salary — no unpaid absence",
    incentive: inc.amount,
    incentiveBasis: inc.basis,
    joinings,
    revenue,
    deductions: Math.round(deductions || 0),
    netPay: net,
    // A day with times missing is paid in full, but the month is not ready to
    // lock until somebody resolves it. BC-07: this is now actually enforced.
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
