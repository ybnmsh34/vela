/**
 * The clock arithmetic the schedules pane owns, in one place and with no React
 * in it.
 *
 * `src/platform/contract.ts` gives the reason this lives on this side of the
 * boundary: the host takes an absolute instant and refuses to work out what
 * "nine tomorrow" means, because the user's timezone is knowledge the renderer
 * has and the host does not. So the renderer has to turn a wall clock into an
 * epoch millisecond, and turning it back again is how the field gets a value it
 * can show.
 *
 * Everything here is a pure function of its arguments plus the ambient
 * timezone, which is what makes it testable: the pane can be driven without a
 * clock and these can be driven without a DOM.
 */

/**
 * `YYYY-MM-DDTHH:mm`, optionally with the seconds some engines append.
 *
 * This is the value space of `<input type="datetime-local">`. Seconds are
 * accepted on the way in and never written on the way out — a schedule that
 * fires at 09:00:37 is a schedule nobody asked for.
 */
const LOCAL_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/u;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/**
 * An instant as the local wall clock reads it, in the shape the input takes.
 *
 * Local, not UTC: the field is `datetime-local` and an ISO string with a `Z` on
 * it is not a value it accepts, so `toISOString` is the wrong function here even
 * though it is the obvious one.
 */
export function toLocalDateTimeValue(ms: number): string {
  const at = new Date(ms);
  return (
    `${pad(at.getFullYear(), 4)}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

/**
 * A local wall clock reading, as an absolute instant. `null` if it is not one.
 *
 * `null` rather than a throw because the empty string is the ordinary state of a
 * field the user has just cleared, and a cleared field is not an error — it is
 * a form that cannot be submitted yet.
 *
 * Two hazards, both handled rather than assumed away:
 *
 *  - **The two-digit-year legacy.** `new Date(26, 0, 1)` is 1926, not the year
 *    26, and the constructor applies that rule to any year below 100 however
 *    many digits were written. `setFullYear` is the documented escape and is
 *    called unconditionally rather than behind a range check.
 *  - **Dates that do not exist.** `new Date(2026, 1, 30)` is the 2nd of March,
 *    silently. So the calendar fields are read back and a value that did not
 *    survive the round trip is refused. Only the date is checked, not the time:
 *    a wall clock reading skipped by a daylight-saving jump is a real instant
 *    the user can mean, and this must not refuse it.
 */
export function fromLocalDateTimeValue(value: string): number | null {
  const parts = LOCAL_DATE_TIME.exec(value.trim());
  if (parts === null) return null;

  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const hour = Number(parts[4]);
  const minute = Number(parts[5]);

  const at = new Date(year, month - 1, day, hour, minute, 0, 0);
  at.setFullYear(year, month - 1, day);
  if (
    at.getFullYear() !== year ||
    at.getMonth() !== month - 1 ||
    at.getDate() !== day
  ) {
    return null;
  }
  return at.getTime();
}

/**
 * The next time the local clock reads a whole hour.
 *
 * The default the create form starts from. A whole hour rather than "now plus a
 * minute" because a schedule is a standing instruction and the user is choosing
 * a slot, not racing a stopwatch; and strictly in the future because a first run
 * already in the past fires at the very next poll and books every slot it
 * skipped as a missed run, which is a surprising way to meet a new feature.
 *
 * Wall-clock arithmetic, not `+ 3_600_000`: adding an hour of milliseconds
 * across a daylight-saving boundary lands on :30 or :00 depending on which way
 * the clocks went, and this function's whole promise is that the minutes are
 * zero.
 */
export function nextWholeHour(nowMs: number): number {
  const at = new Date(nowMs);
  at.setHours(at.getHours() + 1, 0, 0, 0);
  return at.getTime();
}

/**
 * An instant, spelled the way the reader's own machine spells one.
 *
 * `locales` and `timeZone` exist so a test can pin the *shape* — a medium date
 * and a short time — without pinning the machine the suite happens to run on.
 * The pane passes neither, which is the point: the user reads their own locale
 * and their own zone.
 */
export function formatInstant(ms: number, locales?: string, timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
  if (timeZone !== undefined) options.timeZone = timeZone;
  return new Intl.DateTimeFormat(locales, options).format(new Date(ms));
}

/**
 * How long a run took, for a table cell.
 *
 * Sub-second in milliseconds and everything else in seconds to one decimal: a
 * scheduled run is a conversation being opened, so the interesting distinction
 * is "instant" against "took a moment", not microseconds.
 */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1_000).toFixed(1)}s`;
}
