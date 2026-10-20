import { randomBytes } from 'node:crypto';
import { parseLimit, str, type Command, type Values } from '../command.ts';
import { CliError, usageError } from '../errors.ts';
import type { Row } from '../output.ts';
import { collectUrls, URL_SOURCE_HELP, URL_SOURCE_OPTIONS } from '../urls.ts';

const DEFAULT_ENDPOINT = 'https://api.indexnow.org/indexnow';
/** IndexNow accepts up to 10,000 URLs per request. */
const BATCH_SIZE = 10_000;
const KEY_PATTERN = /^[a-zA-Z0-9-]{8,128}$/;

export const indexnow: Command = {
  name: 'indexnow',
  summary: 'Ask Bing, Yandex and other IndexNow engines to recrawl URLs',
  usage: 'gscli indexnow <submit|check|key> [url...] [options]',
  help: `IndexNow tells participating search engines (Bing, Yandex, Naver, Seznam, Yep) that URLs
were added, changed or deleted, so they recrawl them. One submission reaches all of them.
Google does not use IndexNow; for Google, see \`gscli inspect --open\`.

Subcommands:
  key                  Generate a new key and show where to host it.
  check [url]          Verify the key file is reachable on the site of [url] (or --host).
  submit <url...>      Submit URLs. Checks the key file first. All URLs must be on hosts that
                       serve the key file.

Setup, once per site:
  1. gscli indexnow key                       # prints a key
  2. Serve a text file containing only the key at https://<host>/<key>.txt
  3. export GSC_INDEXNOW_KEY=<key>
  4. gscli indexnow check https://<host>/

Options:
      --key <key>            IndexNow key. Default: GSC_INDEXNOW_KEY.
      --key-location <url>   Where the key file is hosted, if not https://<host>/<key>.txt.
      --host <host>          Host to check, for \`check\` without a URL.
${URL_SOURCE_HELP}
  -n, --limit <n|all>        Maximum URLs from --file or --sitemap. Default: all.
      --endpoint <url>       IndexNow endpoint. Default: ${DEFAULT_ENDPOINT}.
      --dry-run              Show what would be submitted without sending it.

Submit only URLs that changed. Resubmitting unchanged URLs repeatedly can get a key throttled.

Examples:
  gscli indexnow submit https://example.com/pricing https://example.com/blog/new-post
  gscli indexnow submit --sitemap https://example.com/sitemap.xml --dry-run
  git diff --name-only HEAD~1 | ./paths-to-urls.sh | gscli indexnow submit --file -`,
  options: {
    ...URL_SOURCE_OPTIONS,
    key: { type: 'string' },
    'key-location': { type: 'string' },
    host: { type: 'string' },
    limit: { type: 'string', short: 'n' },
    endpoint: { type: 'string' },
    'dry-run': { type: 'boolean' },
  },
  allowPositionals: true,
  async run(_ctx, values, positionals) {
    const [action, ...args] = positionals;
    if (action === 'key') {
      if (args.length) throw usageError('`gscli indexnow key` takes no arguments.');
      const key = randomBytes(16).toString('hex');
      return {
        data: {
          key,
          keyFile: `${key}.txt`,
          keyFileContents: key,
          next: [
            `Serve a file named ${key}.txt containing only the key at the root of each site, e.g. https://example.com/${key}.txt`,
            `export GSC_INDEXNOW_KEY=${key}`,
            'gscli indexnow check https://example.com/',
          ],
        },
      };
    }
    if (action === 'check') return check(values, args);
    if (action === 'submit') return submit(values, args);
    throw usageError(
      action ? `Unknown indexnow subcommand "${action}".` : 'indexnow needs a subcommand.',
      'Use key, check or submit. Run `gscli help indexnow`.',
    );
  },
};

function requireKey(values: Values): string {
  const key = str(values.key) ?? process.env.GSC_INDEXNOW_KEY;
  if (!key) {
    throw usageError('No IndexNow key.', 'Pass --key or set GSC_INDEXNOW_KEY. Run `gscli indexnow key` to create one.');
  }
  if (!KEY_PATTERN.test(key)) {
    throw usageError('IndexNow keys are 8-128 characters of letters, digits and dashes.');
  }
  return key;
}

export function keyLocationFor(host: string, key: string, explicit: string | undefined): string {
  return explicit ?? `https://${host}/${key}.txt`;
}

async function check(values: Values, args: string[]) {
  const key = requireKey(values);
  if (args.length > 1) throw usageError('`gscli indexnow check` takes at most one URL.');
  const host = args[0] ? hostOf(args[0]) : str(values.host);
  if (!host) throw usageError('Pass a URL on the site, or --host.');
  const location = keyLocationFor(host, key, str(values['key-location']));
  await verifyKeyFile(location, key);
  return { data: { host, keyLocation: location, keyFileOk: true } };
}

