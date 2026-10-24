#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolveSite } from './api.ts';
import { SearchConsoleClient, toCliError } from './client.ts';
import { GLOBAL_HELP, GLOBAL_OPTIONS, str, type Command, type Context } from './command.ts';
import { auth } from './commands/auth.ts';
import { bing } from './commands/bing.ts';
import { compare } from './commands/compare.ts';
import { indexnow } from './commands/indexnow.ts';
import { inspect } from './commands/inspect.ts';
import { opportunities } from './commands/opportunities.ts';
import { query } from './commands/query.ts';
import { sitemaps } from './commands/sitemaps.ts';
import { sites } from './commands/sites.ts';
import { summary } from './commands/summary.ts';
import { splitCommand } from './argv.ts';
import { CliError, ExitCode, usageError } from './errors.ts';
import { FILTER_SYNTAX } from './filters.ts';
import { defaultFormat, FORMATS, render, renderError, type Format } from './output.ts';

const COMMANDS: Command[] = [sites, summary, query, compare, opportunities, inspect, indexnow, sitemaps, bing, auth];

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string })
  .version;

const EXIT_CODES_HELP = `Exit codes:
  0  success
  1  unexpected error
  2  usage error (bad flag, date, filter or dimension)
  3  credentials missing, rejected or lacking a scope
  4  no access to the property or resource, or it does not exist
  5  quota exceeded`;

const OUTPUT_HELP = `Output:
  JSON when stdout is not a terminal, so agents and scripts get structured data by default.
  Row commands print {...meta, "rows": [...]}; metrics are raw numbers (ctr is a 0-1 fraction).
  Errors go to stderr; in JSON mode as {"error": {"code", "exitCode", "message", "hint"}}.`;

function mainHelp(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  return `gscli ${VERSION}: Google Search Console from the command line, built for agents and scripts.

Usage: gscli <command> [options]

Commands:
${COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`).join('\n')}
  ${'help'.padEnd(width)}  gscli help <command> | filters | exit-codes

${GLOBAL_HELP}

${OUTPUT_HELP}

${EXIT_CODES_HELP}

Get started:
  gscli auth login         # one-time, uses gcloud
  gscli sites
  gscli summary --site example.com
  gscli query --last 7d -n 20`;
}

function commandHelp(command: Command): string {
  return `${command.summary}

Usage: ${command.usage}

${command.help}

${GLOBAL_HELP}`;
}

function helpTopic(topic: string | undefined): string {
  if (!topic) return mainHelp();
  if (topic === 'filters') return FILTER_SYNTAX;
  if (topic === 'exit-codes') return EXIT_CODES_HELP;
  const command = COMMANDS.find((c) => c.name === topic);
  if (!command) throw usageError(`No help for "${topic}".`, `Commands: ${COMMANDS.map((c) => c.name).join(', ')}.`);
  return commandHelp(command);
}

async function main(argv: string[]): Promise<number> {
  let format: Format = defaultFormat();
  try {
    const formatFlag = argv.findIndex((t) => t === '--format' || t === '-f');
    const early = formatFlag >= 0 ? argv[formatFlag + 1] : argv.find((t) => t.startsWith('--format='))?.slice(9);
    if (early && (FORMATS as readonly string[]).includes(early)) format = early as Format;

    if (argv.includes('--version') || argv.includes('-v')) {
      process.stdout.write(`${VERSION}\n`);
      return ExitCode.ok;
    }

    const { name, rest } = splitCommand(argv);
    if (!name || name === 'help') {
      const topic = name === 'help' ? splitCommand(rest).name : undefined;
      process.stdout.write(`${helpTopic(topic)}\n`);
      return ExitCode.ok;
    }

    const command = COMMANDS.find((c) => c.name === name);
    if (!command) {
      throw usageError(`Unknown command "${name}".`, `Commands: ${COMMANDS.map((c) => c.name).join(', ')}. Run \`gscli help\`.`);
    }

    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs({
        args: rest,
        options: { ...GLOBAL_OPTIONS, ...command.options },
        allowPositionals: command.allowPositionals ?? false,
        strict: true,
      });
    } catch (err) {
      throw usageError(err instanceof Error ? err.message : String(err), `Run \`gscli help ${command.name}\`.`);
    }
    const { values, positionals } = parsed;

    if (values.help) {
      process.stdout.write(`${commandHelp(command)}\n`);
      return ExitCode.ok;
    }

    const formatValue = str(values.format);
    if (formatValue) {
      if (!(FORMATS as readonly string[]).includes(formatValue)) {
        throw usageError(`Unknown format "${formatValue}".`, `Formats: ${FORMATS.join(', ')}.`);
      }
      format = formatValue as Format;
    }

    const clients = new Map<boolean, SearchConsoleClient>();
    const ctx: Context = {
      format,
      client: ({ write = false } = {}) => {
        let client = clients.get(write);
        if (!client) {
          client = new SearchConsoleClient({
            credentials: str(values.credentials),
            quotaProject: str(values['quota-project']),
            write,
          });
          clients.set(write, client);
        }
        return client;
      },
      site: (client) => resolveSite(client, str(values.site)),
      siteRequested: Boolean(str(values.site) ?? process.env.GSC_SITE),
    };

    const result = await command.run(ctx, values, positionals);
    process.stdout.write(`${render(result, format)}\n`);
    return ExitCode.ok;
  } catch (err) {
    const error = err instanceof CliError ? err : toCliError(err);
    process.stderr.write(`${renderError(error, format)}\n`);
    return ExitCode[error.code];
  }
}

process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  // `gscli query | head` closes the pipe early; that is not a failure.
  if (err.code === 'EPIPE') process.exit(ExitCode.ok);
  throw err;
});

process.exitCode = await main(process.argv.slice(2));
