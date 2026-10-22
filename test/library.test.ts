import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as gscli from '../src/index.ts';

describe('library entry point', () => {
  it('exports the client and the analysis functions', () => {
    for (const name of ['SearchConsoleClient', 'searchAnalytics', 'resolveSite', 'totals', 'compareRows', 'findOpportunities', 'inspectUrl', 'sitemapUrls']) {
      assert.equal(typeof gscli[name as keyof typeof gscli], 'function', name);
    }
  });
});
