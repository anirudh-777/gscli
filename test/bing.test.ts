import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { aggregateStats, BingClient, matchBingSite, parseBingDate, resolveBingSite, siteContains, type BingStatsRow } from '../src/bing.ts';
import { CliError } from '../src/errors.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function run(...args: string[]) {
  const env = { ...process.env };
  delete env.GSC_BING_API_KEY;
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** A fetch that records requests and answers each with the next response. */
function fakeFetch(...responses: { status?: number; body: unknown }[]) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    const next = responses.shift()!;
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const day = (iso: string) => `/Date(${Date.parse(`${iso}T07:00:00Z`)}-0700)/`;

describe('parseBingDate', () => {
  it('reads the date in the stated offset', () => {
    assert.equal(parseBingDate(day('2026-10-01')), '2026-10-01');
    assert.equal(parseBingDate('/Date(1316156400000)/'), '2011-09-16');
  });

  it('treats year 1 and junk as no date', () => {
    assert.equal(parseBingDate('/Date(-62135568000000)/'), undefined);
    assert.equal(parseBingDate('yesterday'), undefined);
    assert.equal(parseBingDate(undefined), undefined);
  });
});

describe('matchBingSite', () => {
  const sites = ['http://example.com/', 'https://example.com/', 'https://www.example.com/', 'https://example.com/blog/'];

  it('accepts Search Console forms for a host', () => {
    assert.equal(matchBingSite('example.com', sites), 'https://example.com/');
    assert.equal(matchBingSite('sc-domain:example.com', sites), 'https://example.com/');
    assert.equal(matchBingSite('www.example.com', sites), 'https://www.example.com/');
  });

  it('picks the longest site that contains a URL', () => {
    assert.equal(matchBingSite('https://example.com/blog/post', sites), 'https://example.com/blog/');
    assert.equal(matchBingSite('https://example.com/pricing', sites), 'https://example.com/');
    assert.equal(matchBingSite('https://example.com/blog', sites), 'https://example.com/blog/');
  });

  it('does not treat a path as a prefix of a longer segment', () => {
    assert.equal(matchBingSite('https://example.com/blogger/post', ['https://example.com/blog']), undefined);
    assert.equal(matchBingSite('https://example.com/blog/post', ['https://Example.com/blog']), 'https://Example.com/blog');
  });

  it('finds nothing for another host', () => {
    assert.equal(matchBingSite('other.com', sites), undefined);
  });
});

describe('siteContains', () => {
  it('checks the whole site URL, not just the host', () => {
    assert.ok(siteContains('https://example.com/', 'https://example.com/pricing'));
    assert.ok(siteContains('https://example.com/blog/', 'https://example.com/blog'));
    assert.ok(!siteContains('https://example.com/blog/', 'https://example.com/pricing'));
    assert.ok(!siteContains('https://example.com/', 'http://example.com/pricing'));
  });
});

describe('aggregateStats', () => {
  const row = (Query: string, date: string, Clicks: number, Impressions: number, AvgImpressionPosition: number): BingStatsRow => ({
    Query,
    Date: day(date),
    Clicks,
    Impressions,
    AvgClickPosition: 0,
    AvgImpressionPosition,
  });

  it('sums rows in range by key and weights position by impressions', () => {
    const rows = [
      row('shoes', '2026-09-01', 10, 100, 2),
      row('shoes', '2026-09-08', 5, 300, 6),
      row('boots', '2026-09-08', 20, 50, -1),
      row('shoes', '2026-08-01', 99, 999, 1),
    ];
    assert.deepEqual(aggregateStats(rows, { startDate: '2026-09-01', endDate: '2026-09-30' }), [
      { key: 'boots', clicks: 20, impressions: 50, ctr: 0.4, position: 0 },
      { key: 'shoes', clicks: 15, impressions: 400, ctr: 0.0375, position: 5 },
    ]);
  });
});

