# Changelog

## 0.3.0

- Usable as a library: `import { SearchConsoleClient, searchAnalytics, totals, inspectUrl } from 'gsc-agent-cli'`.
  Exports the client, Search Analytics paging, period totals, comparisons, opportunities, URL inspection and
  sitemap helpers, with TypeScript types.
- README demo GIF.

## 0.2.0

- `auth status` shows the signed-in Google account in `account`, or a service account's email. `account` is now
  always present: `null` with an `accountNote` when the login did not grant the email scope.
- `auth login` also asks for the `openid` and `userinfo.email` scopes. Log in again to see your account in `auth status`.
- A Google Workspace re-authentication error (`invalid_rapt`) now says to sign in again, instead of showing Google's raw error.

## 0.1.1

- Published from GitHub Actions with npm provenance.
- The skill and README explain that the npm package `gsc-agent-cli` installs the `gscli` command, and link the source repository.

## 0.1.0

First public release.

- `sites`, `summary`, `query`, `compare`, `opportunities`: search analytics with period comparisons and ranking opportunities.
- `inspect`: URL Inspection for URLs, files or sitemaps, with `--open` to reach Google's "Request indexing" button.
- `indexnow`: recrawl requests to Bing, Yandex and other IndexNow engines, with key-file checks before sending.
- `sitemaps`: list, get, submit and delete.
- `auth`: credential status and gcloud login.
- JSON, JSONL, CSV and table output; stable exit codes; errors with hints.
- Agent skill in `skills/gscli`.
