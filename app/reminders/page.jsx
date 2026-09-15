// /reminders — kept alive purely as a signpost.
//
// This screen used to be the first thing anyone saw, and on a quiet day it was
// a title and one sentence saying nothing was outstanding. It has been merged
// into /dashboard, which now opens with the same list and then goes on to say
// what is worth doing when the list is empty.
//
// The route stays rather than being deleted, because it is in people's
// bookmarks, in the browser history of every recruiter who has used the app,
// and in at least one WhatsApp message. A 404 would read as the app being
// broken. A redirect reads as the app having been tidied up.
//
// Deliberately a temporary redirect, not a permanent one: a 308 is cached by
// the browser more or less forever, and if these two screens are ever pulled
// apart again the old machines would keep bouncing with nothing to clear it.

import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function RemindersPage() {
  redirect("/dashboard");
}
