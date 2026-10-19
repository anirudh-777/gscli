import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { splitCommand } from '../src/argv.ts';
import { toCliError } from '../src/client.ts';
import { formatCell, render } from '../src/output.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function run(...args: string[]) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GSC_CREDENTIALS: '/nonexistent/credentials.json' },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe('splitCommand', () => {
  it('finds the command after global flags', () => {
    assert.deepEqual(splitCommand(['--site', 'a.com', 'query', '-n', '5']), {
      name: 'query',
      rest: ['--site', 'a.com', '-n', '5'],
    });
    assert.deepEqual(splitCommand(['-f', 'json']), { name: undefined, rest: ['-f', 'json'] });
  });
});

describe('render', () => {
  const result = {
    meta: { site: 'sc-domain:a.com' },
    rows: [{ query: 'a,b', clicks: 1200, ctr: 0.0512 }],
    columns: [{ key: 'query' }, { key: 'clicks', kind: 'int' as const }, { key: 'ctr', kind: 'pct' as const }],
  };

  it('puts meta and rows together in JSON', () => {
    assert.deepEqual(JSON.parse(render(result, 'json', false)), {
      site: 'sc-domain:a.com',
      rows: [{ query: 'a,b', clicks: 1200, ctr: 0.0512 }],
    });
  });

  it('quotes CSV cells and keeps raw numbers', () => {
    assert.equal(render(result, 'csv'), 'query,clicks,ctr\n"a,b",1200,0.0512');
  });

  it('formats table cells for people', () => {
    const table = render(result, 'table');
    assert.match(table, /1,200/);
    assert.match(table, /5\.12%/);
  });

  it('formats deltas with a sign', () => {
    assert.equal(formatCell(3, 'delta'), '+3');
    assert.equal(formatCell(-0.004, 'pctDelta'), '-0.40pp');
  });
});

describe('toCliError', () => {
  const httpError = (status: number, message: string) => ({ response: { status, data: { error: { message } } } });

  it('maps Google errors to exit codes with hints', () => {
    assert.equal(toCliError(httpError(403, 'Request had insufficient authentication scopes.')).code, 'auth');
    assert.equal(toCliError(httpError(403, "User does not have sufficient permission for site 'x'.")).code, 'permission');
    assert.equal(toCliError(httpError(429, 'Quota exceeded')).code, 'quota');
    assert.equal(toCliError(httpError(400, 'Invalid date')).code, 'usage');
    assert.equal(
      toCliError({ response: { status: 400, data: { error: 'invalid_grant', error_description: 'Bad Request' } } }).code,
      'auth',
    );
  });
});

describe('cli', () => {
  it('prints help and version', () => {
    assert.match(run('--help').stdout, /Commands:/);
    assert.match(run('help', 'query').stdout, /--dimensions/);
    assert.match(run('--version').stdout, /^\d+\.\d+\.\d+/);
  });

  it('reports usage errors as JSON with exit code 2 when piped', () => {
    const res = run('query', '--bogus');
    assert.equal(res.code, 2);
    assert.equal(JSON.parse(res.stderr).error.code, 'usage');
  });

  it('validates flags before touching credentials', () => {
    assert.equal(run('query', '--last', 'yesterday').code, 2);
    assert.equal(run('compare', '-d', 'date').code, 2);
    assert.equal(run('nope').code, 2);
  });

  it('exits 3 when credentials cannot be loaded', () => {
    const res = run('sites');
    assert.equal(res.code, 3);
    assert.match(JSON.parse(res.stderr).error.hint, /gscli auth login/);
  });
});
