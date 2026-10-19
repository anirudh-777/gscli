# gscli

Google Search Console from the command line, built for AI agents and scripts.

```bash
$ gscli compare -d page --only down -n 3
page                                   clicks  Δclicks  impressions  Δimpr  position  Δpos  status
-------------------------------------  ------  -------  -----------  -----  --------  ----  ------
https://example.com/                       43      -21          521   -160       8.2  -5.0  down
https://example.com/features/builder        0       -4           15    -50      13.8  +4.2  down
https://example.com/docs/editor             0       -1           86   -186       5.2  -4.9  down
```

- **Answers, not just API calls.** Besides raw queries there are `summary` (totals vs the previous period),
  `compare` (what gained, lost, appeared or disappeared) and `opportunities` (rankings close to the top with clicks to gain).
- **Built for agents.** JSON when piped, a table in a terminal. Stable exit codes, errors with hints,
  and every response echoes the resolved site, dates and filters. Ships with an agent [skill](skills/gscli/SKILL.md).
- **Read-only by default.** It asks for the `webmasters.readonly` scope; writes (sitemap submit/delete) need an explicit opt-in.
- **One dependency.** Google's own `google-auth-library`, plus plain HTTPS calls to the Search Console API.

## Install

```bash
npm install -g gscli    # not published yet; for now: git clone, npm install, npm run build, npm link
```

Node 20 or newer.

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
| `gscli inspect` | URL Inspection: indexed or not, why, canonical, last crawl. URLs, a file, stdin or a sitemap |
| `gscli sitemaps` | List, get, submit or delete sitemaps |
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

Exit codes: `0` success, `1` unexpected error, `2` usage error, `3` credentials missing, rejected or lacking a scope,
`4` no access to the property or resource, `5` quota exceeded.

## Using it with an AI agent

Agents can run `gscli` from the shell, with no MCP server to configure. To teach an agent when and how to use it,
install the skill:

```bash
# Claude Code
mkdir -p ~/.claude/skills && cp -r skills/gscli ~/.claude/skills/
```

## Development

```bash
npm install
npm test             # unit tests, no network
npm run typecheck
node src/cli.ts ...  # run from source (Node 22.18+ strips types natively)
npm run build        # compile to dist/
```

## License

MIT
