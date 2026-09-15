// app/api/public/_ratelimit.js — the one rate limiter the public routes share.
//
// NOT a route. A file inside a route folder is only a route when it is called
// route.js, so this is an ordinary module; the leading underscore is a signal
// to the next person, not a Next.js convention doing any work.
//
// It started life inside app/api/public/apply/route.js. Copying it into the
// second public route would have meant two windows, two limits and two places
// to fix when one of them turned out to be wrong, so it moved here instead and
// both routes call it.
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
 * Record a hit and say whether this caller has had too many.
 *
 * `bucket` keeps the counts for different forms apart: applying for six jobs in
 * an afternoon is normal, posting six hiring enquiries is not, and one shared
 * counter would either allow the second or forbid the first.
 */
export function tooMany(bucket, ip, { windowMs = 60 * 60 * 1000, max = 10 } = {}) {
  const now = Date.now();
  const key = `${bucket}:${ip}`;
  const list = (BUCKETS.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  BUCKETS.set(key, list);

  // Sweep, so a long-lived process does not hold a row for every address that
  // ever touched the site. Only when the map is already large: doing it on
  // every request would walk the whole map on every request.
  if (BUCKETS.size > 5000) {
    for (const [k, v] of BUCKETS) {
      if (!v.some((t) => now - t < windowMs)) BUCKETS.delete(k);
    }
  }

  return list.length > max;
}
