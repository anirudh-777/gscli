import { usageError } from './errors.ts';

export const DIMENSIONS = ['query', 'page', 'country', 'device', 'searchAppearance', 'date', 'hour'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

const FILTERABLE: readonly string[] = ['query', 'page', 'country', 'device', 'searchAppearance'];

export interface DimensionFilter {
  dimension: string;
  operator: 'equals' | 'notEquals' | 'contains' | 'notContains' | 'includingRegex' | 'excludingRegex';
  expression: string;
}

export const FILTER_SYNTAX = `Filter syntax (repeat --filter to AND them):
  query=shoes        equals
  query!=shoes       does not equal
  query~shoe         contains
  query!~shoe        does not contain
  query~/^best /     matches regex (RE2)
  query!~/brand/     does not match regex
  Dimensions: ${FILTERABLE.join(', ')}. country uses ISO 3166-1 alpha-3 (ind, usa); device is DESKTOP, MOBILE or TABLET.`;

/** Parses `dimension<op>value` into a Search Console dimension filter. */
export function parseFilter(raw: string): DimensionFilter {
  const match = /^([a-zA-Z]+)\s*(!=|!~|=|~)(.*)$/s.exec(raw);
  if (!match) throw usageError(`Invalid filter "${raw}".`, FILTER_SYNTAX);
  const [, dimension, op, rest] = match as unknown as [string, string, string, string];
  if (!FILTERABLE.includes(dimension)) {
    throw usageError(`Cannot filter on "${dimension}".`, `Filterable dimensions: ${FILTERABLE.join(', ')}.`);
  }

  const value = rest.trim();
  if (!value) throw usageError(`Filter "${raw}" has no value.`, FILTER_SYNTAX);

  const regex = /^\/(.*)\/$/s.exec(value);
  if (regex && (op === '~' || op === '!~')) {
    return { dimension, operator: op === '~' ? 'includingRegex' : 'excludingRegex', expression: regex[1]! };
  }
  const operator = ({ '=': 'equals', '!=': 'notEquals', '~': 'contains', '!~': 'notContains' } as const)[
    op as '=' | '!=' | '~' | '!~'
  ];
  let expression = value;
  if (dimension === 'device') expression = value.toUpperCase();
  if (dimension === 'country') expression = value.toLowerCase();
  return { dimension, operator, expression };
}

export function parseDimensions(raw: string | undefined, fallback: Dimension[]): Dimension[] {
  if (!raw) return fallback;
  const dims = raw
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
  for (const d of dims) {
    if (!(DIMENSIONS as readonly string[]).includes(d)) {
      throw usageError(`Unknown dimension "${d}".`, `Valid dimensions: ${DIMENSIONS.join(', ')}.`);
    }
  }
  return dims as Dimension[];
}
