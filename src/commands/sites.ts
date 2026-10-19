import { listSites } from '../api.ts';
import type { Command } from '../command.ts';

export const sites: Command = {
  name: 'sites',
  summary: 'List the properties these credentials can access',
  usage: 'gscli sites',
  help: `Lists every Search Console property the credentials can see, with the permission level.
siteUnverifiedUser means the account was added but cannot read data.

Example:
  gscli sites --format json`,
  options: {},
  async run(ctx) {
    const rows = await listSites(ctx.client());
    return {
      meta: { count: rows.length },
      rows: rows.map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel })),
      columns: [{ key: 'siteUrl' }, { key: 'permissionLevel' }],
    };
  },
};
