import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CliError } from '../src/errors.ts';
import { parseDimensions, parseFilter } from '../src/filters.ts';

describe('parseFilter', () => {
  it('maps each operator', () => {
    assert.deepEqual(parseFilter('query=shoes'), { dimension: 'query', operator: 'equals', expression: 'shoes' });
    assert.deepEqual(parseFilter('query!=shoes'), { dimension: 'query', operator: 'notEquals', expression: 'shoes' });
    assert.deepEqual(parseFilter('page~/blog/'), { dimension: 'page', operator: 'includingRegex', expression: 'blog' });
    assert.deepEqual(parseFilter('page~blog'), { dimension: 'page', operator: 'contains', expression: 'blog' });
    assert.deepEqual(parseFilter('query!~brand'), { dimension: 'query', operator: 'notContains', expression: 'brand' });
    assert.deepEqual(parseFilter('query!~/^brand/'), {
      dimension: 'query',
      operator: 'excludingRegex',
      expression: '^brand',
    });
  });

  it('keeps operators inside the value', () => {
    assert.deepEqual(parseFilter('page=https://a.com/?q=1'), {
      dimension: 'page',
      operator: 'equals',
      expression: 'https://a.com/?q=1',
    });
  });

  it('normalizes device and country case', () => {
    assert.equal(parseFilter('device=mobile').expression, 'MOBILE');
    assert.equal(parseFilter('country=IND').expression, 'ind');
  });

  it('rejects unknown dimensions and empty values', () => {
    assert.throws(() => parseFilter('date=2026-01-01'), CliError);
    assert.throws(() => parseFilter('query='), CliError);
    assert.throws(() => parseFilter('shoes'), CliError);
  });
});

describe('parseDimensions', () => {
  it('splits and validates', () => {
    assert.deepEqual(parseDimensions('query, page', ['query']), ['query', 'page']);
    assert.deepEqual(parseDimensions(undefined, ['query']), ['query']);
    assert.throws(() => parseDimensions('keyword', ['query']), CliError);
  });
});
