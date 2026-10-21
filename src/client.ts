import { GoogleAuth, type AuthClient } from 'google-auth-library';
import { CliError } from './errors.ts';

export const READ_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
export const WRITE_SCOPE = 'https://www.googleapis.com/auth/webmasters';

const WEBMASTERS = 'https://www.googleapis.com/webmasters/v3';
const SEARCH_CONSOLE = 'https://searchconsole.googleapis.com/v1';

const LOGIN_HINT =
  'Run `gscli auth login` for the command that creates credentials, or pass --credentials <service-account.json>.';

export interface ClientOptions {
  credentials?: string;
  quotaProject?: string;
  write?: boolean;
  /** Base delay before retrying a 429 or 5xx response; it doubles on each attempt. */
  retryDelayMs?: number;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
}

const MAX_ATTEMPTS = 4;

export class SearchConsoleClient {
  readonly auth: GoogleAuth;
  readonly credentialsFile: string | undefined;
  private readonly quotaProject: string | undefined;
  private readonly retryDelayMs: number;
  private client: Promise<AuthClient> | undefined;

  constructor(options: ClientOptions = {}) {
    this.credentialsFile =
      options.credentials ?? process.env.GSC_CREDENTIALS ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;
    this.quotaProject = options.quotaProject ?? process.env.GSC_QUOTA_PROJECT;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.auth = new GoogleAuth({
      keyFile: this.credentialsFile,
      scopes: options.write ? [WRITE_SCOPE] : [READ_SCOPE],
    });
  }

  authClient(): Promise<AuthClient> {
    this.client ??= this.auth.getClient().then((client) => {
      if (this.quotaProject) client.quotaProjectId = this.quotaProject;
      return client;
    });
    return this.client.catch((err: unknown) => {
      this.client = undefined;
      throw new CliError('auth', `Could not load Google credentials: ${messageOf(err)}`, { hint: LOGIN_HINT });
    });
  }

  webmasters<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>(`${WEBMASTERS}${path}`, options);
  }

  searchConsole<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>(`${SEARCH_CONSOLE}${path}`, options);
  }

  private async request<T>(url: string, { method = 'GET', body }: RequestOptions = {}): Promise<T> {
    const client = await this.authClient();
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await client.request<T>({ url, method, data: body, retry: false });
        return res.data;
      } catch (err) {
        const status = statusOf(err);
        const retryable = status === 429 || (status !== undefined && status >= 500);
        if (retryable && attempt < MAX_ATTEMPTS) {
          await sleep(2 ** attempt * this.retryDelayMs * (1 + Math.random() / 2));
          continue;
        }
        throw toCliError(err);
      }
    }
  }
}

export function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  const status = statusOf(err);
  const message = googleMessage(err) ?? messageOf(err);
  const lower = message.toLowerCase();

  if (lower.includes('invalid_grant') || lower.includes('invalid_rapt') || status === 401) {
    return new CliError('auth', `Google rejected the credentials: ${message}`, { hint: LOGIN_HINT });
  }
  if (lower.includes('insufficient authentication scopes') || lower.includes('access_token_scope_insufficient')) {
    return new CliError('auth', `The credentials are missing a required scope: ${message}`, {
      hint: `Read commands need ${READ_SCOPE}; sitemap submit/delete needs ${WRITE_SCOPE}. Run \`gscli auth login --write\` for the right login command.`,
    });
  }
  if (lower.includes('has not been used in project') || lower.includes('is disabled')) {
    return new CliError('auth', message, {
      hint: 'Enable the API with `gcloud services enable searchconsole.googleapis.com --project <quota-project>`.',
    });
  }
  if (lower.includes('quota project') || lower.includes('requires a quota project')) {
    return new CliError('auth', message, {
      hint: 'Set one with `gcloud auth application-default set-quota-project <project>` or pass --quota-project.',
    });
  }
  if (status === 403) {
    return new CliError('permission', message, {
      hint: 'Run `gscli sites` to see the properties these credentials can access and their permission level.',
    });
  }
  if (status === 404) return new CliError('permission', message);
  if (status === 429) {
    return new CliError('quota', message, {
      hint: 'Search Console quota exceeded. URL inspection allows 2,000 calls per day and 600 per minute per property.',
    });
  }
  if (status === 400) return new CliError('usage', message);
  return new CliError('error', message);
}

function statusOf(err: unknown): number | undefined {
  const e = err as { status?: unknown; response?: { status?: unknown } };
  const status = e?.response?.status ?? e?.status;
  return typeof status === 'number' ? status : undefined;
}

function googleMessage(err: unknown): string | undefined {
  const data = (err as { response?: { data?: unknown } })?.response?.data as
    | { error?: { message?: string } | string; error_description?: string }
    | undefined;
  if (!data) return undefined;
  if (typeof data.error === 'object' && data.error?.message) return data.error.message;
  if (typeof data.error === 'string') {
    return data.error_description ? `${data.error}: ${data.error_description}` : data.error;
  }
  return undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
