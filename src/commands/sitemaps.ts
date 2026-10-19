import type { Command } from '../command.ts';
import { usageError } from '../errors.ts';
import type { Row } from '../output.ts';

interface Sitemap {
  path: string;
  type?: string;
  isSitemapsIndex?: boolean;
  isPending?: boolean;
  lastSubmitted?: string;
  lastDownloaded?: string;
  warnings?: string;
  errors?: string;
  contents?: { type?: string; submitted?: string }[];
}

export const sitemaps: Command = {
  name: 'sitemaps',
  summary: 'List, read, submit or delete sitemaps',
  usage: 'gscli sitemaps <list|get|submit|delete> [sitemap-url] [options]',
  help: `Subcommands:
  list                  Sitemaps submitted for the property, with errors, warnings and URL counts.
  get <sitemap-url>     Details for one sitemap.
  submit <sitemap-url>  Submit or resubmit a sitemap. Needs write access (see \`gscli auth login --write\`).
  delete <sitemap-url>  Remove a sitemap from Search Console. Needs write access and --yes.

Options:
      --yes                  Confirm delete.

Examples:
  gscli sitemaps list
  gscli sitemaps submit https://example.com/sitemap.xml`,
  options: { yes: { type: 'boolean' } },
  allowPositionals: true,
  async run(ctx, values, positionals) {
    const [action = 'list', feed, ...extra] = positionals;
    if (extra.length) throw usageError(`Unexpected arguments: ${extra.join(' ')}`);
    const write = action === 'submit' || action === 'delete';
    const client = ctx.client({ write });
    const site = await ctx.site(client);

    if (action === 'list') {
      if (feed) throw usageError('`gscli sitemaps list` takes no URL; use `gscli sitemaps get <url>`.');
      const res = await client.webmasters<{ sitemap?: Sitemap[] }>(`/sites/${encodeURIComponent(site)}/sitemaps`);
      const rows = (res.sitemap ?? []).map(flattenSitemap);
      return {
        meta: { site, count: rows.length },
        rows,
        columns: [
          { key: 'path' },
          { key: 'lastSubmitted' },
          { key: 'lastDownloaded' },
          { key: 'submittedUrls', label: 'urls', kind: 'int' },
          { key: 'errors', kind: 'int' },
          { key: 'warnings', kind: 'int' },
          { key: 'isPending', label: 'pending' },
        ],
      };
    }

    if (action !== 'get' && action !== 'submit' && action !== 'delete') {
      throw usageError(`Unknown sitemaps subcommand "${action}".`, 'Use list, get, submit or delete.');
    }
    if (!feed) throw usageError(`\`gscli sitemaps ${action}\` needs a sitemap URL.`);
    const path = `/sites/${encodeURIComponent(site)}/sitemaps/${encodeURIComponent(feed)}`;

    if (action === 'get') {
      return { data: flattenSitemap(await client.webmasters<Sitemap>(path)) };
    }
    if (action === 'delete' && !values.yes) {
      throw usageError(`Deleting removes ${feed} from Search Console.`, 'Re-run with --yes to confirm.');
    }
    await client.webmasters<unknown>(path, { method: action === 'submit' ? 'PUT' : 'DELETE' });
    return { data: { site, sitemap: feed, [action === 'submit' ? 'submitted' : 'deleted']: true } };
  },
};

function flattenSitemap(s: Sitemap): Row {
  const submitted = (s.contents ?? []).reduce((sum, c) => sum + Number(c.submitted ?? 0), 0);
  return {
    path: s.path,
    type: s.type,
    isSitemapsIndex: s.isSitemapsIndex,
    isPending: s.isPending,
    lastSubmitted: s.lastSubmitted,
    lastDownloaded: s.lastDownloaded,
    submittedUrls: submitted,
    errors: Number(s.errors ?? 0),
    warnings: Number(s.warnings ?? 0),
    contents: s.contents?.map((c) => ({ type: c.type, submitted: Number(c.submitted ?? 0) })),
  };
}
