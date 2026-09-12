# Blue Chip HR

Recruitment operations for Blue Chip HR Solutions Pvt. Ltd.

This is a **separate application** from Pulse (the Blac & Pink retail system).
It shares a server and a Postgres instance with Pulse and nothing else — its own
repository, its own database, its own Postgres role, its own domain, its own
systemd service. There is no code path from here to any retail data, and the
database role this app connects as is refused by the Pulse database.

If you are about to add an import from the Pulse repo: don't. Copy the file in
instead. The absence of shared code is the feature.

---

## First-time setup on the server

As `ubuntu`, on the Lightsail box. Two pastes.

```bash
# 1. The code. CLONE BEFORE PROVISIONING — provisioning writes .env into
#    /opt/bluechip/app, and `git clone` refuses a directory that is not empty.
sudo mkdir -p /opt/bluechip && sudo chown -R ubuntu:ubuntu /opt/bluechip
git clone https://github.com/blacandpinkofficial/bluechip-hr.git /opt/bluechip/app
```

```bash
# 2. Everything else: database, role, systemd, nginx, dependencies, schema,
#    build, start, health check, first owner account. Safe to run again.
bash /opt/bluechip/app/deploy/bootstrap.sh
```

DNS and the certificate can wait until the app is up:

```bash
# point app.bluechiphr.com at this box's IP first, then
sudo certbot --nginx -d app.bluechiphr.com
```

## Deploying afterwards

```bash
cd /opt/bluechip/app && bash deploy/bluechip-deploy.sh
```

The deploy script **shares Pulse's build lock** (`/tmp/pulse-deploy.lock`). The
box has 3.7 GB of RAM and a single `next build` wants most of it, so if a Pulse
deploy is running this one waits rather than competing. That wait is the point —
without it, one of the two builds gets OOM-killed and there is no rule saying it
won't be the retail app on a billing day.

It keeps the previous build in `.next.prev` and only deletes it **after** the
health check passes. A build that compiles but won't boot gets rolled back
automatically.

---

## Layout

```
app/
  login/            sign-in (the brand surface — Blue Chip only, nothing shared)
  dashboard/        today's counts
  api/auth/         login · logout · me
  api/health/       what the deploy script polls before deleting the backup
lib/
  auth.js           sessions, password hashing, three roles, capability checks
  money.js          rupees as integers, "18k" and "6 LPA" parsing
  fees.js           commercials — resolution, revenue, frozen terms
  prisma.js         one client, reused
prisma/schema.prisma
deploy/
  provision-bluechip.sh   one-time server setup
  bluechip-deploy.sh      every deploy after that
scripts/seed-owner.mjs
```

## Handing it over

The point of this section is that Blue Chip can run this without Ram, and leave
it without anyone's permission.

**Accounts.** Settings → Team. Create one account per person; roles are owner,
manager and recruiter/telecaller. Passwords are generated and shown once — if
the box is closed before the password is passed on, reset it and a new one
appears. The last active owner cannot be demoted or deactivated, because there
is no route back into commercials and invoicing from inside the app once that
account is gone. Make a second owner before you need one.

**Getting your data out.** Settings → Export everything. One workbook, every
row, laid out as the sheets the desk already knows: Daily Call List, Interview
Schedules, MTD Performance, plus call history and client commercials. No ticket,
no request, no notice. Revenue columns appear only for roles that can see them
on screen.

**Removing Ram's access.** Settings → Team → deactivate his account. That signs
him out immediately rather than at session expiry. Do it once a second owner
exists. Server access (SSH to the box, the GitHub repo, the Cloudflare tunnel)
is separate and has to be handed over outside the app.

**If something breaks.**

| Symptom | Where to look |
| --- | --- |
| Site does not load at all | `sudo systemctl status bluechip` on the server |
| Loads but every page errors | `curl -s localhost:3100/api/health` — if `db` is not `up`, Postgres is the problem |
| A deploy failed | It rolled back automatically. The previous build is running. Read `/var/log/bluechip-deploy.log` |
| One screen errors, others fine | A query bug, not an outage. The page says which |

**Backups.** There are none yet, and that is the largest single risk to this
business. `pg_dump bluechip` on a nightly cron, copied off the box, is the
minimum. Do not put this off.

## Rules worth knowing before you edit

**A `route.js` may export only HTTP handlers and Next's segment config**
(`runtime`, `dynamic`, `revalidate`, …). Exporting any other function or
constant from a route file breaks the production build, and the error names
unrelated files. Helpers go in `lib/`.

**Money is an integer number of rupees. Percentages are basis points.**
8.33% is `833`, not `0.0833`. `computeRevenue` multiplies before it divides and
rounds once, so every half-rupee resolves the same way every time. Done in
floats, twelve placements at ₹2,35,000 sum to ₹2,34,906 instead of ₹2,34,912 —
small enough that nobody finds the cause, large enough that nobody trusts the
report.

**Placement terms are frozen, not looked up.** When a rate is renegotiated with
a client, placements already made keep the terms they were made under.
Otherwise closed months silently change value and no report can be trusted
twice.

**Nothing that can be counted is stored.** The old workbook's "Daily
productivity" tab and month-to-date revenue column were typed out by hand from
numbers that already existed. Here they are queries. If you find yourself adding
a column to cache a total, that is the wrong direction.

**Capability checks run on the server, every time.** `/api/auth/me` returns the
signed-in user's capabilities so the UI can hide controls, but that is a
courtesy. `requireCapability()` in the handler is the rule. A recruiter must
never be able to read the desk's total revenue by calling the API directly.

## Roles

| Role | Sees |
| --- | --- |
| `owner` | Everything, including commercials, revenue and invoices |
| `manager` | The whole desk except editing client commercials |
| `recruiter` | Their own candidates, calls, interviews and their own numbers |
