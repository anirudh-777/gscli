import { CliError, ExitCode } from './errors.ts';

export const FORMATS = ['json', 'jsonl', 'csv', 'table'] as const;
export type Format = (typeof FORMATS)[number];

export type ColumnKind = 'text' | 'int' | 'pct' | 'position' | 'delta' | 'pctDelta' | 'positionDelta';

export interface Column {
  key: string;
  label?: string;
  kind?: ColumnKind;
  /** Table-only formatting when the kind depends on the row. */
  format?: (value: unknown, row: Row) => string;
}

export type Row = Record<string, unknown>;

/** What every command returns. `meta` describes the request; `rows` or `data` carry the answer. */
export interface Result {
  meta?: Row;
  rows?: Row[];
  columns?: Column[];
  data?: unknown;
}

export function defaultFormat(stdoutIsTty = Boolean(process.stdout.isTTY)): Format {
  return stdoutIsTty ? 'table' : 'json';
}

export function render(result: Result, format: Format, pretty = Boolean(process.stdout.isTTY)): string {
  switch (format) {
    case 'json': {
      const value = result.rows ? { ...result.meta, rows: result.rows } : (result.data ?? result.meta ?? {});
      return JSON.stringify(value, null, pretty ? 2 : undefined);
    }
    case 'jsonl': {
      const rows = result.rows ?? (Array.isArray(result.data) ? (result.data as unknown[]) : [result.data]);
      return rows.map((r) => JSON.stringify(r)).join('\n');
    }
    case 'csv':
      return renderCsv(result);
    case 'table':
      return renderTable(result);
  }
}

function columnsFor(result: Result): Column[] {
  if (result.columns) return result.columns;
  const keys = new Set<string>();
  for (const row of result.rows ?? []) for (const k of Object.keys(row)) keys.add(k);
  return [...keys].map((key) => ({ key }));
}

function renderCsv(result: Result): string {
  const rows = result.rows ?? (result.data && typeof result.data === 'object' ? [result.data as Row] : []);
  const columns = result.columns ?? columnsFor({ rows });
  const lines = [columns.map((c) => csvCell(c.key)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c.key])).join(','));
  return lines.join('\n');
}

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const MAX_CELL = 70;

function renderTable(result: Result): string {
  const out: string[] = [];
  if (result.meta) {
    const summary = Object.entries(result.meta)
      .filter(([, v]) => v !== undefined && v !== null && typeof v !== 'object')
      .map(([k, v]) => `${k}: ${v}`)
      .join('  ');
    if (summary) out.push(summary, '');
  }

  if (!result.rows) {
    out.push(renderKeyValues(result.data ?? {}));
    return out.join('\n');
  }
  if (result.rows.length === 0) {
    out.push('No rows.');
    return out.join('\n');
  }

  const columns = columnsFor(result);
  const header = columns.map((c) => c.label ?? c.key);
  const body = result.rows.map((row) =>
    columns.map((c) => truncate(c.format ? c.format(row[c.key], row) : formatCell(row[c.key], c.kind ?? 'text'))),
  );
  const numeric = columns.map((c) => (c.kind ?? 'text') !== 'text' || c.format !== undefined);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)));
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (numeric[i] ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!)))
      .join('  ')
      .trimEnd();

  out.push(line(header), widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of body) out.push(line(r));
  return out.join('\n');
}

function renderKeyValues(data: unknown, indent = ''): string {
  if (data === null || typeof data !== 'object') return `${indent}${String(data)}`;
  const lines: string[] = [];
  for (const [key, value] of Object.entries(data as Row)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${indent}${key}:`);
      for (const item of value) {
        if (item && typeof item === 'object') lines.push(renderKeyValues(item, `${indent}  `), '');
        else lines.push(`${indent}  - ${String(item)}`);
      }
    } else if (value && typeof value === 'object') {
      lines.push(`${indent}${key}:`, renderKeyValues(value, `${indent}  `));
    } else {
      lines.push(`${indent}${key}: ${String(value)}`);
    }
  }
  return lines.join('\n');
}

export function formatCell(value: unknown, kind: ColumnKind): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'number') return String(value);
  switch (kind) {
    case 'int':
      return Math.round(value).toLocaleString('en-US');
    case 'pct':
      return `${(value * 100).toFixed(2)}%`;
    case 'position':
      return value.toFixed(1);
    case 'delta':
      return `${value > 0 ? '+' : ''}${Math.round(value).toLocaleString('en-US')}`;
    case 'pctDelta':
      return `${value > 0 ? '+' : ''}${(value * 100).toFixed(2)}pp`;
    case 'positionDelta':
      return `${value > 0 ? '+' : ''}${value.toFixed(1)}`;
    default:
      return String(value);
  }
}

function truncate(s: string): string {
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL - 1)}…` : s;
}

export function renderError(err: CliError, format: Format): string {
  if (format === 'table') {
    return [`error: ${err.message}`, ...(err.hint ? [`hint: ${err.hint}`] : [])].join('\n');
  }
  return JSON.stringify({
    error: { code: err.code, exitCode: ExitCode[err.code], message: err.message, hint: err.hint, details: err.details },
  });
}

/** Search Console metrics, shared by every analytics command. */
export const METRIC_COLUMNS: Column[] = [
  { key: 'clicks', kind: 'int' },
  { key: 'impressions', kind: 'int' },
  { key: 'ctr', kind: 'pct' },
  { key: 'position', kind: 'position' },
];