describe('BingClient', () => {
  it('passes the key and parameters and unwraps d', async () => {
    const { fetch, calls } = fakeFetch({ body: { d: [{ Url: 'https://a.com/', IsVerified: true }] } });
    const client = new BingClient({ apiKey: 'k', fetch });
    assert.deepEqual(await client.get('GetUserSites', { siteUrl: 'https://a.com/' }), [{ Url: 'https://a.com/', IsVerified: true }]);
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, '/webmaster/api.svc/json/GetUserSites');
    assert.equal(url.searchParams.get('apikey'), 'k');
    assert.equal(url.searchParams.get('siteUrl'), 'https://a.com/');
  });

  it('posts JSON bodies', async () => {
    const { fetch, calls } = fakeFetch({ body: { d: null } });
    await new BingClient({ apiKey: 'k', fetch }).post('SubmitFeed', { siteUrl: 'https://a.com/', feedUrl: 'https://a.com/s.xml' });
    assert.equal(calls[0]!.method, 'POST');
    assert.deepEqual(calls[0]!.body, { siteUrl: 'https://a.com/', feedUrl: 'https://a.com/s.xml' });
  });

  it('maps Bing error codes to exit codes', async () => {
    const fail = async (ErrorCode: number, Message: string) => {
      const { fetch } = fakeFetch({ status: 400, body: { ErrorCode, Message } });
      return new BingClient({ apiKey: 'k', fetch }).get('GetUserSites').catch((e: CliError) => e);
    };
    const invalidKey = (await fail(3, 'ERROR!!! InvalidApiKey')) as CliError;
    assert.equal(invalidKey.code, 'auth');
    assert.equal(invalidKey.message, 'Bing Webmaster: InvalidApiKey');
    assert.equal(((await fail(4, 'ThrottleUser')) as CliError).code, 'quota');
    assert.equal(((await fail(14, 'NotAuthorized')) as CliError).code, 'permission');
    assert.equal(((await fail(8, 'InvalidParameter')) as CliError).code, 'usage');
  });

  it('picks the site from a URL when nothing else names one', async () => {
    delete process.env.GSC_BING_SITE;
    delete process.env.GSC_SITE;
    const sites = { body: { d: [{ Url: 'https://a.com/', IsVerified: true }, { Url: 'https://b.com/', IsVerified: true }] } };
    const client = new BingClient({ apiKey: 'k', fetch: fakeFetch(sites, sites).fetch });
    assert.equal(await resolveBingSite(client, undefined, 'https://b.com/pricing'), 'https://b.com/');
    process.env.GSC_SITE = 'a.com';
    try {
      assert.equal(await resolveBingSite(new BingClient({ apiKey: 'k', fetch: fakeFetch(sites).fetch }), undefined, 'https://b.com/x'), 'https://b.com/');
    } finally {
      delete process.env.GSC_SITE;
    }
    assert.equal(((await resolveBingSite(client, undefined).catch((e: CliError) => e)) as CliError).code, 'usage');
  });

  it('does not retry POSTs, which may have taken effect', async () => {
    const { fetch, calls } = fakeFetch({ status: 503, body: {} }, { body: { d: null } });
    const err = await new BingClient({ apiKey: 'k', fetch, retryDelayMs: 0 }).post('SubmitUrlBatch', {}).catch((e: CliError) => e);
    assert.ok(err instanceof CliError);
    assert.equal(calls.length, 1);
  });

  it('retries server errors', async () => {
    const { fetch, calls } = fakeFetch({ status: 503, body: {} }, { body: { d: 1 } });
    assert.equal(await new BingClient({ apiKey: 'k', fetch, retryDelayMs: 0 }).get('GetUrlSubmissionQuota'), 1);
    assert.equal(calls.length, 2);
  });
});

describe('gscli bing', () => {
  it('rejects bad subcommands and flags before asking for a key', () => {
    assert.equal(run('bing').code, 2);
    assert.equal(run('bing', 'nope').code, 2);
    assert.equal(run('bing', 'queries', '--sort', 'nope').code, 2);
    assert.equal(run('bing', 'traffic', '--last', 'yesterday').code, 2);
    assert.equal(run('bing', 'sites', 'extra').code, 2);
  });

  it('exits 3 with a hint when no API key is set', () => {
    const res = run('bing', 'sites');
    assert.equal(res.code, 3);
    assert.match(JSON.parse(res.stderr).error.hint, /API Access/);
  });

  it('is listed in help', () => {
    assert.match(run('--help').stdout, /bing\s+Bing Webmaster Tools/);
    assert.match(run('help', 'bing').stdout, /GSC_BING_API_KEY/);
  });
});
