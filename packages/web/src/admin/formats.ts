import { ManagementError } from './api.js';
export function isoInput(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new ManagementError('INVALID_REQUEST', '请输入有效日期。');
  return date.toISOString();
}
export function dateInput(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '';
}
function queryValue(value: string): string { return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`); }
export function query(path: string, values: Record<string, string | number>): string {
  const entries = Object.entries(values).filter(([, value]) => value !== '').map(([key, value]) => `${queryValue(key)}=${queryValue(String(value))}`);
  return `${path}?${entries.join('&')}`;
}
