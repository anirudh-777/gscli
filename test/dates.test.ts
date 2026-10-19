import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addMonths,
  assertIso,
  previousRange,
  rangeFromLast,
  resolveRange,
  todayInPacific,
  yearAgoRange,
} from '../src/dates.ts';
import { CliError } from '../src/errors.ts';

describe('rangeFromLast', () => {
  it('counts days inclusively', () => {
    assert.deepEqual(rangeFromLast('7d', '2026-10-17'), { startDate: '2026-10-11', endDate: '2026-10-17' });
    assert.deepEqual(rangeFromLast('28d', '2026-10-17'), { startDate: '2026-09-20', endDate: '2026-10-17' });
  });

  it('supports weeks, months and years', () => {
    assert.equal(rangeFromLast('4w', '2026-10-17').startDate, '2026-09-20');
    assert.equal(rangeFromLast('3m', '2026-10-17').startDate, '2026-07-18');
    assert.equal(rangeFromLast('1y', '2026-10-17').startDate, '2025-10-18');
  });

  it('rejects malformed spans', () => {
    assert.throws(() => rangeFromLast('7', '2026-10-17'), CliError);
    assert.throws(() => rangeFromLast('0d', '2026-10-17'), CliError);
    assert.throws(() => rangeFromLast('2q', '2026-10-17'), CliError);
  });
});

describe('comparison ranges', () => {
  it('previousRange is the same length and ends the day before', () => {
    assert.deepEqual(previousRange({ startDate: '2026-09-20', endDate: '2026-10-17' }), {
      startDate: '2026-08-23',
      endDate: '2026-09-19',
    });
  });

  it('yearAgoRange shifts calendar dates and clamps leap days', () => {
    assert.deepEqual(yearAgoRange({ startDate: '2028-02-29', endDate: '2028-03-31' }), {
      startDate: '2027-02-28',
      endDate: '2027-03-31',
    });
  });

  it('addMonths clamps to the end of shorter months', () => {
    assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
  });
});

describe('resolveRange', () => {
  const latest = async () => '2026-10-17';

  it('defaults to 28 days ending on the latest data date', async () => {
    assert.deepEqual(await resolveRange({}, latest), { startDate: '2026-09-20', endDate: '2026-10-17' });
  });

  it('does not look up the latest date when --end is given', async () => {
    const range = await resolveRange({ start: '2026-01-01', end: '2026-01-31' }, () => {
      throw new Error('should not be called');
    });
    assert.deepEqual(range, { startDate: '2026-01-01', endDate: '2026-01-31' });
  });

  it('rejects --start with --last, and inverted ranges', async () => {
    await assert.rejects(resolveRange({ start: '2026-01-01', last: '7d' }, latest), CliError);
    await assert.rejects(resolveRange({ start: '2026-02-01', end: '2026-01-01' }, latest), CliError);
  });
});

describe('assertIso', () => {
  it('rejects impossible dates', () => {
    assert.throws(() => assertIso('2026-02-30', '--start'), CliError);
    assert.throws(() => assertIso('2026-1-1', '--start'), CliError);
    assert.doesNotThrow(() => assertIso('2024-02-29', '--start'));
  });
});

describe('todayInPacific', () => {
  it('uses Pacific time, not UTC', () => {
    // 05:00 UTC on Oct 18 is still Oct 17 in Los Angeles.
    assert.equal(todayInPacific(new Date('2026-10-18T05:00:00Z')), '2026-10-17');
  });
});
