# The rate-limit rule on /api/public/*

## Why this is a file and not a dashboard click

The rule is fully specified below and I built it twice in the Cloudflare
dashboard. It cannot be saved there: the **Duration** control on the rate
limiting form does not open, does not take focus and renders no options at all,
while the form refuses to submit without it — "Select duration". That is a fault
in Cloudflare's own page, not a permission we are missing. Everything else about
the rule went in fine.

So it goes in through the API instead. The API also asks for the duration, and
by name, which is the part the dashboard will not let anyone reach.

## What the rule does

Any request whose path starts with `/api/public/` — the careers apply form and
the client enquiry form, on either hostname — is counted per visitor address.
More than **30 in 10 seconds** and the rest are **blocked for 10 seconds**.

Thirty in ten seconds is roughly a hundred times what a person filling in a form
does and roughly a hundredth of what a script does, which is the gap this is
aimed at. It costs a real applicant nothing.

This is the outer wall. The app has its own limiter on the same routes
(`lib/ratelimit.js`), but that one is per-process and lost on every restart, and
it only counts requests that already reached the server and cost a database
connection. Cloudflare drops them before they arrive.

## Running it

Two things needed, neither of which should ever be pasted into a chat:

1. **Zone ID.** Cloudflare dashboard → `blacandpink.com` → Overview. It is in
   the right-hand column, under "API". A 32-character hex string.

2. **An API token.** My Profile → API Tokens → Create Token → Custom token.
   - Permissions: **Zone** → **Zone WAF** → **Edit**
   - Zone Resources: **Include** → **Specific zone** → `blacandpink.com`
   - Nothing else. This token can edit firewall rules on one zone and do
     nothing else with the account.
   - Copy it once. Cloudflare will not show it again.

Then, in PowerShell or Command Prompt, with your own two values substituted:

```
curl -X POST ^
  "https://api.cloudflare.com/client/v4/zones/YOUR_ZONE_ID/rulesets/phases/http_ratelimit/entrypoint/rules" ^
  -H "Authorization: Bearer YOUR_API_TOKEN" ^
  -H "Content-Type: application/json" ^
  --data "{\"description\":\"Public form flood guard\",\"expression\":\"starts_with(http.request.uri.path, \\\"/api/public/\\\")\",\"action\":\"block\",\"ratelimit\":{\"characteristics\":[\"ip.src\",\"cf.colo.id\"],\"period\":10,\"requests_per_period\":30,\"mitigation_timeout\":10}}"
```

(The `^` is the Windows line-continuation character. On a Mac or Linux box use
`\` instead.)

A successful call answers with `"success": true` and the new rule's id. Delete
the token afterwards if you would rather not keep one lying around — the rule
stays.

### Notes on the values

- `characteristics` must be exactly `ip.src` plus `cf.colo.id` on any plan below
  Enterprise. `cf.colo.id` means the count is per Cloudflare data centre rather
  than global, which in practice makes the limit slightly more generous. It is
  not optional; the call is rejected without it.
- `period` and `mitigation_timeout` must both be `10` on the Free plan. Ten
  seconds is the only window it offers, which is also why the dashboard's
  Duration list had nothing in it to show.
- The expression deliberately does not name a hostname, so it covers
  `/api/public/*` on `hr.` and on `careers.` alike. Adding a hostname would
  leave the other one open.

## Checking it worked

The rule appears under Security → Security rules, with Type "Rate limiting
rules". To see it act, fetch a public path more than thirty times in ten
seconds; the excess comes back as `429`.
