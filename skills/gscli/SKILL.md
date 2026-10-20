---
name: gscli
description: Query Google Search Console with the gscli command — search performance (clicks, impressions, CTR, position) by query, page, country or device, period-over-period changes, ranking opportunities, URL indexing status and sitemaps — and ask search engines to recrawl pages (IndexNow for Bing and others, a one-click route to Google's Request indexing). Use when the user asks about SEO performance, organic search traffic, rankings, keywords, why traffic dropped, whether a page is indexed, getting a page recrawled or reindexed, or anything in Google Search Console.
---

# gscli: Google Search Console

`gscli` prints JSON when its output is piped, which is how you run it. Every row command returns
`{...meta, "rows": [...]}`. `meta` echoes the resolved site, date range and filters; check it
before you interpret the numbers.

## First call

```bash
gscli auth status    # credentials, scopes, quota project, number of properties
gscli sites          # properties and permission level
```

If `auth status` exits 3, show the user the `command` from `gscli auth login --print` and ask them to
run it. The login opens a browser, and they must tick every checkbox on the consent screen.

When there is more than one property, pass `--site` (bare domain, URL, or `sc-domain:...`),
or set `GSC_SITE`.

## Pick the command

| Question | Command |
|---|---|
| How is the site doing overall? | `gscli summary` (add `--vs year` for seasonality) |
| Top queries / pages | `gscli query -n 50`, `gscli query -d page -n 50` |
| Daily trend | `gscli query -d date --last 3m` |
| What changed, why did traffic drop? | `gscli compare`, then `gscli compare -d page --only down` |
| New or lost rankings | `gscli compare --only new --sort impressions`, `--only lost` |
| What to work on next | `gscli opportunities` |
| Is this URL indexed? Why not? | `gscli inspect <url>` |
| Indexing across the site | `gscli inspect --sitemap <sitemap-url> -n 100` |
| Sitemap health | `gscli sitemaps list` |
| Get Google to recrawl a page | `gscli inspect <url> --open`, then the user clicks "Request indexing" |
| Get Bing and others to recrawl | `gscli indexnow submit <url...>` |

Filters: `--filter 'query~/^how to/'`, `--filter page~/blog/`, `--filter country=ind`,
`--filter device=mobile`. Repeat `--filter` to AND them. Run `gscli help filters` for the full syntax.
Dates: `--last 7d|4w|3m|16m` or `--start/--end YYYY-MM-DD`; the default is 28 days ending on the latest day with data.

## Reading the numbers

- `ctr` is a 0–1 fraction. `position` is an average where lower is better; `positionDelta < 0` means it improved.
- Data lags 2–3 days. `--fresh` includes recent, not-yet-final days.
- `summary` totals include anonymized queries, so they exceed the sum of `query` rows. Don't add rows up to get totals.
- `query` rows come back ordered by clicks. `truncated: true` means more rows exist; raise `-n` or use `-n all`.
- `compare` marks `incomplete: true` when a period hit 25,000 rows; new/lost labels are then unreliable for the tail.
- `opportunities.potentialClicks` comes from a rough CTR curve. Use it to rank the work, never as a traffic forecast.
- `inspect` shows Google's indexed copy, not a live test. `verdict` is PASS (indexed), NEUTRAL (excluded, read
  `coverageState`) or FAIL. `canonicalMismatch: true` means Google chose another canonical.

## Limits and safety

- URL inspection quota is 2,000 per property per day, so inspect samples rather than whole large sitemaps.
- Google has no recrawl API. Don't use Google's Indexing API: it only allows job posting and livestream pages.
  `inspect --open` opens browser tabs on the user's machine, so use it only when they want to request indexing.
- `indexnow submit` notifies external search engines. Run it only when the user asks, for URLs that changed,
  and preview with `--dry-run`. It needs `GSC_INDEXNOW_KEY` and a key file on the site (`gscli help indexnow`).
- `sitemaps submit/delete` change the property. Run them only when the user asks, and `delete` needs `--yes`.
  They also need write access (`gscli auth login --write`).
- Exit codes: 2 usage, 3 credentials, 4 no access/not found, 5 quota. The error JSON on stderr carries a `hint`.

## Recipes

```bash
# Pages that lost the most clicks, then why
gscli compare -d page --only down -n 10
gscli compare --filter 'page=https://example.com/pricing' -n 20   # which queries moved for that page

# Indexing status of the top 20 pages
gscli query -d page -n 20 --format jsonl | jq -r .page | gscli inspect --file -

# Branded vs non-branded
gscli summary --filter 'query~/brand|brand name/'
gscli summary --filter 'query!~/brand|brand name/'
```
