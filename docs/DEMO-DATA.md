# Demo data

Two scripts put a complete, obviously-fake recruitment story into the database
so the app can be walked through end to end, and take it out again cleanly.

> **This writes to the LIVE database.** It is not a test fixture and there is no
> separate demo environment. It is safe — see *Why it cannot touch a real
> record* below — but run it deliberately, not by accident.

## Commands

```bash
npm run demo:seed              # create the demo data (safe to run again)
npm run demo:unseed            # show exactly what would be removed — deletes nothing
npm run demo:unseed -- --yes   # actually remove it
```

Or directly: `node scripts/seed-demo.mjs`, `node scripts/unseed-demo.mjs --yes`.

Both read `DATABASE_URL` from the environment through the normal Prisma client,
exactly as `scripts/seed-owner.mjs` does. There are no credentials in either
file. An account must already exist — the demo records are attributed to the
first active user found (the owner, if there is one), and the script stops with
a clear message if there is none.

## What gets created

| | |
|---|---|
| **2 clients** | `DEMO Ascend Health BPO` (8.33% of CTC) and `DEMO Perungudi Tech Services` (₹15,000 flat) |
| **5 requirements** | AR Caller — Denials (voice, Guindy) · Medical Coding Executive (non-voice, Ambattur) · Team Lead — AR Calling (on hold, Guindy) · IT Support Engineer L1 (semi-voice, OMR, with its own 10% rate) · Field Sales Executive (Perungudi) |
| **20 candidates** | spread across every stage: 3 new · 4 contacted · 4 shortlisted · 3 lined-up · 2 interviewed · 1 selected · 2 joined · 1 dropped |
| **31 calls** | varied outcomes, four of them dated today, one callback already overdue and one due tomorrow |
| **12 submissions** | at `sent`, `acknowledged`, `shortlisted`, `no-response` (12 days of silence) and `interview-scheduled` |
| **8 interviews** | three in the next few days still `pending`, five in the past with outcomes recorded |
| **3 placements** | one `selected` with no joining date (fee not yet real), two `joined` — ₹42,000 and ₹15,000, one invoice raised, one paid |

Every date is relative to the moment the script runs, so the demo never goes
stale: "an interview tomorrow" is tomorrow whenever it is shown. `callCount`,
`lastContactedAt` and `nextFollowUpAt` are derived from the call rows the script
writes, so the counters on screen agree with the call log behind them.

## How demo records are marked

Three markers, all three on every demo row:

- **Clients and candidates are named `DEMO …`** — visible on every screen.
- **Candidate `source` is `demo-seed`** — not one of the real values
  (naukri, referral, walk-in, database, linkedin, whatsapp).
- **Candidate phones are `009000xxxx`** — a reserved block that cannot be a real
  number. Indian mobiles begin 6–9, landlines are dialled `0` plus an STD code
  beginning 1–8, and `00` is the international access prefix, so no subscriber
  number can fall in this block. That matters because `Candidate.phone` is
  unique: a colliding demo number would either crash the seeder or overwrite a
  real person's record.

Demo emails are at `@demo.invalid` — a reserved TLD that can never resolve, so
no mail sent from the demo can reach a real inbox. Requirements carry a
`DEMO DATA` line in their notes, and the two demo placements carry a fake
invoice number string; **no `Invoice` rows are created**, so the real gapless
invoice numbering is untouched.

## Why it cannot touch a real record

- Nothing is created against an existing client or requirement. Demo rows hang
  off demo clients only.
- `demo:seed` is idempotent — clients and candidates are upserted on their
  unique keys and the child rows are rewritten each run, so running it twice
  gives the same twenty candidates, not forty.
- Everything happens inside **one transaction**. It lands completely or not at
  all; it cannot die halfway and leave a mess in a live database.
- `demo:unseed` selects on all three markers and **checks all three agree**
  before deleting. A row matching one marker but not the others stops the
  script instead of being deleted on a guess.
- `demo:unseed` refuses to run if a real record has become entangled with a
  demo one — an invoice raised against a demo placement, a document attached to
  a demo client, a real candidate assigned to a demo opening — because removing
  the demo row would silently alter the real one. It names the row and stops.
- Running `demo:unseed` twice is fine. The second run finds nothing and says so.
