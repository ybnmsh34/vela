import { describe, expect, it } from 'vitest';

import {
  formatDuration,
  formatInstant,
  fromLocalDateTimeValue,
  nextWholeHour,
  toLocalDateTimeValue,
} from './schedule-times';

/**
 * The clock arithmetic, driven with no DOM.
 *
 * **Every expectation here is built from a locally-constructed `Date`, never
 * from a hard-coded epoch millisecond.** The suite runs on whatever timezone the
 * machine is set to, and a test that pinned an absolute instant would be
 * asserting the operator's offset rather than this module's behaviour — green in
 * one zone and red in the next. The two exceptions are {@link formatInstant},
 * which is handed an explicit locale and zone precisely so its *shape* can be
 * pinned, and {@link formatDuration}, which has no zone in it at all.
 */

/** A local wall clock reading, as an instant, without using the module. */
function local(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): number {
  return new Date(year, month - 1, day, hour, minute, second, ms).getTime();
}

describe('toLocalDateTimeValue', () => {
  it('writes the local wall clock in the shape the input accepts', () => {
    expect(toLocalDateTimeValue(local(2026, 8, 16, 9, 5))).toBe('2026-08-16T09:05');
  });

  it('pads every field, so a single-digit month is not a rejected value', () => {
    // `2026-1-2T3:4` is not in the value space of `datetime-local`; a browser
    // silently blanks the field, and the form loses the time the user picked.
    expect(toLocalDateTimeValue(local(2026, 1, 2, 3, 4))).toBe('2026-01-02T03:04');
  });

  it('drops the seconds rather than scheduling on one', () => {
    expect(toLocalDateTimeValue(local(2026, 8, 16, 9, 5, 37, 412))).toBe('2026-08-16T09:05');
  });
});

describe('fromLocalDateTimeValue', () => {
  it('reads a local wall clock as the instant that clock means', () => {
    expect(fromLocalDateTimeValue('2026-08-16T09:05')).toBe(local(2026, 8, 16, 9, 5));
  });

  it('round-trips whatever the writer wrote', () => {
    const instant = local(2026, 11, 30, 23, 59);
    expect(fromLocalDateTimeValue(toLocalDateTimeValue(instant))).toBe(instant);
  });

  it('accepts the seconds some engines append, and ignores them', () => {
    expect(fromLocalDateTimeValue('2026-08-16T09:05:37')).toBe(local(2026, 8, 16, 9, 5));
    expect(fromLocalDateTimeValue('2026-08-16T09:05:37.412')).toBe(local(2026, 8, 16, 9, 5));
  });

  it('answers null for an empty field rather than throwing at it', () => {
    // The ordinary state of a field the user has just cleared. A throw here
    // would make clearing the box an error report.
    expect(fromLocalDateTimeValue('')).toBeNull();
    expect(fromLocalDateTimeValue('   ')).toBeNull();
  });

  it('answers null for anything that is not a local date-time', () => {
    for (const attempt of [
      'tomorrow',
      '2026-08-16',
      '09:05',
      '2026-08-16 09:05',
      '2026-08-16T09',
      '2026-08-16T09:05Z',
      '2026-08-16T09:05+01:00',
    ]) {
      expect(fromLocalDateTimeValue(attempt), attempt).toBeNull();
    }
  });

  it('refuses a date that does not exist instead of silently moving it', () => {
    // `new Date(2026, 1, 30)` is the 2nd of March and says nothing about it.
    expect(fromLocalDateTimeValue('2026-02-30T09:00')).toBeNull();
    expect(fromLocalDateTimeValue('2026-13-01T09:00')).toBeNull();
    expect(fromLocalDateTimeValue('2026-04-31T09:00')).toBeNull();
    // The leap day is a real date in 2028 and must survive the same check.
    expect(fromLocalDateTimeValue('2028-02-29T09:00')).toBe(local(2028, 2, 29, 9, 0));
  });

  it('reads a two-digit year as itself, not as nineteen-hundred-and-that', () => {
    // `new Date(26, 0, 1)` is 1926. The constructor applies that rule to any
    // year below 100 however many digits were written, which is why
    // `setFullYear` is called unconditionally rather than behind a range check.
    const parsed = fromLocalDateTimeValue('0026-01-01T00:00');
    expect(parsed).not.toBeNull();
    expect(new Date(parsed ?? 0).getFullYear()).toBe(26);
  });
});

describe('nextWholeHour', () => {
  it('lands on the next hour boundary', () => {
    expect(nextWholeHour(local(2026, 8, 16, 9, 37, 12, 345))).toBe(local(2026, 8, 16, 10, 0));
  });

  it('is strictly in the future even when the clock is already on the hour', () => {
    // The one case an "if we are past it" implementation gets wrong. A first run
    // exactly now is a first run already owed: the next poll fires it.
    const onTheHour = local(2026, 8, 16, 9, 0);
    expect(nextWholeHour(onTheHour)).toBe(local(2026, 8, 16, 10, 0));
    expect(nextWholeHour(onTheHour)).toBeGreaterThan(onTheHour);
  });

  it('rolls into the next day, month and year', () => {
    expect(nextWholeHour(local(2026, 8, 16, 23, 40))).toBe(local(2026, 8, 17, 0, 0));
    expect(nextWholeHour(local(2026, 12, 31, 23, 40))).toBe(local(2027, 1, 1, 0, 0));
  });
});

describe('formatInstant', () => {
  it('is a medium date and a short time, in the locale it is given', () => {
    // Pinned with an explicit locale and zone. The pane passes neither — the
    // reader gets their own — so what this holds is the *choice of format*, not
    // the machine the suite happens to run on.
    expect(formatInstant(Date.UTC(2026, 7, 16, 9, 5), 'en-GB', 'UTC')).toBe('16 Aug 2026, 09:05');
  });

  it('answers the same instant differently in a different zone, which is the point', () => {
    const instant = Date.UTC(2026, 7, 16, 23, 30);
    expect(formatInstant(instant, 'en-GB', 'UTC')).not.toBe(
      formatInstant(instant, 'en-GB', 'Asia/Tokyo'),
    );
  });
});

describe('formatDuration', () => {
  it('stays in milliseconds below a second and switches to seconds above one', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(340)).toBe('340ms');
    expect(formatDuration(999)).toBe('999ms');
    expect(formatDuration(1_000)).toBe('1.0s');
    expect(formatDuration(1_234)).toBe('1.2s');
    expect(formatDuration(90_000)).toBe('90.0s');
  });

  it('never renders a negative duration, which a clock that went backwards can produce', () => {
    expect(formatDuration(-5)).toBe('0ms');
  });
});
