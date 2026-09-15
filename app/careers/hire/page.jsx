// app/careers/hire — the "I'm hiring" side.
//
// What this page does NOT do is create a client or an opening. It creates a
// RequirementLead: a row in a table that nothing else in the application reads,
// which a consultant with requirement.write looks at on /leads and either
// throws away or turns into a real Requirement. That is the whole design. A
// stranger with a browser cannot put a row into the table the desk works from.
//
// The page says so, in the "what happens next" panel, because it is also the
// honest answer to "will someone actually read this".

import Link from "next/link";
import { getSettings } from "@/lib/settings";
import HireForm from "../HireForm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Hire with us",
  description:
    "Tell Blue Chip HR Solutions what you are hiring for — role, experience, " +
    "budget and shift — and a consultant in Chennai will call you back.",
};

export default async function HirePage() {
  const settings = await getSettings().catch(() => null);
  const enabled = !!settings?.careersEnabled;
  const email = settings?.careersEmail || null;

  if (!enabled) {
    return (
      <div className="mx-auto w-full max-w-lg px-4 py-24 text-center sm:px-6">
        <h1 className="text-2xl font-semibold">This form is closed</h1>
        <p className="mt-3 text-slate-600">
          Our enquiry form is not accepting submissions at the moment.
          {email ? " Please email us instead." : " Please try again soon."}
        </p>
        {email && (
          <a href={`mailto:${email}`} className="btn-primary mt-6">
            {email}
          </a>
        )}
        <div className="mt-4">
          <Link href="/careers" className="text-sm text-chip-600 hover:underline">
            Back to Blue Chip HR
          </Link>
        </div>
      </div>
    );
  }

  return (
    <>
      <section className="border-b border-slate-200 bg-chip-800 text-white">
        <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Tell us who you need
          </h1>
          <p className="mt-3 max-w-2xl text-chip-100">
            One form, two minutes. A consultant reads every enquiry and calls you
            back to agree the brief — nothing is quoted automatically.
          </p>
        </div>
      </section>

      <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
        <div className="grid gap-10 lg:grid-cols-[1fr_18rem]">
          <div className="min-w-0 order-2 lg:order-1">
            <HireForm />
          </div>

          <aside className="order-1 space-y-6 lg:order-2">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-5">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                What happens next
              </h2>
              <ol className="mt-3 space-y-3 text-sm leading-relaxed text-slate-700">
                <li>
                  <b>A person reads it.</b> Enquiries go into a review queue, not
                  straight into our system. Nothing is automated.
                </li>
                <li>
                  <b>We call you</b> — usually the same working day — to agree the
                  role, the experience band and the terms.
                </li>
                <li>
                  <b>We start sourcing.</b> You see screened profiles: people we
                  have spoken to, not a keyword search.
                </li>
              </ol>
            </div>

            <div className="rounded-lg border border-slate-200 p-5">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                Rather talk first?
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">
                Send a line and we will call you. You do not need the budget
                worked out before you get in touch.
              </p>
              {email && (
                <a
                  href={`mailto:${email}`}
                  className="mt-3 inline-block break-all text-sm text-chip-600 hover:underline"
                >
                  {email}
                </a>
              )}
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}
