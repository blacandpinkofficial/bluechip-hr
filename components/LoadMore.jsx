"use client";
// The bottom of a long list.
//
// Every list screen used to end with however many rows the server felt like
// sending — two hundred candidates, three hundred interviews — and no sign
// that there were more. The count in the heading counted what had arrived, so
// at the ceiling it stopped being a count and became the ceiling, wearing the
// count's clothes.
//
// This says the true figure and offers the next page. Three states and they are
// all worth distinguishing:
//
//   everything fits   → one quiet line, or nothing at all for a short list.
//   more to come      → the true total, and a button.
//   loading           → the button says so and cannot be pressed twice.
//
// It renders nothing when a list is short enough not to need it: a "Showing 6
// of 6" under six rows is noise, and noise is what people learn to skip past on
// the day it finally says something.

export default function LoadMore({ shown, total, hasMore, busy, onMore, noun = "rows" }) {
  const n = Number(shown) || 0;
  const t = Number(total) || 0;
  // `hasMore` comes from the server, which knows the offset it actually served.
  // Comparing the count against what is on screen looks equivalent and is not:
  // the pages drop a duplicate row when one is inserted between two requests,
  // so the on-screen length stops tracking the offset, the comparison stays
  // true forever, and the button sits there loading nothing.
  if (!hasMore) {
    // Only worth a line once the list is long enough that somebody might wonder.
    if (n < 25) return null;
    return (
      <p className="text-xs text-slate-400 text-center py-4">
        All {t || n} {noun}.
      </p>
    );
  }

  return (
    <div className="flex flex-col items-center gap-2 py-5">
      <p className="text-xs text-slate-500">
        Showing {n} of {t} {noun}.
      </p>
      <button type="button" className="btn-ghost" onClick={onMore} disabled={busy}>
        {busy ? "Loading…" : "Load more"}
      </button>
      <p className="text-[11px] text-slate-400">
        Searching or filtering is faster than paging to the end.
      </p>
    </div>
  );
}
