// Library entry point: the Search Console client and the analysis behind the CLI commands.
// The CLI itself is dist/cli.js.
export { SearchConsoleClient, READ_SCOPE, WRITE_SCOPE, toCliError, type ClientOptions } from './client.ts';
export { CliError, ExitCode, type ExitCodeName } from './errors.ts';
export {
  listSites,
  resolveSite,
  matchSite,
  searchAnalytics,
  latestDataDate,
  flatten,
  PAGE_SIZE,
  SEARCH_TYPES,
  type Site,
  type AnalyticsRow,
  type AnalyticsQuery,
  type FlatRow,
  type SearchType,
  type DataState,
} from './api.ts';
export { DIMENSIONS, parseFilter, parseDimensions, type Dimension, type DimensionFilter } from './filters.ts';
export { todayInPacific, addDays, rangeFromLast, previousRange, yearAgoRange, type DateRange } from './dates.ts';
export { totals, type Totals } from './commands/summary.ts';
export { compareRows, sortCompared, type ComparedRow } from './commands/compare.ts';
export { findOpportunities, expectedCtr, type Opportunity, type OpportunityOptions } from './commands/opportunities.ts';
export { inspectUrl, flattenInspection, type InspectionResult } from './commands/inspect.ts';
export { sitemapUrls, extractLocs, normalizeUrl } from './urls.ts';
export {
  BingClient,
  BING_API,
  listBingSites,
  resolveBingSite,
  matchBingSite,
  aggregateStats,
  parseBingDate,
  type BingClientOptions,
  type BingSite,
  type BingStatsRow,
  type BingAggregate,
} from './bing.ts';
