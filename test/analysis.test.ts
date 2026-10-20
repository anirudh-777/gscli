import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { flatten, matchSite } from '../src/api.ts';
import { compareRows, sortCompared } from '../src/commands/compare.ts';
import { flattenInspection } from '../src/commands/inspect.ts';
import { extractLocs } from '../src/urls.ts';
import { expectedCtr, findOpportunities } from '../src/commands/opportunities.ts';
import { sortRows } from '../src/commands/query.ts';

describe('matchSite', () => {
  const sites = ['sc-domain:example.com', 'https://example.com/', 'https://example.com/blog/', 'https://other.org/'];

  it('prefers the domain property for a bare domain', () => {
    assert.equal(matchSite('example.com', sites), 'sc-domain:example.com');
    assert.equal(matchSite('www.example.com', sites), 'sc-domain:example.com');
  });

  it('picks the longest URL-prefix property for a URL', () => {
    assert.equal(matchSite('https://example.com/blog/post', sites), 'https://example.com/blog/');
    assert.equal(matchSite('https://example.com/pricing', sites), 'https://example.com/');
  });

  it('falls back to the domain property for URLs outside any prefix', () => {
    assert.equal(matchSite('https://example.com/x', ['sc-domain:example.com']), 'sc-domain:example.com');
  });

  it('lets domain properties cover subdomains, most specific first', () => {
    const domains = ['sc-domain:example.com', 'sc-domain:docs.example.com'];
    assert.equal(matchSite('https://shop.example.com/', domains), 'sc-domain:example.com');
    assert.equal(matchSite('https://docs.example.com/a', domains), 'sc-domain:docs.example.com');
    assert.equal(matchSite('https://notexample.com/', domains), undefined);
  });

  it('matches a bare domain to a www URL-prefix property', () => {
    assert.equal(matchSite('other.org', ['https://www.other.org/']), 'https://www.other.org/');
  });

  it('returns undefined when nothing matches', () => {
    assert.equal(matchSite('nope.dev', sites), undefined);
    assert.equal(matchSite('sc-domain:nope.dev', sites), undefined);
  });
});

describe('flatten', () => {
  it('names keys by dimension, first, and rounds metrics', () => {
    const row = flatten({ keys: ['shoes', 'https://a.com/'], clicks: 3, impressions: 70, ctr: 0.0428571, position: 4.56789 }, [
      'query',
      'page',
    ]);
    assert.deepEqual(Object.keys(row), ['query', 'page', 'clicks', 'impressions', 'ctr', 'position']);
    assert.equal(row.ctr, 0.0429);
    assert.equal(row.position, 4.57);
  });
});

describe('sortRows', () => {
  const rows = [
    { query: 'a', clicks: 5, impressions: 10, ctr: 0.5, position: 3 },
    { query: 'b', clicks: 1, impressions: 90, ctr: 0.01, position: 1.5 },
  ];
  it('sorts position ascending and other metrics descending', () => {
    assert.equal(sortRows(rows, 'position')[0]!.query, 'b');
    assert.equal(sortRows(rows, 'impressions')[0]!.query, 'b');
    assert.equal(sortRows(rows, 'ctr')[0]!.query, 'a');
  });
});

describe('compareRows', () => {
  const now = [
    { query: 'kept', clicks: 10, impressions: 100, ctr: 0.1, position: 3 },
    { query: 'fresh', clicks: 2, impressions: 20, ctr: 0.1, position: 8 },
  ];
  const then = [
    { query: 'kept', clicks: 4, impressions: 80, ctr: 0.05, position: 5 },
    { query: 'gone', clicks: 7, impressions: 50, ctr: 0.14, position: 2 },
  ];

  it('classifies new, lost and changed rows', () => {
    const rows = compareRows(now, then, ['query']);
    const byQuery = Object.fromEntries(rows.map((r) => [r.query, r]));
    assert.equal(byQuery.kept!.status, 'up');
    assert.equal(byQuery.kept!.clicksDelta, 6);
    assert.equal(byQuery.kept!.positionDelta, -2);
    assert.equal(byQuery.fresh!.status, 'new');
    assert.equal(byQuery.fresh!.positionPrev, null);
    assert.equal(byQuery.gone!.status, 'lost');
    assert.equal(byQuery.gone!.clicksDelta, -7);
  });

  it('sorts by the size of the click change either way', () => {
    const sorted = sortCompared(compareRows(now, then, ['query']), 'change');
    assert.deepEqual(
      sorted.map((r) => r.query),
      ['gone', 'kept', 'fresh'],
    );
  });
});

describe('opportunities', () => {
  it('interpolates the CTR curve and keeps it decreasing', () => {
    assert.equal(expectedCtr(1), 0.28);
    assert.ok(Math.abs(expectedCtr(1.5) - 0.22) < 1e-9);
    for (let p = 1; p < 40; p += 0.5) assert.ok(expectedCtr(p + 0.5) <= expectedCtr(p));
  });

  it('filters by position and impressions and ranks by potential clicks', () => {
    const rows = [
      { query: 'top', clicks: 50, impressions: 200, ctr: 0.25, position: 1.2 },
      { query: 'close', clicks: 2, impressions: 400, ctr: 0.005, position: 5.1 },
      { query: 'page2', clicks: 0, impressions: 300, ctr: 0, position: 12 },
      { query: 'tiny', clicks: 0, impressions: 5, ctr: 0, position: 6 },
    ];
    const result = findOpportunities(rows, { minPosition: 4, maxPosition: 20, minImpressions: 50, targetPosition: 3 });
    assert.deepEqual(
      result.map((r) => r.query),
      ['close', 'page2'],
    );
    assert.equal(result[0]!.potentialClicks, 42);
    assert.equal(result[0]!.signal, 'low-ctr,near-top-3');
    assert.equal(result[1]!.signal, 'low-ctr,page-2');
  });
});

describe('inspection helpers', () => {
  it('ignores trailing-slash differences between canonicals', () => {
    const row = flattenInspection('https://a.com', {
      indexStatusResult: { googleCanonical: 'https://a.com', userCanonical: 'https://a.com/' },
    });
    assert.equal(row.canonicalMismatch, false);
    const other = flattenInspection('https://a.com/x', {
      indexStatusResult: { googleCanonical: 'https://a.com/y', userCanonical: 'https://a.com/x' },
    });
    assert.equal(other.canonicalMismatch, true);
  });

  it('extracts sitemap locations, including CDATA and entities', () => {
    const xml = `<urlset><url><loc>https://a.com/?a=1&amp;b=2</loc></url>
      <url><loc><![CDATA[ https://a.com/x ]]></loc></url></urlset>`;
    assert.deepEqual(extractLocs(xml), ['https://a.com/?a=1&b=2', 'https://a.com/x']);
  });
});