async function verifyKeyFile(location: string, key: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(location, { headers: { 'user-agent': 'gscli' }, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new CliError('error', `Could not fetch the key file ${location}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body = res.ok ? (await res.text()).trim() : '';
  if (!res.ok || body !== key) {
    throw new CliError('permission', `The key file at ${location} ${res.ok ? 'does not contain the key' : `returned HTTP ${res.status}`}.`, {
      hint: `Serve a text file containing only "${key}" at ${location}. Search engines reject submissions until it is reachable.`,
    });
  }
}

async function submit(values: Values, args: string[]) {
  const key = requireKey(values);
  const keyLocation = str(values['key-location']);
  const endpoint = str(values.endpoint) ?? DEFAULT_ENDPOINT;
  const { urls, source, sitemapUrlCount } = await collectUrls(args, values, parseLimit(values.limit, Infinity));

  const batches = batchByHost(urls);
  if (keyLocation && batches.length > 1) {
    throw usageError('--key-location applies to one host, but the URLs span several.', 'Submit each host separately.');
  }

  // Check every host's key file before sending anything, so a failure never leaves a partial submission.
  const checks = await Promise.all(
    batches.map(async (batch) => {
      const location = keyLocationFor(batch.host, key, keyLocation);
      try {
        await verifyKeyFile(location, key);
        return { location, error: undefined };
      } catch (err) {
        if (!values['dry-run']) throw err;
        return { location, error: err instanceof CliError ? err.message : String(err) };
      }
    }),
  );

  const rows: Row[] = [];
  for (const [i, batch] of batches.entries()) {
    const { location, error } = checks[i]!;
    if (values['dry-run']) {
      rows.push({
        host: batch.host,
        urls: batch.urls.length,
        keyLocation: location,
        keyFileOk: !error,
        keyFileError: error,
        status: error ? 'dry run; key file not reachable' : 'dry run; ready',
      });
      continue;
    }
    const res = await post(endpoint, {
      host: batch.host,
      key,
      keyLocation: keyLocation ? location : undefined,
      urlList: batch.urls,
    });
    rows.push({ host: batch.host, urls: batch.urls.length, keyLocation: location, ...res });
  }

  return {
    meta: { endpoint, source, sitemapUrlCount, submitted: values['dry-run'] ? 0 : urls.length, dryRun: values['dry-run'] || undefined },
    rows,
    columns: [{ key: 'host' }, { key: 'urls', kind: 'int' as const }, { key: 'httpStatus', label: 'http' }, { key: 'status' }],
  };
}

export function batchByHost(urls: string[]): { host: string; urls: string[] }[] {
  const byHost = new Map<string, string[]>();
  for (const url of urls) {
    const host = hostOf(url);
    byHost.set(host, [...(byHost.get(host) ?? []), url]);
  }
  const batches: { host: string; urls: string[] }[] = [];
  for (const [host, list] of byHost) {
    for (let i = 0; i < list.length; i += BATCH_SIZE) batches.push({ host, urls: list.slice(i, i + BATCH_SIZE) });
  }
  return batches;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    throw usageError(`"${url}" is not a valid URL.`);
  }
}

async function post(endpoint: string, body: unknown): Promise<{ httpStatus: number; status: string }> {
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', 'user-agent': 'gscli' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new CliError('error', `IndexNow request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const outcome = INDEXNOW_STATUS[res.status];
  if (outcome?.ok) return { httpStatus: res.status, status: outcome.status };

  const text = (await res.text().catch(() => '')).slice(0, 300);
  const message = `IndexNow returned HTTP ${res.status}${text ? `: ${text}` : ''}`;
  if (res.status === 429) throw new CliError('quota', message, { hint: 'Too many requests. Submit only changed URLs, and wait before retrying.' });
  if (res.status === 403) throw new CliError('permission', message, { hint: outcome?.status });
  throw new CliError(res.status === 400 || res.status === 422 ? 'usage' : 'error', message, { hint: outcome?.status });
}

const INDEXNOW_STATUS: Record<number, { ok: boolean; status: string }> = {
  200: { ok: true, status: 'submitted' },
  202: { ok: true, status: 'accepted; key validation pending' },
  400: { ok: false, status: 'Bad request: invalid format.' },
  403: { ok: false, status: 'Key not valid: the key file was not found or does not match.' },
  422: { ok: false, status: 'URLs do not belong to the host, or the key does not match the protocol schema.' },
};
