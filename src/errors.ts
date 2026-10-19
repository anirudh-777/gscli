// Exit codes are part of the CLI contract: scripts and agents branch on them.
export const ExitCode = {
  ok: 0,
  error: 1,
  usage: 2,
  auth: 3,
  permission: 4,
  quota: 5,
} as const;

export type ExitCodeName = keyof typeof ExitCode;

export class CliError extends Error {
  readonly code: ExitCodeName;
  readonly hint?: string;
  readonly details?: unknown;

  constructor(code: ExitCodeName, message: string, options: { hint?: string; details?: unknown } = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }
}

export function usageError(message: string, hint?: string): CliError {
  return new CliError('usage', message, { hint });
}
