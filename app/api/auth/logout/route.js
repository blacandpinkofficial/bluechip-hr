// POST /api/auth/logout
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { COOKIE, destroySession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req) {
  const token = cookies().get(COOKIE)?.value;
  await destroySession(token);

  // The Sign out control is a plain <form method="post">, so the browser
  // NAVIGATES here — it is not a fetch. Answering with JSON left the user
  // staring at {"ok":true} on a blank page with no nav and no way back except
  // editing the URL. 303 makes the browser follow with a GET to /login.
  const res = NextResponse.redirect(new URL("/login", req.url), 303);
  res.cookies.set(COOKIE, "", { path: "/", expires: new Date(0) });
  return res;
}
