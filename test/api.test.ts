import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AuthClient } from 'google-auth-library';
import { PAGE_SIZE, searchAnalytics } from '../src/api.ts';
import { SearchConsoleClient } from '../src/client.ts';
import { CliError } from '../src/errors.ts';

const RANGE = { startDate: '2026-01-01', endDate: '2026-01-28' };

interface Body {
  rowLimit: number;
  startRow: number;
}

/** A client whose search analytics endpoint serves `total` rows. */
function analyticsClient(total: number) {
  const requests: Body[] = [];
  const client = {
    async webmasters(_path: string, options: { body: Body }) {
      const { rowLimit, startRow } = options.body;
      requests.push({ rowLimit, startRow });
      const count = Math.max(0, Math.min(rowLimit, total - startRow));
      const rows = Array.from({ length: count }, (_, i) => ({
        keys: [`q${startRow + i}`],
        clicks: 1,
        impressions: 10,
        ctr: 0.1,
        position: 3,
      }));
      return { rows };
    },
  } as unknown as SearchConsoleClient;
  return { client, requests };
}

describe('searchAnalytics paging', () => {
  it('pages through every row when the limit is Infinity', async () => {
    const { client, requests } = analyticsClient(2 * PAGE_SIZE + 100);
    const rows = await searchAnalytics(client, 'sc-domain:a.com', { ...RANGE, dimensions: ['query'], limit: Infinity });
    assert.equal(rows.length, 2 * PAGE_SIZE + 100);
    assert.deepEqual(requests, [
      { rowLimit: PAGE_SIZE, startRow: 0 },
      { rowLimit: PAGE_SIZE, startRow: PAGE_SIZE },
      { rowLimit: PAGE_SIZE, startRow: 2 * PAGE_SIZE },
    ]);
    assert.equal(rows.at(-1)!.query, `q${2 * PAGE_SIZE + 99}`);
  });

  it('asks only for the rows still needed on the last page', async () => {
    const { client, requests } = analyticsClient(100_000);
    const rows = await searchAnalytics(client, 'sc-domain:a.com', { ...RANGE, dimensions: ['query'], limit: 30_000 });
    assert.equal(rows.length, 30_000);
    assert.deepEqual(requests, [
      { rowLimit: PAGE_SIZE, startRow: 0 },
      { rowLimit: 5_000, startRow: PAGE_SIZE },
    ]);
  });

  it('stops on an empty page when the total is an exact multiple of the page size', async () => {
    const { client, requests } = analyticsClient(PAGE_SIZE);
    const rows = await searchAnalytics(client, 'sc-domain:a.com', { ...RANGE, dimensions: ['query'], limit: Infinity });
    assert.equal(rows.length, PAGE_SIZE);
    assert.equal(requests.length, 2);
  });

  it('handles a response with no rows', async () => {
    const { client } = analyticsClient(0);
    const rows = await searchAnalytics(client, 'sc-domain:a.com', { ...RANGE, dimensions: ['query'], limit: 10 });
    assert.deepEqual(rows, []);
  });
});

/** A client whose HTTP layer answers with `responses` in order: a status code, or data for a 200. */
function retryClient(responses: (number | object)[]) {
  const client = new SearchConsoleClient({ credentials: '/nonexistent.json', retryDelayMs: 1 });
  let calls = 0;
  const fake = {
    async request() {
      const next = responses[calls++];
      if (typeof next === 'number') {
        throw Object.assign(new Error(`HTTP ${next}`), { response: { status: next, data: {} } });
      }
      return { data: next };
    },
  } as unknown as AuthClient;
  client.authClient = async () => fake;
  return { client, calls: () => calls };
}

describe('SearchConsoleClient retries', () => {
  it('retries 429 and 5xx responses, then succeeds', async () => {
    const { client, calls } = retryClient([503, 429, { siteEntry: [] }]);
    assert.deepEqual(await client.webmasters('/sites'), { siteEntry: [] });
    assert.equal(calls(), 3);
  });

  it('gives up after four attempts with a quota error', async () => {
    const { client, calls } = retryClient([429, 429, 429, 429, {}]);
    await assert.rejects(client.webmasters('/sites'), (err: unknown) => err instanceof CliError && err.code === 'quota');
    assert.equal(calls(), 4);
  });

  it('does not retry client errors', async () => {
    const { client, calls } = retryClient([400, {}]);
    await assert.rejects(client.webmasters('/sites'), (err: unknown) => err instanceof CliError && err.code === 'usage');
    assert.equal(calls(), 1);
  });
});
