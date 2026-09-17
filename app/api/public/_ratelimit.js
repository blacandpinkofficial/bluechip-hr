// Moved to lib/ratelimit.js when the login route needed it too — a module that
// is not a route has no business living under app/. Re-exported from here so
// the two public routes that import "../_ratelimit" keep working; import from
// "@/lib/ratelimit" in anything new.
export { clientIp, tooMany } from "@/lib/ratelimit";
