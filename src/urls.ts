import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { ParseArgsOptionsConfig } from 'node:util';
import { str, type Values } from './command.ts';
import { CliError, usageError } from './errors.ts';

export const URL_SOURCE_OPTIONS = {
  file: { type: 'string' },
  sitemap: { type: 'string' },
} satisfies ParseArgsOptionsConfig;

export const URL_SOURCE_HELP = `      --file <path>          Read URLs from a file, one per line ("-" for stdin).
      --sitemap <url>        Use the URLs listed in a sitemap (follows one level of sitemap index).`;

export interface UrlList {
  urls: string[];
  source: string;
  sitemapUrlCount?: number;
}

/** URLs from arguments, --file and --sitemap, de-duplicated; --file and --sitemap are capped at `limit`. */
export async function collectUrls(positionals: string[], values: Values, limit: number): Promise<UrlList> {
  const urls = [...positionals];
  let source = 'arguments';
  let sitemapUrlCount: number | undefined;

  const file = str(values.file);
  if (file) {
    const text = file === '-' ? await readStdin() : await readFile(file, 'utf8');
    urls.push(...text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).slice(0, limit));
    source = file === '-' ? 'stdin' : file;
  }
  const sitemap = str(values.sitemap);
  if (sitemap) {
    const fromSitemap = await sitemapUrls(sitemap);
    sitemapUrlCount = fromSitemap.length;
    urls.push(...fromSitemap.slice(0, limit));
    source = sitemap;
  }

  const unique = [...new Set(urls)];
  if (unique.length === 0) throw usageError('No URLs given.', 'Pass URLs as arguments, or use --file or --sitemap.');
  for (const url of unique) {
    if (!/^https?:\/\//i.test(url)) throw usageError(`"${url}" is not an absolute http(s) URL.`);
  }
  return { urls: unique, source, sitemapUrlCount };
}

const MAX_CHILD_SITEMAPS = 50;

export async function sitemapUrls(url: string, depth = 0): Promise<string[]> {
  const xml = await fetchText(url);
  const locs = extractLocs(xml);
  if (!/<sitemapindex[\s>]/i.test(xml)) return locs;
  if (depth > 0) return [];
  const urls: string[] = [];
  for (const child of locs.slice(0, MAX_CHILD_SITEMAPS)) urls.push(...(await sitemapUrls(child, depth + 1)));
  return urls;
}

export function extractLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*(.*?)\s*(?:\]\]>)?\s*<\/loc>/gis)].map((m) =>
    m[1]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"),
  );
}

/** The sitemap protocol caps a sitemap at 50 MB uncompressed. */
const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;

async function fetchText(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'user-agent': 'gscli' }, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new CliError('error', `Could not fetch sitemap ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new CliError('error', `Fetching sitemap ${url} returned HTTP ${res.status}.`);
  if (!res.body) return '';
  const body = url.endsWith('.gz') ? res.body.pipeThrough(new DecompressionStream('gzip')) : res.body;
  return readCapped(body, MAX_SITEMAP_BYTES, url);
}

async function readCapped(stream: ReadableStream<Uint8Array>, maxBytes: number, url: string): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new CliError('error', `Sitemap ${url} is larger than 50 MB, the sitemap protocol's limit.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw usageError('--file - reads URLs from stdin, but nothing was piped in.');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** `https://a.com` and `https://a.com/` are the same URL; URL parsing makes them equal. */
export function normalizeUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

/**
 * Opens an https URL in the default browser. Resolves false for any other URL, or when no opener
 * is available. The URL goes to the opener as an argument, never through a shell.
 */
export function openInBrowser(url: string): Promise<boolean> {
  if (!isHttpsUrl(url)) return Promise.resolve(false);
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  return new Promise((resolve) => {
    const child = spawn(command, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => resolve(false));
    child.on('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

export function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
