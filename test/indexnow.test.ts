import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { batchByHost, keyLocationFor } from '../src/commands/indexnow.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function run(...args: string[]) {
  const env = { ...process.env };
  delete env.GSC_INDEXNOW_KEY;
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe('indexnow', () => {
  it('batches URLs by host', () => {
    const batches = batchByHost(['https://a.com/1', 'https://b.com/1', 'https://A.com/2']);
    assert.deepEqual(batches, [
      { host: 'a.com', urls: ['https://a.com/1', 'https://A.com/2'] },
      { host: 'b.com', urls: ['https://b.com/1'] },
    ]);
  });

  it('splits batches at 10,000 URLs', () => {
    const urls = Array.from({ length: 10_001 }, (_, i) => `https://a.com/${i}`);
    assert.deepEqual(
      batchByHost(urls).map((b) => b.urls.length),
      [10_000, 1],
    );
  });

  it('defaults the key location to the site root', () => {
    assert.equal(keyLocationFor('a.com', 'abcdef12', undefined), 'https://a.com/abcdef12.txt');
    assert.equal(keyLocationFor('a.com', 'abcdef12', 'https://a.com/k.txt'), 'https://a.com/k.txt');
  });

  it('generates a valid key', () => {
    const res = run('indexnow', 'key');
    assert.equal(res.code, 0);
    assert.match(JSON.parse(res.stdout).key, /^[0-9a-f]{32}$/);
  });

  it('rejects a missing or malformed key before any request', () => {
    assert.equal(run('indexnow', 'submit', 'https://a.com/').code, 2);
    assert.equal(run('indexnow', 'submit', 'https://a.com/', '--key', 'bad key').code, 2);
    assert.equal(run('indexnow', 'submit', '--key', 'abcdef12').code, 2);
    assert.equal(run('indexnow').code, 2);
  });
});
