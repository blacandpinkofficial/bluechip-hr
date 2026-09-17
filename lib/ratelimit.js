// lib/ratelimit.js — the one rate limiter, for every route that needs one.
//
// It started inside app/api/public/apply/route.js, then moved next to the
// public routes as _ratelimit.js when a second one needed it. It is here now
// because the login route needs it too, and the login route is not public —
// reaching up out of app/api/public/ to borrow it would have been the third
// home in a month. Modules that are not routes live in lib/; that is the whole
// rule, and app/api/public/_ratelimit.js is now a two-line re-export so the two
// public routes did not have to change.
//
// What it is: a per-process, in-memory sliding window. What it is NOT: a rate
// limiter. It is lost on every restart and every deploy, and it counts only
// what reached THIS node process. It stops a loop and a careless script. It
// does not stop anyone who can restart the conversation from a new address, and
// with the app behind a Cloudflare tunnel the only real limiter belongs at
// Cloudflare, in front of the tunnel, where the request can be dropped before
// it costs a database connection.

const BUCKETS = new Map();

/**
 * The caller's address, as well as it can be known from behind a tunnel.
 *
 * Every one of these headers is written by a proxy and can be forged by anyone
 * talking to the origin directly, so this is a key for counting, never an
 * identity and never an authorisation. cf-connecting-ip is first because
 * Cloudflare sets it and overwrites whatever the client claimed; x-forwarded-for
 * is taken apart and only the left-most hop used, which is the one Cloudflare
 * put there.
 */
export function clientIp(req) {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim().slice(0, 64);
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0];
    if (first && first.trim()) return first.trim().slice(0, 64);
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim().slice(0, 64);
  return "unknown";
}

/**
 * Has this caller already had too many, WITHOUT recording another?
 *
 * Separate from recording on purpose. The first version pushed a timestamp and
 * then compared, so a caller who was already over kept pushing the window
 * forward every time they tried again — which on a shared office address meant
 * the lockout could only end in a stretch of minutes during which nobody in the
 * building attempted anything. A check that makes the thing it is checking
 * worse is not a limit, it is a trap.
 *
 * `bucket` keeps different questions apart: applying for six jobs in an
 * afternoon is normal, posting six hiring enquiries is not, and one shared
 * counter would either allow the second or forbid the first.
 */
export function overLimit(bucket, key, { windowMs = 60 * 60 * 1000, max = 10 } = {}) {
  const now = Date.now();
  const list = BUCKETS.get(`${bucket}:${key}`);
  if (!list) return false;
  return list.filter((t) => now - t < windowMs).length >= max;
}

/** Record one hit against a bucket. */
export function recordFailure(bucket, key, { windowMs = 60 * 60 * 1000 } = {}) {
  const now = Date.now();
  const k = `${bucket}:${key}`;
  const list = (BUCKETS.get(k) || []).filter((t) => now - t < windowMs);
  list.push(now);
  BUCKETS.set(k, list);
  sweep(now, windowMs);
}

/** Forget this caller's hits. Used when a sign-in succeeds. */
export function clearFailures(bucket, key) {
  BUCKETS.delete(`${bucket}:${key}`);
}

/**
 * Record a hit and say whether this caller has now had too many.
 *
 * The original shape, kept for the two public forms, where counting the
 * request itself is exactly right: submitting the form IS the thing being
 * limited, and there is no "succeeded" to forgive.
 */
export function tooMany(bucket, key, { windowMs = 60 * 60 * 1000, max = 10 } = {}) {
  const now = Date.now();
  const k = `${bucket}:${key}`;
  const list = (BUCKETS.get(k) || []).filter((t) => now - t < windowMs);
  list.push(now);
  BUCKETS.set(k, list);
  sweep(now, windowMs);
  return list.length > max;
}

/**
 * Drop rows nothing is counting any more, so a long-lived process does not hold
 * an array for every address and every mailbox that ever touched the site. Only
 * above a threshold: walking the whole map on every request would cost more
 * than the thing it is tidying.
 */
function sweep(now, windowMs) {
  if (BUCKETS.size <= 5000) return;
  for (const [k, v] of BUCKETS) {
    if (!v.some((t) => now - t < windowMs)) BUCKETS.delete(k);
  }
}
