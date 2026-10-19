import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { listSites } from '../api.ts';
import { READ_SCOPE, WRITE_SCOPE } from '../client.ts';
import type { Command } from '../command.ts';
import { CliError, usageError } from '../errors.ts';

const CLOUD_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

export function loginCommand(write: boolean): string[] {
  return [
    'gcloud',
    'auth',
    'application-default',
    'login',
    `--scopes=${[write ? WRITE_SCOPE : READ_SCOPE, CLOUD_SCOPE].join(',')}`,
  ];
}

const LOGIN_NOTES = [
  'On the consent screen, tick every checkbox; gcloud fails if the Google Cloud scope is left unticked.',
  'Then set the project billed for API quota: gcloud auth application-default set-quota-project <project-id>',
  'Enable the API in that project once: gcloud services enable searchconsole.googleapis.com --project <project-id>',
  'Alternative: a service account key (--credentials key.json), with the service account added as a user in Search Console.',
];

export const auth: Command = {
  name: 'auth',
  summary: 'Check credentials or log in with gcloud',
  usage: 'gscli auth <status|login> [options]',
  help: `Subcommands:
  status    Which credentials are in use, the Google account, scopes, quota project and
            how many properties they can read. Exits 3 if credentials are missing or rejected.
  login     Runs the gcloud login with the scopes this CLI needs (prints the command when
            not in a terminal or with --print).

Options:
      --write                Request write access too (needed for sitemaps submit/delete).
      --print                Print the login command instead of running it.

Credentials are looked up in this order: --credentials, GSC_CREDENTIALS,
GOOGLE_APPLICATION_CREDENTIALS, then gcloud application-default credentials.`,
  options: { write: { type: 'boolean' }, print: { type: 'boolean' } },
  allowPositionals: true,
  async run(ctx, values, positionals) {
    const [action = 'status'] = positionals;
    if (action === 'login') return login(Boolean(values.write), Boolean(values.print));
    if (action !== 'status') throw usageError(`Unknown auth subcommand "${action}".`, 'Use status or login.');

    const client = ctx.client();
    const authClient = await client.authClient();
    let token: string | null | undefined;
    try {
      token = (await authClient.getAccessToken()).token;
    } catch (err) {
      throw new CliError('auth', `Could not get an access token: ${err instanceof Error ? err.message : String(err)}`, {
        hint: 'Run `gscli auth login`, or pass --credentials <service-account.json>.',
      });
    }
    const info = token ? await tokenInfo(token) : {};
    const scopes = info.scope?.split(' ') ?? [];
    const sites = await listSites(client);

    return {
      data: {
        credentials:
          client.credentialsFile ?? join(homedir(), '.config/gcloud/application_default_credentials.json'),
        credentialType: authClient.constructor.name,
        account: info.email,
        scopes: scopes.length ? scopes : undefined,
        canRead: scopes.length ? scopes.includes(READ_SCOPE) || scopes.includes(WRITE_SCOPE) : undefined,
        canWrite: scopes.length ? scopes.includes(WRITE_SCOPE) : undefined,
        quotaProject: authClient.quotaProjectId,
        properties: sites.length,
      },
    };
  },
};

async function tokenInfo(token: string): Promise<{ email?: string; scope?: string }> {
  try {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
    return res.ok ? ((await res.json()) as { email?: string; scope?: string }) : {};
  } catch {
    return {};
  }
}

function login(write: boolean, print: boolean) {
  const command = loginCommand(write);
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const hasGcloud = spawnSync('gcloud', ['--version'], { stdio: 'ignore' }).status === 0;

  if (print || !interactive || !hasGcloud) {
    return {
      data: {
        command: command.join(' '),
        gcloudInstalled: hasGcloud,
        notes: hasGcloud ? LOGIN_NOTES : ['Install the Google Cloud CLI first: https://cloud.google.com/sdk/docs/install', ...LOGIN_NOTES],
      },
    };
  }

  process.stderr.write(`${LOGIN_NOTES[0]}\n\n`);
  const result = spawnSync(command[0]!, command.slice(1), { stdio: 'inherit' });
  if (result.status !== 0) throw new CliError('auth', 'gcloud login did not complete.', { hint: LOGIN_NOTES[0] });
  return {
    data: { loggedIn: true, next: LOGIN_NOTES.slice(1, 3), check: 'gscli auth status' },
  };
}
