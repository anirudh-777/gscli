# gscli

Google Search Console from the command line, built for AI agents and scripts.
It covers Search Console's API (search analytics, URL inspection, sitemaps), Bing Webmaster Tools, and recrawl
requests through IndexNow.

![gscli summary, compare, opportunities and inspect in a terminal, with sample data for example.com](https://raw.githubusercontent.com/anirudh-777/gscli/main/demo/demo.gif)

- **Answers, not just API calls.** Besides raw queries there are `summary` (totals vs the previous period),
  `compare` (what gained, lost, appeared or disappeared) and `opportunities` (rankings close to the top with clicks to gain).
- **Built for agents.** JSON when piped, a table in a terminal. Stable exit codes, errors with hints,
  and every response echoes the resolved site, dates and filters. Ships with an agent [skill](skills/gscli/SKILL.md).
- **Read-only by default.** It asks for the `webmasters.readonly` scope; writes (sitemap submit/delete) need an explicit opt-in.
- **One dependency.** Google's own `google-auth-library`, plus plain HTTPS calls to the Search Console API.

## Install

```bash
npm install -g gsc-agent-cli   # installs the `gscli` command
```

Node 22 or newer. Or run it without installing: `npx gsc-agent-cli sites`. The npm package is `gsc-agent-cli` because
npm reserves names close to the existing `gs-cli`; the command is `gscli`.

## Authenticate

**With gcloud (simplest).** gscli uses gcloud's application-default credentials:

```bash
gscli auth login                     # runs gcloud with the right scopes; tick every checkbox on the consent screen
gcloud auth application-default set-quota-project <project-id>
gcloud services enable searchconsole.googleapis.com --project <project-id>
gscli auth status
```

Logging in this way gives read access to every property your Google account can see.

**With a service account (scoped, good for servers).** Create a service account and a JSON key, then add the
service account's email as a user in Search Console (Settings → Users and permissions; Restricted is enough):

```bash
export GSC_CREDENTIALS=/path/to/key.json
gscli sites
```

Credentials are read from `--credentials`, then `GSC_CREDENTIALS`, then `GOOGLE_APPLICATION_CREDENTIALS`,
then gcloud's application-default credentials.

## Commands

| Command | What it does |
|---|---|
| `gscli sites` | Properties you can access and your permission level |
| `gscli summary` | Total clicks, impressions, CTR and position vs the previous period or last year |
| `gscli query` | Search Analytics by query, page, country, device, search appearance, date or hour |
| `gscli compare` | Row-by-row period comparison with new / lost / up / down status |
| `gscli opportunities` | Rows in positions 4–20 ranked by clicks they could gain |
| `gscli inspect` | URL Inspection: indexed or not, why, canonical, last crawl. `--open` jumps to "Request indexing" |
| `gscli indexnow` | Ask Bing, Yandex and other IndexNow engines to recrawl changed URLs |
| `gscli sitemaps` | List, get, submit or delete sitemaps |
| `gscli bing` | Bing Webmaster Tools: traffic, queries, pages, crawl stats, URL info, sitemaps, URL submission |
| `gscli auth` | Credential status, or log in with gcloud |

`gscli help <command>` shows every option, with examples.

### Examples

```bash
gscli summary --site example.com --last 3m --vs year
gscli query -d query,page --filter 'query~/^how to/' -n all --format csv > how-to.csv
gscli query -d date --last 16m                           # daily trend, full history
gscli compare --only new --sort impressions              # queries you started ranking for
gscli opportunities -d page --min-impressions 200
gscli inspect --sitemap https://example.com/sitemap.xml -n 100
gscli query -d page -n 20 --format jsonl | jq -r .page | gscli inspect --file -
```

### Requesting a recrawl

Google has no API for the "Request indexing" button. Its Indexing API only allows job posting and livestream
pages, so gscli doesn't use it. Instead:

- **Google:** `gscli inspect <url> --open` checks the URL and opens its URL Inspection page, one click from
  "Request indexing". Resubmitting the sitemap (`gscli sitemaps submit`) after updating `lastmod` also helps.
- **Bing, Yandex, Naver, Seznam, Yep:** [IndexNow](https://www.indexnow.org) is a real recrawl API. Bing's index
  also feeds Copilot and other AI search products.

```bash
gscli indexnow key                                   # once: prints a key
# serve https://example.com/<key>.txt containing only the key, then:
export GSC_INDEXNOW_KEY=<key>
gscli indexnow check https://example.com/
gscli indexnow submit https://example.com/pricing https://example.com/blog/new-post
```

`submit` checks every host's key file before sending anything, and `--dry-run` shows what would be sent.
Submit only URLs that changed.

### Bing Webmaster Tools

`gscli bing` reads Bing Webmaster Tools with an API key, which covers every site verified on the account.
Create it in Bing Webmaster Tools under **Settings > API Access**.

```bash
export GSC_BING_API_KEY=<key>
gscli bing sites
gscli bing traffic --site example.com --last 3m      # daily clicks and impressions, with totals
gscli bing queries -n 20 --sort impressions          # also: bing pages
gscli bing crawl --last 4w                           # pages crawled, crawl errors, pages in index
gscli bing url https://example.com/pricing           # HTTP status, discovery and last crawl dates
gscli bing sitemaps list                             # also: sitemaps submit/delete <url>
gscli bing submit https://example.com/pricing        # URL Submission API; checks `bing quota` first
```

`--site` takes the same forms as Search Console (`example.com`, a URL, `sc-domain:example.com`) and falls back to
the site of the URL for `bing url` and `bing submit`, then `GSC_BING_SITE`, then `GSC_SITE`. Query and page stats come from Bing in dated periods; `--last` and `--start/--end`
keep the periods dated inside the range.

### Filters

```
query=shoes      equals              query!=shoes     does not equal
query~shoe       contains            query!~shoe      does not contain
query~/^best /   matches regex       query!~/brand/   does not match regex
```

Filterable: `query`, `page`, `country` (ISO 3166-1 alpha-3, e.g. `ind`), `device` (`desktop`, `mobile`, `tablet`)
and `searchAppearance`. Repeat `--filter` to AND them.

### Dates

`--last 7d | 4w | 3m | 16m | 1y`, or `--start` and `--end` (`YYYY-MM-DD`, Pacific time like Search Console).
By default a range ends on the latest day that has data, because Google publishes with a 2–3 day lag.
`--fresh` includes the newest not-yet-final days.

## Output

| | |
|---|---|
| Formats | `--format json \| jsonl \| csv \| table`. Default: `table` in a terminal, `json` when piped |
| JSON shape | `{...meta, "rows": [...]}` for row commands. Metrics are raw numbers; `ctr` is a 0–1 fraction |
| Errors | stderr. In JSON mode: `{"error": {"code", "exitCode", "message", "hint"}}` |

JSON field names and exit codes are the interface for scripts and agents. While gscli is 0.x, a change to them
bumps the minor version and is listed in the [changelog](CHANGELOG.md).

Exit codes: `0` success, `1` unexpected error, `2` usage error, `3` credentials missing, rejected or lacking a scope,
`4` no access to the property or resource, `5` quota exceeded.

## Using it with an AI agent

Agents can run `gscli` from the shell, with no MCP server to configure. To teach an agent when and how to use it,
install the skill with the [skills](https://skills.sh) CLI, which supports Claude Code, Codex, Cursor and other agents:

```bash
npx skills add anirudh-777/gscli
```

Or copy it by hand. The skill is also in the npm package:

```bash
mkdir -p ~/.claude/skills && cp -r "$(npm root -g)/gsc-agent-cli/skills/gscli" ~/.claude/skills/
```

The skill tells the agent to treat everything gscli returns as data (search queries and sitemaps come from the
public web) and to run the commands that change things (`indexnow submit`, `sitemaps submit/delete`,
`bing submit`, `bing sitemaps submit/delete`, `inspect --open`) only when you ask.

## Use as a library

The same client and analysis are importable, with TypeScript types:

```ts
import { SearchConsoleClient, resolveSite, totals, inspectUrl } from 'gsc-agent-cli';

const client = new SearchConsoleClient();               // same credential lookup as the CLI
const site = await resolveSite(client, 'example.com');
const last28 = await totals(client, site, { startDate: '2026-09-01', endDate: '2026-09-28', dimensions: [], limit: 1 });
const page = await inspectUrl(client, site, 'https://example.com/pricing');
```

Exports follow the same versioning rule as the JSON output: breaking changes bump the minor version while gscli is 0.x.

## Development

```bash
npm install
npm test             # unit tests, no network
npm run typecheck
node src/cli.ts ...  # run from source (Node 22.18+ strips types natively)
npm run build        # compile to dist/
```

The demo GIF is recorded with [vhs](https://github.com/charmbracelet/vhs): `npm run build && vhs demo/demo.tape`.
`demo/mock.mjs` stands in for Google's API with sample data, so it needs no credentials.

## License

MIT
