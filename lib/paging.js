// lib/paging.js — how a list route answers "and the rest?"
//
// Every list in this app was written the same way: findMany with a take of a
// few hundred and nothing else. That is not pagination, it is a ceiling. Three
// things follow from it, and the third is the one that bites.
//
//   1. The response carries every row at once. Two hundred candidates with
//      their owner, their opening, the client on it, the last call and a count
//      of interviews is a large JSON document to build, send and parse, on a
//      phone, on a desk where somebody reloads this screen all morning.
//
//   2. The count on screen is the number of rows that FIT, so it quietly stops
//      being the truth at the ceiling and never says so. "200 candidates" is
//      what 200 and 2,000 both look like.
//
//   3. Row 201 cannot be reached at all. Not by scrolling, not by clicking:
//      there is no next page to ask for, and the only way to see an older
//      candidate is to search for them by a name you must already know.
//
// So: a page size, an offset, and a real count() taken against the same where
// clause — the count is the whole point, because it is what lets a screen say
// "50 of 1,340" instead of quietly lying at the ceiling.
//
// Offset paging, not a cursor. Cursors are better under load and worse to read,
// and these lists are re-sorted by the person looking at them (due, cold,
// history, by client, by status) which is exactly the case cursors handle
// badly. At this size — a placement desk, not a marketplace — an OFFSET is a
// few milliseconds and the code stays something a person can follow.

/** What a list hands back when nothing says otherwise. */
export const DEFAULT_PAGE = 100;

/**
 * The most any single request may ask for. A cap, not a suggestion: `take` comes
 * off the query string, so without it one crafted URL asks the database for
 * every candidate on the desk in one go.
 *
 * 500 rather than something tidier because the openings dropdown on the call
 * list and on the import screen genuinely do want every open requirement at
 * once — a picker that silently stops at a hundred is a requirement somebody
 * cannot select and no message saying why. Those two ask for take=500
 * explicitly. Nothing else should: a list a person reads gets a page.
 */
export const MAX_PAGE = 500;

function toInt(v) {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read `take` and `skip` off a URL, clamped.
 *
 *   const { take, skip } = pageParams(url);
 *   const [rows, totalCount] = await Promise.all([
 *     prisma.thing.findMany({ where, orderBy, take, skip, include }),
 *     prisma.thing.count({ where }),
 *   ]);
 *   return NextResponse.json({ things: rows, ...pageMeta({ take, skip, totalCount, rows }) });
 *
 * The count MUST use the same where as the findMany. A count over a wider
 * clause gives a "load more" button that loads nothing, which reads as a broken
 * button rather than as an empty page.
 */
export function pageParams(url, { size = DEFAULT_PAGE, max = MAX_PAGE } = {}) {
  const asked = toInt(url.searchParams?.get("take"));
  // take=0 means "you did not really ask", not "give me one row".
  const take = Math.min(Math.max(asked && asked > 0 ? asked : size, 1), max);

  // skip is clamped at BOTH ends. The floor is obvious; the ceiling is the one
  // that matters, because `?skip=99999999999` parses to a perfectly finite
  // number that is larger than a Postgres int, and Prisma answers that with a
  // validation error thrown out of a GET handler that has no try/catch around
  // it — so one crafted URL turns every list in the app into a 500.
  const MAX_SKIP = 1e7;
  const asked_skip = toInt(url.searchParams?.get("skip")) ?? 0;
  const skip = Math.min(Math.max(asked_skip, 0), MAX_SKIP);

  return { take, skip };
}

/**
 * The block every paged response carries, so the screens can all read the same
 * shape rather than each inventing its own.
 *
 * `hasMore` is derived from the count rather than from "did we get a full
 * page", because a full last page is common and an empty "load more" is the
 * one thing worse than no button.
 */
export function pageMeta({ take, skip, totalCount, rows }) {
  const returned = Array.isArray(rows) ? rows.length : 0;
  return {
    totalCount,
    page: { take, skip, returned, hasMore: skip + returned < totalCount },
  };
}
