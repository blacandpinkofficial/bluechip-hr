// /api/settings — the few numbers that are policy rather than data.
import { NextResponse } from "next/server";
import { requireCapability, can } from "@/lib/auth";
import { getSettings, updateSettings, publicSettings, settingsForRole } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // Everyone signed in may read the policy numbers — the replacement window is
  // something a recruiter needs when a client asks on the phone. But the same
  // row also holds the company bank account, the GSTIN and the SMTP username,
  // and those are not for a screen anyone can open, so the payload is narrowed
  // by role rather than sent whole.
  const gate = await requireCapability("client.read");
  if (!gate.ok) return gate.response;
  const canSeeAll = can(gate.user.role, "user.write");
  return NextResponse.json({ settings: settingsForRole(await getSettings(), canSeeAll) });
}

export async function PATCH(req) {
  // Changing them is an owner's decision: they are commercial terms.
  const gate = await requireCapability("user.write");
  if (!gate.ok) return gate.response;
  try {
    const b = await req.json().catch(() => ({}));
    return NextResponse.json({ settings: publicSettings(await updateSettings(b)) });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "Could not save." }, { status: 400 });
  }
}
