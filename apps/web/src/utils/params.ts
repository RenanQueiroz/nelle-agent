import type {ParamRow} from '../types';

export function paramsToRows(params: Record<string, string>): ParamRow[] {
  return Object.entries(params).map(([key, value]) => ({
    id: createParamRowId(),
    key,
    value,
  }));
}

export function rowsToParams(rows: ParamRow[]): Record<string, string> {
  return Object.fromEntries(
    rows.map(row => [row.key.trim(), row.value.trim()] as const).filter(([key]) => key.length > 0),
  );
}

function createParamRowId(): string {
  return `param-${Math.random().toString(36).slice(2)}`;
}
