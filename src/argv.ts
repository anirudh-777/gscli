const VALUE_FLAGS = new Set(['--site', '-s', '--format', '-f', '--credentials', '--quota-project']);

/** Splits off the command name, allowing global flags before it (`gscli --site x query`). */
export function splitCommand(argv: string[]): { name: string | undefined; rest: string[] } {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') break;
    if (VALUE_FLAGS.has(token)) {
      i++;
      continue;
    }
    if (!token.startsWith('-')) return { name: token, rest: [...argv.slice(0, i), ...argv.slice(i + 1)] };
  }
  return { name: undefined, rest: argv };
}
