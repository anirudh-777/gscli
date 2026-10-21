// Stand-in for Google's APIs, used only to record the README demo (demo/demo.tape).
// Loaded with `node --import ./demo/mock.mjs`: it answers gscli's requests with made-up data for
// example.com, so the real CLI renders the output without credentials or a real property.
import { writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// google-auth-library sends its requests through node-fetch; point that import at the mock below.
const mockFetch = new URL('./fetch.mjs', import.meta.url).href;
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === 'node-fetch' ? { url: mockFetch, shortCircuit: true } : next(specifier, context),
});

// Placeholder credentials so gscli's auth code runs; the token request below never leaves the machine.
const credentials = join(tmpdir(), 'gscli-demo-credentials.json');
writeFileSync(credentials, JSON.stringify({ type: 'authorized_user', client_id: 'demo', client_secret: 'demo', refresh_token: 'demo' }));
process.env.GSC_CREDENTIALS = credentials;
process.env.GSC_SITE ??= 'example.com';

const SITE = 'https://example.com';
// [key, current clicks, impressions, position, previous clicks, impressions, position]
const PAGES = [
  ['/', 412, 9800, 3.1, 455, 10400, 2.8],
  ['/pricing', 188, 2100, 4.2, 140, 1900, 5.0],
  ['/blog/seo-checklist', 96, 5400, 7.8, 31, 2200, 11.4],
  ['/features/reports', 41, 1600, 9.6, 63, 1700, 8.1],
  ['/docs/getting-started', 37, 880, 5.5, 52, 950, 4.9],
  ['/blog/keyword-research', 22, 3900, 12.4, 0, 0, 0],
  ['/blog/launch-week', 0, 0, 0, 14, 600, 9.2],
].map(([path, ...m]) => [`${SITE}${path}`, ...m]);
const QUERIES = [
  ['example', 380, 7200, 1.4, 402, 7600, 1.3],
  ['seo checklist', 61, 3100, 6.2, 18, 1300, 10.8],
  ['search console reports', 44, 4100, 8.9, 39, 3600, 9.4],
  ['keyword research tool', 18, 5200, 11.6, 0, 0, 0],
  ['rank tracking api', 27, 1900, 5.8, 30, 2000, 5.5],
  ['seo audit checklist', 12, 2600, 13.1, 9, 2100, 14.0],
  ['example pricing', 96, 640, 2.1, 71, 560, 2.4],
];

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

function analytics({ dimensions = [], startDate, endDate }) {
  if (dimensions[0] === 'date') {
    const rows = [];
    for (let d = 3; d <= 10; d++) if (daysAgo(d) >= startDate && daysAgo(d) <= endDate) rows.push(row([daysAgo(d)], 30, 900, 6));
    return rows;
  }
  // Ranges ending in the last ~10 days are the current period; anything earlier is the previous one.
  const current = endDate >= daysAgo(10);
  const pick = (r) => (current ? r.slice(1, 4) : r.slice(4, 7));
  const source = dimensions[0] === 'page' ? PAGES : QUERIES;
  if (dimensions.length === 0) {
    const all = PAGES.map(pick).filter(([, i]) => i > 0);
    const clicks = all.reduce((s, [c]) => s + c * 1.18, 0);
    const impressions = all.reduce((s, [, i]) => s + i * 1.25, 0);
    const position = all.reduce((s, [, i, p]) => s + i * p, 0) / all.reduce((s, [, i]) => s + i, 0);
    return [{ clicks: Math.round(clicks), impressions: Math.round(impressions), ctr: clicks / impressions, position }];
  }
  return source
    .map((r) => [r[0], ...pick(r)])
    .filter(([, , impressions]) => impressions > 0)
    .map(([key, clicks, impressions, position]) => row([key], clicks, impressions, position));
}

function row(keys, clicks, impressions, position) {
  return { keys, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position };
}

const INSPECTIONS = {
  [`${SITE}/pricing`]: { verdict: 'PASS', coverageState: 'Submitted and indexed', lastCrawlTime: `${daysAgo(2)}T06:12:44Z` },
  [`${SITE}/blog/keyword-research`]: { verdict: 'NEUTRAL', coverageState: 'Discovered - currently not indexed' },
};

function inspection({ inspectionUrl }) {
  const status = INSPECTIONS[inspectionUrl] ?? { verdict: 'PASS', coverageState: 'Submitted and indexed' };
  return {
    inspectionResult: {
      inspectionResultLink: `https://search.google.com/search-console/inspect?resource_id=sc-domain:example.com&id=${encodeURIComponent(inspectionUrl)}`,
      indexStatusResult: {
        robotsTxtState: 'ALLOWED',
        indexingState: 'INDEXING_ALLOWED',
        pageFetchState: status.lastCrawlTime ? 'SUCCESSFUL' : undefined,
        googleCanonical: status.lastCrawlTime ? inspectionUrl : undefined,
        userCanonical: status.lastCrawlTime ? inspectionUrl : undefined,
        crawledAs: status.lastCrawlTime ? 'MOBILE' : undefined,
        ...status,
      },
    },
  };
}

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  const body = init.body ? JSON.parse(String(init.body).startsWith('{') ? init.body : '{}') : {};
  if (url.hostname === 'oauth2.googleapis.com') return json({ access_token: 'demo', expires_in: 3600, token_type: 'Bearer' });
  if (url.pathname.endsWith('/sites')) return json({ siteEntry: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] });
  if (url.pathname.endsWith('/searchAnalytics/query')) {
    const rows = analytics(body);
    return json({ rows: rows.slice(body.startRow ?? 0, (body.startRow ?? 0) + (body.rowLimit ?? rows.length)) });
  }
  if (url.pathname.endsWith('/urlInspection/index:inspect')) return json(inspection(body));
  return new Response(JSON.stringify({ error: { message: `demo mock has no answer for ${url}` } }), { status: 404 });
};
