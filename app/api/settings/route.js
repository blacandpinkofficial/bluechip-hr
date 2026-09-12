// /api/settings — the few numbers that are policy rather than data.
import { NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth";
import { getSettings, updateSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // Everyone signed in may read these — the replacement window is something a
  // recruiter needs to know when a client asks on the phone.
  const gate = await requireCapability("client.read");
  if (!gate.ok) return gate.response;
  return NextResponse.json({ settings: await getSettings() });
}

export async function PATCH(req) {
  // Changing them is an owner's decision: they are commercial terms.
  const gate = await requireCapability("user.write");
  if (!gate.ok) return gate.response;
  try {
    const b = await req.json().catch(() => ({}));
    return NextResponse.json({ settings: await updateSettings(b) });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "Could not save." }, { status: 400 });
  }
}
