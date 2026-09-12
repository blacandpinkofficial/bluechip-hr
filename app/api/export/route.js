// GET /api/export — everything, as a workbook.
//
// This exists for one reason: nobody should feel locked in. Blue Chip came off
// two spreadsheets and must be able to walk back to spreadsheets at any time,
// with every row, on demand, without asking anyone.
//
// The sheets deliberately mirror the workbooks the desk already knows, so the
// export is familiar rather than a database dump: a Daily Call List, Interview
// Schedules, MTD Performance. Plus the two the old files never had — call
// history and client commercials — because those are the parts the app added.

import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/prisma";
import { requireCapability, can } from "@/lib/auth";
import { describeFee, resolveFee } from "@/lib/fees";
import { istDateString, timeLabel } from "@/lib/day";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function d(v) {
  return v ? new Date(v).toISOString().slice(0, 10) : "";
}
function dt(v) {
  return v ? new Date(v).toISOString().slice(0, 16).replace("T", " ") : "";
}
function months(m) {
  if (m == null) return "";
  if (m === 0) return "Fresher";
  return m < 12 ? `${m} months` : `${Math.round((m / 12) * 10) / 10} years`;
}
function yesNo(v) {
  return v === true ? "Yes" : v === false ? "No" : "Not asked";
}

export async function GET(req) {
  const gate = await requireCapability("export.run");
  if (!gate.ok) return gate.response;

  try {
    const showMoney = can(gate.user.role, "revenue.read");
    const showFees = can(gate.user.role, "client.fees");

    const [clients, requirements, candidates, calls, interviews, placements] = await Promise.all([
      prisma.client.findMany({ orderBy: { name: "asc" } }),
      prisma.requirement.findMany({ include: { client: true }, orderBy: { openedAt: "desc" } }),
      prisma.candidate.findMany({
        where: { archived: false },
        include: {
          owner: { select: { name: true } },
          requirement: { select: { designation: true, client: { select: { name: true } } } },
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.candidateCall.findMany({
        include: { user: { select: { name: true } }, candidate: { select: { name: true, phone: true } } },
        orderBy: { calledAt: "desc" },
        take: 20000,
      }),
      prisma.interview.findMany({
        include: {
          candidate: { select: { name: true, phone: true } },
          requirement: { select: { designation: true, location: true, client: { select: { name: true } } } },
        },
        orderBy: { scheduledAt: "desc" },
      }),
      prisma.placement.findMany({
        include: {
          candidate: { select: { name: true, phone: true } },
          client: { select: { name: true } },
          recruiter: { select: { name: true } },
        },
        orderBy: { selectedOn: "desc" },
      }),
    ]);

    const wb = XLSX.utils.book_new();
    const add = (name, rows) => {
      // A sheet with no rows still gets created, with its headers, so the shape
      // of the export never changes depending on how busy the month was.
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{}]), name);
    };

    add("Daily Call List", candidates.map((c) => ({
      "Date added": d(c.createdAt),
      "Source": c.source || "",
      "Candidate name": c.name,
      "Contact number": c.phone,
      "Alt number": c.altPhone || "",
      "Email": c.email || "",
      "Designation": c.designation || "",
      "Location": c.location || "",
      "Experience": months(c.expMonths),
      "Current take home": c.currentCtc ?? "",
      "Expected": c.expectedCtc ?? "",
      "Notice (days)": c.noticeDays ?? "",
      "Qualification": c.education || "",
      "Relieving letter": yesNo(c.hasRelieving),
      "Arrears": yesNo(c.hasArrears),
      "Applied for": c.requirement?.designation || "",
      "Client": c.requirement?.client?.name || "",
      "Stage": c.stage,
      "Status note": c.status || "",
      "Calls made": c.callCount,
      "Last contacted": d(c.lastContactedAt),
      "Recruiter": c.owner?.name || "",
    })));

    add("Call History", calls.map((c) => ({
      "Date": dt(c.calledAt),
      "Candidate": c.candidate?.name || "",
      "Number": c.candidate?.phone || "",
      "Recruiter": c.user?.name || "",
      "Outcome": c.outcome,
      "Remarks": c.notes || "",
      "Call back at": dt(c.followUpAt),
    })));

    add("Interview Schedules", interviews.map((i) => ({
      // IST, like the screen. toISOString() is UTC, so a 10:00 am interview
      // exported as 04:30 and a 2am one landed on the previous date — the
      // workbook and the app disagreed about every single row.
      "Interview date": istDateString(i.scheduledAt),
      "Time": i.scheduledAt ? timeLabel(i.scheduledAt) : "",
      "Candidate name": i.candidate?.name || "",
      "Ph number": i.candidate?.phone || "",
      "Company name": i.requirement?.client?.name || "",
      "Position": i.requirement?.designation || "",
      "Location": i.location || i.requirement?.location || "",
      "Interview mode": i.mode,
      "Round": i.round,
      "Interviewer": i.interviewer || "",
      "Attended": yesNo(i.attended),
      "Outcome": i.outcome || "",
      "Feedback": i.feedback || "",
    })));

    // Revenue is stripped for anyone who may not see it. An export is not a
    // way around a permission — a recruiter downloading the workbook must not
    // receive the desk's numbers in a column the screen would have hidden.
    add("MTD Performance", placements.map((p) => ({
      "Source": "",
      "Recruiter name": p.recruiter?.name || "",
      "Candidate name": p.candidate?.name || "",
      "Mobile": p.candidate?.phone || "",
      "Date of selection": d(p.selectedOn),
      "Client name": p.client?.name || "",
      "Designation": p.designation,
      "Location": p.location,
      "D.O.J": d(p.joinedOn),
      "Employee id": p.employeeId || "",
      "CTC offered": p.ctcOfferedAnnual ?? "",
      ...(showMoney ? {
        "Revenue": p.revenue ?? "",
        "Invoice": p.invoiceStatus,
        "Invoice no": p.invoiceNo || "",
      } : {}),
      // Fee basis is the client's agreed RATE, not a revenue figure, so it
      // belongs behind client.fees (owner only) like the two commercial columns
      // on the other sheets — not behind showMoney, which managers also hold.
      // An export must not be a way around a permission that holds on screen.
      ...(showFees ? {
        "Fee basis": p.feeType === "percent" ? `${(p.feeBps / 100).toFixed(2).replace(/\.00$/, "")}%` : "Flat",
      } : {}),
      "Replacement until": d(p.replacementUntil),
      "Dropped on": d(p.droppedOn),
      "Drop reason": p.dropReason || "",
    })));

    add("Client Job Descriptions", requirements.map((r) => {
      const fee = resolveFee(r, r.client);
      return {
        "Company name": r.client?.name || "",
        "HR name": r.client?.hrName || "",
        "Location": r.location,
        ...(showFees ? { "Commercials": describeFee(fee) } : {}),
        "Process": r.processType || "",
        "Domain": r.domain || "",
        "No of positions": r.openings,
        "Experience": [months(r.expMinMonths), months(r.expMaxMonths)].filter(Boolean).join(" – "),
        "Relieving": r.relievingRequired ? "Mandatory" : "Not required",
        "CTC (Take Home)": [r.takeHomeMin, r.takeHomeMax].filter((x) => x != null).join(" – "),
        "Cab facility": r.cabFacility,
        "Process detail": r.processDetail || "",
        "Education": r.educationMin || "",
        "Arrears": r.arrearsAllowed ? "Allowed" : "No arrears",
        "Doc submission": r.docsRequired || "",
        "Status": r.status,
        "Opened": d(r.openedAt),
      };
    }));

    add("Clients", clients.map((c) => ({
      "Company name": c.name,
      "HR contact": c.hrName || "",
      "Phone": c.hrPhone || "",
      "Email": c.hrEmail || "",
      "City": c.city || "",
      ...(showFees ? { "Commercials": describeFee(c) } : {}),
      "Credit period (days)": c.paymentDays,
      "Active": c.active ? "Yes" : "No",
    })));

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const stamp = new Date().toISOString().slice(0, 10);

    await prisma.auditLog
      .create({
        data: {
          userId: gate.user.id, action: "export", entity: "All",
          summary: `Exported ${candidates.length} candidates, ${placements.length} placements, ${calls.length} calls`,
        },
      })
      .catch((e) => console.error("[export] audit write failed:", e?.message));

    return new NextResponse(buf, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="blue-chip-hr-${stamp}.xlsx"`,
        "Content-Length": String(buf.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    console.error("[GET /api/export]", e?.message || e);
    return NextResponse.json({ error: "Could not build the export." }, { status: 500 });
  }
}
