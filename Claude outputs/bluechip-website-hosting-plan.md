# bluechiphr.com — Public Site & Two Portals

**Prepared for:** Ram (software), Blue Chip HR Solutions Pvt. Ltd., Chennai
**Owner:** Mohan Babu
**Date:** 15 September 2026

> **Correction from Ram, 15 Sep:** bluechiphr.com is **Mohan's own site**, not an outside vendor's. That changes who you are asking, not what you need. Everything in the technical analysis below stands — the Turbify DNS and the no-port-80/443 constraints are the same either way. What it changes is Part 2: instead of negotiating with a vendor, the job is to **find the Turbify login** (it is Mohan's account) and either hand it over or work the checklist from inside it. Part 2 is written so it works both ways — as an email to Turbify support, or as a checklist Mohan works through himself.

**Goal:** turn `bluechiphr.com` into a real public site with two portals —
(a) **Client portal**: companies submit hiring requirements → lands directly in the internal app's `Requirements` table;
(b) **Candidate portal**: jobseekers browse and apply to postings published from the internal app.

Internal app today: Next.js + Postgres on AWS Lightsail (Mumbai), reached via Cloudflare Tunnel at `hr.blacandpink.com`. The box has **no inbound ports 80/443**.

---

# Part 0 — What bluechiphr.com actually is today (measured, not guessed)

All of the below was verified live on 15 Sep 2026.

## The website

| Item | Finding |
|---|---|
| Type | **Hand-coded static HTML.** Not WordPress, not a CMS, no database, no admin panel. |
| Web server | `LiteSpeed` |
| Hosting | **Turbify cPanel shared hosting** — `www.bluechiphr.com` is a CNAME to `cpanel205.turbify.biz` |
| Origin IP | `172.206.226.183` (Microsoft Azure range — Turbify runs their cPanel fleet on Azure) |
| Pages | `index.html`, `aboutus.html`, `service.html`, `solution.html`, `client.html`, `contact.html` — **6 pages, that's the whole site** |
| Last modified | `aboutus/service/client/contact` = **14 Jul 2014**; `solution` = 13 Mar 2015; `index` = 23 Apr 2018 |
| Footer | "All Copyrights Reserved 2014" |
| Page weight | 6–14 KB per page. Total site is a few hundred KB including logo images. |
| Encoding | `charset=iso-8859-1` (legacy; not UTF-8) |
| JavaScript | jQuery 1.10.2 from Google CDN + `smoothDivScroll` (a client-logo carousel). Nothing else. |
| **Forms** | **There are none.** Not a single `<form>` tag anywhere on the site. No contact form, no enquiry form, no resume upload. |
| Analytics / tag manager | None detected. |

**The most useful finding:** the navigation already advertises **"Current Openings"** and **"Job Seekers"** — but those links are wired to the wrong files:

```
'Current Openings'  -> solution.html
'Job Seekers'       -> client.html
```

So the site already promises exactly the two portals we want to build, and has promised them since 2014 without delivering them. That's a good line to use with the owner.

Contact details currently published on the site:
- Corporate: F 1, P.J Apartment, No. 5B, Chakkrapani Street, Maduvangarai, Guindy, Chennai 600032
- Branch: No. 61, Eshaparva, 13th A Cross, Bhuvaneshwari Nagar, Dasarahalli Main Road, Bangalore 560024
- Phone: +91 44 4332 2560 / 99623 99555
- Email: `mohanbabu@bluechiphr.com`, `jobs@bluechiphr.com`

## The domain and DNS

| Item | Finding | Why it matters |
|---|---|---|
| Registrar | **Tucows Domains Inc.** (IANA ID 69), resold through Turbify | Ram will be dealing with Turbify support, not Tucows directly |
| Registered | 19 Mar 2012 · expires **19 Mar 2027** | ~18 months of runway; don't let it lapse |
| Nameservers | `ns1.turbify.com`, `ns2.turbify.com` | **Not Cloudflare.** This is constraint #1. |
| Domain status | `clientTransferProhibited`, **`clientUpdateProhibited`** | ⚠️ `clientUpdateProhibited` can **block a nameserver change** until Turbify lifts it |
| SOA serial | `2026021802` | DNS last touched ~18 Feb 2026 — someone does still have access |
| Apex `A` | `172.206.226.183` | |
| `www` | `CNAME → cpanel205.turbify.biz` | |
| **`MX`** | `mx-biz.mail.am0.yahoodns.net` (priorities 20 and 30) | **Turbify/Yahoo Business Mail. Live and in daily use. Breaking this breaks the business.** |
| `TXT` | **None at all** | No SPF, no DKIM, no DMARC — see note below |
| `CAA` | None | Any CA may issue; no obstacle to Let's Encrypt or Cloudflare |
| **Wildcard** | **`*.bluechiphr.com` → `cpanel205.turbify.biz`** | ⚠️ Constraint #3 — see below |
| SSL | cPanel **AutoSSL via Let's Encrypt**, auto-renewing roughly every 60 days. Certs observed for `bluechiphr.com`, `www`, `webmail`, `webdisk`, `cpcalendars` | Nobody is hand-managing certs; it's automatic and it works |

### The wildcard DNS record — verified

I tested three random, non-existent hostnames:

```
zzqx9random.bluechiphr.com     -> cpanel205.turbify.biz -> 172.206.226.183
notarealhost7.bluechiphr.com   -> cpanel205.turbify.biz -> 172.206.226.183
xyzzy-test-123.bluechiphr.com  -> cpanel205.turbify.biz -> 172.206.226.183
```

All resolve. There is a `*` wildcard pointing everything at the Turbify cPanel box. Consequences:

1. `careers.bluechiphr.com` and `jobs.bluechiphr.com` **already resolve today** — to the wrong place (Turbify). They are not "free" names we can grab from outside.
2. To use one, somebody must create an **explicit record** for it in the Turbify DNS panel, which overrides the wildcard. There is no way to do this from Ram's side without DNS access. **This alone means the vendor/owner conversation is unavoidable.**
3. If DNS ever moves to Cloudflare, the wildcard **must be recreated** or webmail/cPanel/FTP hostnames silently break.

### Note on email records

There is **no SPF, DKIM or DMARC** on this domain at all. That is a pre-existing deliverability problem (Blue Chip's mail to candidates and clients is more likely to land in spam), not something we're causing. Worth fixing during whatever migration happens — but it is a **separate change**, and should not be bundled into the cutover, so that if mail breaks we know which change did it.

---

# Part 1 — Options analysis

## The two constraints that actually decide this

Everything below turns on these. Read them first.

### Constraint A — DNS is at Turbify, and Cloudflare Tunnel will not route for a domain that isn't in the Cloudflare account

A Cloudflare Tunnel is published to the internet by pointing a hostname at `<TUNNEL-UUID>.cfargotunnel.com`. That target is **not a normal public CNAME target**. Cloudflare's documentation states plainly:

> "The `cfargotunnel.com` subdomain only proxies traffic for DNS records in the same Cloudflare account."
> — [Cloudflare One docs, routing to a tunnel with DNS](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/routing-to-tunnel/dns/)

So **you cannot simply ask Turbify to add `careers CNAME <uuid>.cfargotunnel.com`.** It will resolve and then fail. This is the single most common mistake in this exact scenario, and it is worth stating explicitly to anyone who suggests it.

There are only three legitimate ways around it:
1. Put the zone (or a delegated child zone) **into** Cloudflare, or
2. Use **Cloudflare for SaaS custom hostnames**, which *is* designed for third-party domains, or
3. Don't use `bluechiphr.com` for the portals at all.

Also note: **Cloudflare "subdomain setup"** — delegating just `careers.bluechiphr.com` into Cloudflare via `NS` records at Turbify — is officially an **Enterprise-plan feature** ([Cloudflare DNS docs, subdomain setup](https://developers.cloudflare.com/dns/zone-setups/subdomain-setup/)). Availability table reads Free: No, Enterprise: Yes. So the clean "just delegate the subdomain" answer is priced out of reach for a business this size. Don't plan around it.

### Constraint B — the Lightsail box has no inbound 80/443, so certbot is impossible and so is a plain A record

The box is reachable only through the outbound tunnel. That means:
- **No HTTP-01 certbot.** Let's Encrypt cannot reach the box to validate.
- **No A record pointing at the Lightsail IP.** Even with a DNS-01 certificate, nothing would answer on 443.
- Therefore **whatever hostname serves the portals must terminate TLS at Cloudflare**, not on the box. This is not a preference; it's forced.

(For completeness: DNS-01 validation would get you a *certificate*, but a certificate on a box nothing can connect to is useless. Opening 80/443 on Lightsail is possible but throws away the reason the tunnel exists — no public attack surface, no static IP dependency, no firewall management. Not recommended.)

### Constraint C — `clientUpdateProhibited` + the wildcard

The registrar lock may block a nameserver change until Turbify lifts it, and the wildcard means no subdomain is usable without someone editing Turbify DNS. Both are *asks of a third party*. Plan on a 1–3 week human latency for any option, regardless of how fast the engineering is.

---

## Option 1 — Subdomain on Turbify DNS → Cloudflare for SaaS → existing tunnel

**Shape:** Keep `bluechiphr.com` exactly where it is. Ask Turbify for **two DNS records only**. Use **Cloudflare for SaaS custom hostnames** on Ram's existing `blacandpink.com` Cloudflare zone to serve `careers.bluechiphr.com` off the existing tunnel.

**How it works:**
1. In Ram's Cloudflare account, on the `blacandpink.com` zone, enable Cloudflare for SaaS and set a **fallback origin** (e.g. `portal-origin.blacandpink.com`), which is itself a tunnel public hostname pointing at the Next.js app.
2. Add `careers.bluechiphr.com` as a **custom hostname**.
3. Turbify adds at `bluechiphr.com`:
   - `careers` → `CNAME` → `portal-origin.blacandpink.com`
   - one `TXT` record for hostname/certificate validation (Cloudflare supplies the exact name and token)
4. Cloudflare issues and auto-renews the certificate for `careers.bluechiphr.com`. No certbot, no ports.

**Cost:** **Free.** Cloudflare for SaaS custom hostnames are available on the **Free plan with 100 hostnames included**, $0.10/month each beyond that ([Cloudflare for SaaS plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/)). We need one.

| | |
|---|---|
| **What breaks** | Nothing. Existing site, email, cPanel AutoSSL, wildcard — all untouched. This is the lowest-blast-radius option that exists. |
| **Effort** | Ram: half a day for the Cloudflare for SaaS wiring, then normal app work. Vendor: 10 minutes, two records. |
| **Who does what** | Vendor/Turbify adds 2 records, once. Ram does everything else. |
| **Fragility** | **Medium.** Cloudflare for SaaS + Tunnel is a known-fiddly combination — there are multiple Cloudflare community threads about custom hostnames not routing correctly to tunnel origins. The app must accept the `Host: careers.bluechiphr.com` header, and the fallback origin must be correctly configured. It works, but it is an advanced setup and harder to debug at 11pm. |
| **Long-term** | Ram is still locked out of DNS. Every future record (a second portal, an SPF fix, a Search Console TXT verification) is another email to the vendor. That friction compounds. |

**Verdict:** the best option **if the owner will not move nameservers.** Excellent fallback, mediocre destination.

---

## Option 2 — Move bluechiphr.com DNS to Cloudflare entirely ⭐ RECOMMENDED

**Shape:** Change nameservers from `ns1/ns2.turbify.com` to Cloudflare's. Import every existing record faithfully. The 2014 site keeps running, unchanged, on Turbify's servers — only the *lookup* moves. Then `careers.bluechiphr.com` becomes a one-click tunnel route.

**The critical insight people get wrong:** moving DNS **does not move the website or the email.** The site stays on the Turbify cPanel box at `172.206.226.183`. The mail keeps flowing to `mx-biz.mail.am0.yahoodns.net`. We are only changing who *answers the phone book*, not who hosts anything. Say it in exactly those terms to Mohan Babu, because "moving the domain" sounds terrifying and this isn't that.

**Records that must be replicated exactly (this is the whole risk):**

| Type | Name | Value | Notes |
|---|---|---|---|
| A | `@` | `172.206.226.183` | **Grey cloud / DNS-only** initially |
| CNAME | `www` | `cpanel205.turbify.biz` | Grey cloud |
| CNAME | `*` | `cpanel205.turbify.biz` | **Do not forget the wildcard** |
| MX | `@` | `mx-biz.mail.am0.yahoodns.net` pri 20 | |
| MX | `@` | `mx-biz.mail.am0.yahoodns.net` pri 30 | |
| CNAME | `mail` | `mail-redirect.turbify.com` | |
| CNAME | `webmail`, `cpanel`, `ftp`, `webdisk`, `cpcalendars` | `cpanel205.turbify.biz` | Covered by wildcard, but make explicit |

⚠️ **Do not rely on my list or on Cloudflare's auto-scan.** Cloudflare's importer misses records the vendor hasn't published and cannot see anything a wildcard is masking. **Demand a full zone export / screenshot of every record from Turbify before touching anything** (this is Question 3 in the vendor brief).

⚠️ **Keep the legacy site grey-clouded (DNS-only).** If you proxy it orange, cPanel AutoSSL's HTTP validation is going through Cloudflare, and a renewal failure 60 days later is a very confusing outage to debug. Leave it grey; it costs nothing and removes a whole class of surprise.

| | |
|---|---|
| **What breaks** | Only what you fail to copy. Email is the thing to be paranoid about — get the MX right and verify before and after. |
| **Effort** | Ram: 2–3 hours total, mostly careful checking. Vendor: lift the registrar lock, change 2 nameserver entries. |
| **Who does what** | Turbify must lift `clientUpdateProhibited` and set the NS. Owner (Mohan Babu) must authorise. Ram does the zone build. |
| **Fragility** | **Low once done, moderate during the 24–48h cutover.** Lower TTLs a day ahead. Do it on a Saturday morning. |
| **Cost** | **Free** (Cloudflare Free plan). |
| **Long-term** | ⭐ **Ram owns DNS permanently.** Tunnel routes become trivial. Search Console verification, SPF/DKIM/DMARC fixes, a second portal, staging hostnames, email migration later — all self-service, zero vendor latency. Plus free CDN, WAF, and analytics. |

**Verdict:** **This is the right answer.** One uncomfortable conversation and one careful Saturday buys permanent unblocking. Every other option leaves Ram permanently dependent on a vendor who last touched the site in 2018.

---

## Option 3 — Current vendor rebuilds the site and integrates via API

**Shape:** Pay the existing vendor to build a new marketing site on Turbify hosting, with the client form and job board calling the internal app's API.

| | |
|---|---|
| **What breaks** | Potentially the whole site during rebuild; the vendor owns the outcome and the timeline. |
| **Effort** | High, and mostly **not Ram's** — which sounds good and isn't. Every spec change is a billable round-trip. |
| **Killer problem** | Turbify shared cPanel hosting is **LiteSpeed + static/PHP**. A Next.js app cannot run there. So the "integration" would be the vendor's PHP/JS calling Ram's API cross-origin, meaning: Ram must expose a **public, authenticated, CORS-enabled API** from the Lightsail box — which needs a public hostname anyway, which puts you **right back at Constraint A**. This option does not avoid the DNS problem; it adds a vendor on top of it. |
| **Fragility** | **High.** Two codebases, two owners, a hand-rolled API contract, and a vendor whose demonstrated release cadence is *one page edit in eight years*. Candidate resume uploads would flow through the vendor's PHP — a data-protection question Blue Chip should not want. |
| **Cost** | Real money, ongoing, ₹ in the tens of thousands plus AMC, and recurring cost for every change. |

**Verdict:** **No.** It is the most expensive option, it does not remove the blocking constraint, and it puts candidate PII in a third party's stack. Consider the vendor for *visual design* of the marketing pages if the owner wants continuity — not for the portals.

---

## Option 4 — Keep the vendor's site as a shell, embed/iframe the portals

**Shape:** Leave the 2014 site as-is; put an `<iframe>` on a new page pointing at the portal hosted elsewhere.

| | |
|---|---|
| **What breaks** | The iframe still needs a **public HTTPS hostname to point at** — Constraint A again, unsolved. You've saved nothing. |
| **Fragility** | **High, and badly.** Iframes break: mobile viewport and scrolling are miserable on a 2014 fixed-width `iso-8859-1` layout; file upload (resumes) inside a cross-origin iframe hits browser and cookie restrictions; third-party cookie deprecation breaks session state; back-button and deep-linking don't work. |
| **SEO** | ☠️ **Fatal.** **Google does not index the content of an iframe as part of the parent page.** Job postings inside an iframe will not produce `JobPosting` rich results for `bluechiphr.com`. Given that the entire point of the candidate portal is to be found, this disqualifies the option by itself. |
| **Effort** | Deceptively low to start, then a long tail of unfixable papercuts. |

**Verdict:** **No.** It looks like the cheap shortcut and is the one option that actively destroys the main business goal (discoverability).

---

## Recommendation

**Go with Option 2 (move DNS to Cloudflare). Hold Option 1 as the fallback if the owner refuses to move nameservers.**

Suggested sequencing — note that **Phase 1 is not blocked on anyone**:

| Phase | What | Blocked on |
|---|---|---|
| **0** | Send the vendor brief (Part 2). Start the clock on the human latency now. | — |
| **1** | Build both portals on the Next.js app **today**, served at `careers.blacandpink.com` via a tunnel route in the zone Ram already controls. Full client + candidate flows, working, demoable. | **Nothing.** Do this first. |
| **2** | Answers come back → move DNS to Cloudflare on a quiet Saturday. Legacy site grey-clouded and untouched. | Turbify lock + owner sign-off |
| **3** | Add `careers.bluechiphr.com` as a tunnel route (30 seconds). Keep the old hostname 301-redirecting. | Phase 2 |
| **4** | Verify in Search Console, submit sitemap, add `JobPosting` markup (Part 3), then apply for Indexing API quota. | Phase 3 |
| **5** | *Separately, after the dust settles:* add SPF/DKIM/DMARC. Consider replacing the 2014 marketing pages. | — |

Building at `careers.blacandpink.com` first is the important move. It de-risks everything: the portals get built and tested regardless of how long the vendor takes, and the final hostname swap becomes a 30-second DNS change rather than a project.

---

# Part 2 — What to get from the Turbify account

> **The site is Mohan's, so there is nobody to negotiate with — this is a checklist, not a negotiation.** The fastest path is: Mohan finds the Turbify login (it is in his name; the domain bills through Turbify and renews 19 Mar 2027), hands it to Ram, and Ram does the whole thing in an afternoon. If the login cannot be found, the same numbered list below works as an email to Turbify support to recover the account and answer the gaps — so keep it either way.
>
> **The one question that decides everything: can Mohan log in to Turbify today?** If yes, skip to the "What we need most urgently" section — you already have everything, and the rest is an hour's work. If no, account recovery is the first task and nothing else can start until it is done.

---

## The checklist (also usable verbatim as an email to Turbify support)

### What we are trying to do

We are adding two new sections to the Blue Chip website:

1. A **client section**, where companies can submit their hiring requirements online instead of over phone and email.
2. A **candidate section**, where jobseekers can see our current openings and apply directly.

These will be built on our own internal recruitment software, which already exists and is already running. We plan to put them on a subdomain such as **careers.bluechiphr.com**.

**Please note clearly:** we are **not** asking you to rebuild the website, and we are **not** moving the website or the email to another company. The existing website pages stay exactly where they are, on the same server. The email accounts (`mohanbabu@bluechiphr.com`, `jobs@bluechiphr.com`) must keep working exactly as they do today, with no interruption — this is not negotiable, and we will plan the work around protecting it.

We only need some information and a small amount of access so our developer can connect the new careers section. Please answer the questions below point by point. If you do not know an answer, please say "don't know" rather than guessing — a wrong answer here can take the company email down, so we would much rather have a blank.

### Questions

**A. DNS control**

1. **Who controls the DNS records for bluechiphr.com?** The domain currently uses `ns1.turbify.com` and `ns2.turbify.com`. Is it your team who logs in to change DNS, or Turbify directly, or the owner? Please give the name of the company and the control panel URL used.

2. **Can you give us login access to the DNS control panel?** If full access is not possible, can you give us a read-only or limited login? If neither, who do we email to get a record added, and what is the usual turnaround time?

3. **Please send a complete export or screenshot of ALL current DNS records** for bluechiphr.com — every record, not just the main ones. We specifically need: `A`, `AAAA`, `CNAME`, `MX`, `TXT`, `SRV`, `NS` and any **wildcard (`*`)** entries. We can see from outside that a wildcard record exists (every subdomain currently points to `cpanel205.turbify.biz`), so please make sure that one is included. **This is the single most important item on this list.**

4. **Can you create a subdomain for us?** Specifically, we will need you to add records of this shape:

   - a **`CNAME`** record, host `careers`, pointing to a hostname we will give you (it will look like `something.blacandpink.com`)
   - a **`TXT`** record, with a name like `_cf-custom-hostname.careers` and a long random value we will give you, used to prove we own the name

   Please confirm your DNS panel **can** add `CNAME` and `TXT` records on a subdomain, and that a specific `careers` record will correctly **override the existing wildcard**. If your panel cannot do one of these, tell us which.

5. **Alternatively — can the nameservers be changed?** Our strongly preferred option is to move only the DNS lookup for bluechiphr.com to Cloudflare (a free, standard service). **The website would stay on your server and the email would stay with Turbify — nothing is being moved or re-hosted.** It only changes which service answers DNS queries, and it lets us manage the careers subdomain ourselves without troubling you every time.

   - Is there any technical or contractual reason this cannot be done?
   - The domain currently has a registrar lock called **`clientUpdateProhibited`** set on it. This may prevent a nameserver change. **Can you get this lock lifted, and who do we ask?**
   - If we do this, will anything on your side stop working — for example, does your hosting control panel, webmail, or FTP depend on Turbify's own nameservers specifically?

**B. Hosting and the website itself**

6. **What is the website built on?** From outside it appears to be plain static HTML pages on cPanel/LiteSpeed hosting, with no CMS or database. Please confirm — or tell us if there is a WordPress or other admin panel we're not seeing.

7. **Can we have cPanel (or equivalent hosting) login details?** We want to add the new careers link to the site's menu and, later, place a small verification file in the web root for Google Search Console. Read/write FTP or File Manager access to the web root would also be sufficient.

8. **Where are the website's source files?** Do you hold the original HTML/image files? If we ever need to hand the site to someone else, can you provide a full backup (a zip of the web root) on request? Please confirm you can supply this.

9. **Who pays for the hosting, and when does it renew?** Please give the plan name, renewal date, and approximate annual cost, so the owner knows what's in place.

**C. Domain and registrar**

10. **Who is the domain registered through, and who has the registrar login?** Our records show the registrar is Tucows, resold via Turbify, with the domain expiring on **19 March 2027**. Please confirm, and confirm that auto-renew is ON. If the registrar account is in your company's name rather than Blue Chip's, we would like to discuss transferring ownership to Blue Chip.

**D. Email — please be careful with this section**

11. **Confirm the email setup.** We see mail is handled by Turbify/Yahoo Business Mail (`mx-biz.mail.am0.yahoodns.net`). Please confirm this is correct, list **all** active mailboxes on the domain, and confirm whether email is billed separately from hosting.

12. **Is there anything in the DNS that email depends on which we might not see?** We note there are currently **no SPF, DKIM or DMARC (`TXT`) records** on the domain. Please confirm whether that is correct, or whether such records exist in a form we cannot query from outside. If any special records are required by Turbify for mail to work, list them exactly.

**E. SSL certificates**

13. **How is the HTTPS certificate handled today?** It appears to be cPanel AutoSSL with Let's Encrypt, renewing automatically. Please confirm — and confirm that **no manual action is needed from anyone** to keep it renewing. We want to know whether a DNS change could disturb that renewal.

**F. Lock-ins and commercials**

14. **Is there any contract, AMC or notice period** that restricts changing DNS, adding a subdomain, or moving hosting later? Please state the terms and end date.

15. **Is there any part of the setup that only your team can access** — anything where, if you were unreachable, Blue Chip could not recover the website, domain, DNS or email? Please be honest about this; we would like to fix any such gap now rather than discover it later.

16. **What would you charge**, if anything, to make the DNS changes in question 4 (or the nameserver change in question 5)? Please quote separately so the owner can approve.

### What we need most urgently

If you can only answer a few things right now, please send these three first:

- **Question 3** — the full list of existing DNS records
- **Question 5** — whether the nameservers can be changed and the registrar lock lifted
- **Question 11** — confirmation of the email setup

Thank you. Please reply to Ram, or call if it's easier to go through this on the phone.

---

*(End of vendor brief — everything above this line can be sent as-is.)*

---

# Part 3 — Google for Jobs: what the candidate portal must do to be indexed

A job board that isn't in Google for Jobs is close to worthless — in India, Google's job search box is a primary jobseeker entry point. Google for Jobs **launched in India in April 2018** and is live here ([Medianama](https://www.medianama.com/2018/04/223-google-jobs-search-launched-india/), [YourStory](https://yourstory.com/2018/04/google-launches-job-search-india-partners-multiple-portals)).

There is **no application, no partnership and no fee**. Google picks up postings purely from `JobPosting` structured data on crawlable pages. Get the markup right and you're in; get it wrong and you're invisible.

## Required properties

Per [Google's JobPosting structured data documentation](https://developers.google.com/search/docs/appearance/structured-data/job-posting), every posting page must carry JSON-LD with:

| Property | Rule |
|---|---|
| `title` | **Job title only.** No company name, no location, no salary, no req code. `"Accounts Executive"` — not `"Accounts Executive – Chennai – Blue Chip – 3LPA"`. This is the most commonly broken rule on Indian job boards. |
| `description` | Full details in **HTML** with paragraph breaks. **Must not be identical to the title.** |
| `datePosted` | ISO 8601, e.g. `"2026-09-15"` |
| `hiringOrganization` | `Organization` object with `name`, `sameAs` (the company's own website), optional `logo` |
| `jobLocation` | `Place` → `PostalAddress`, **must include `addressCountry`** (`"IN"`). Include `addressLocality` ("Chennai") and `addressRegion` ("Tamil Nadu"). |

## Strongly recommended

- `validThrough` — ISO 8601 expiry. Google's docs: *"If a job posting never expires, or you do not know when the job will expire, do not include this property."*
- `baseSalary` — `MonetaryAmount` with `"INR"` and a `QuantitativeValue` (`minValue`/`maxValue`, `unitText: "MONTH"` or `"YEAR"`). Optional for Google, but salary-bearing listings get materially better click-through in India.
- `employmentType` — one of `FULL_TIME`, `PART_TIME`, `CONTRACTOR`, `TEMPORARY`, `INTERN`, `VOLUNTEER`, `PER_DIEM`, `OTHER`
- `identifier` — `PropertyValue` with Blue Chip's internal requirement ID. **Wire this straight to the internal app's `Requirements` primary key** — it's free to do at build time and painful to retrofit.
- `directApply` — boolean; `true` if the candidate completes the application on your page without being bounced elsewhere. Since Blue Chip's portal *is* the application, set it `true`.
- `jobLocationType: "TELECOMMUTE"` + `applicantLocationRequirements` — only for fully remote roles.

## Rules that will bite a recruitment agency specifically

1. **One posting per page.** Google: *"JobPosting markup must only be used on pages that contain a single job posting."* Never put the markup on the listings/search page. Architecture: `/jobs` = browsable index (no markup), `/jobs/[id]` = one posting each (markup here).

2. **Expired jobs must be removed promptly**, by one of: setting `validThrough` to a past date, returning **404 or 410**, or stripping the `JobPosting` markup. Failing to do this earns a **manual action** from Google. For an agency where roles close constantly, this must be **automatic** — driven by the requirement's status in the internal app, never a manual chore. This is the #1 way agency job boards get penalised.

3. **`hiringOrganization` is the actual employer, not Blue Chip.** Blue Chip is the agency, not the hirer. If clients are confidential, the honest pattern is to name the employer where permitted and otherwise be accurate rather than stuffing "Blue Chip HR Solutions" into every posting — Google's guidelines treat misrepresenting the hiring organisation as a quality problem.

4. **The page must be crawlable.** Not behind a login, not `noindex`, not iframed, and not rendered only after a client-side fetch that Googlebot may not wait for. With Next.js, **server-render the posting pages** (SSR or SSG with revalidation) and emit the JSON-LD in the initial HTML. This is the technical reason Option 4 (iframe) was rejected.

## Getting found quickly

- **Sitemap:** publish `/sitemap.xml` with accurate `<lastmod>` values. Google notes accurate `lastmod` prevents needless re-crawling.
- **Indexing API:** Google explicitly prefers it for jobs — *"For job posting URLs, we recommend using the Indexing API instead of sitemaps because the Indexing API prompts Googlebot to crawl your page sooner."* It is one of only **two** eligible content types (`JobPosting` and `BroadcastEvent` in a `VideoObject`). Setup: enable the API, create a **service account**, verify the site in **Search Console**, then send `URL_UPDATED` on publish and `URL_DELETED` on close. Batch up to 100 URLs per call. **Default quota is 200 requests/day** — fine for Blue Chip's volume; more can be requested. ([Indexing API quickstart](https://developers.google.com/search/apis/indexing-api/v3/quickstart))
- **Validate before launch** with Google's Rich Results Test and the Search Console *Job Postings* report.

**Build note:** emit the JSON-LD from the same data the internal app already holds in `Requirements`. Do not maintain job content in two places — divergence between what the page says and what the markup says is both a Google quality problem and an ops headache.

---

## Summary of the decision

| | |
|---|---|
| **Recommended** | **Option 2** — move bluechiphr.com DNS to Cloudflare, keep site and email exactly where they are. Free, one-time, permanently unblocking. |
| **Fallback** | **Option 1** — Cloudflare for SaaS custom hostname, if the owner won't move nameservers. Also free, but leaves Ram vendor-dependent forever. |
| **Rejected** | **Option 3** (vendor rebuild — costs money, doesn't solve the DNS constraint, puts candidate PII in a third party). **Option 4** (iframe — kills Google for Jobs indexing outright). |
| **Do first, blocked on nobody** | Build both portals now at `careers.blacandpink.com` on the existing tunnel. The final hostname becomes a 30-second change later. |
