import { ManagementError } from './api.js';

export interface BankSource { repository: string; ref: string }
export interface BankIdentity extends BankSource { commit: string | null }
export interface BankSourceState {
  source: BankSource & { revision: string; origin: 'deployment' | 'override' };
  defaultSource: BankSource;
  current: BankIdentity;
  pending: BankIdentity | null;
}
export interface BankSourceSaved extends BankSourceState {
  latestCommit: string;
  changed: boolean;
  durability: 'confirmed' | 'uncertain';
}
export const isCommit = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const isSourceRevision = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function isBankSource(value: unknown): value is BankSource {
  const source = value as Partial<BankSource> | null;
  return !!source && typeof source.repository === 'string' && source.repository.length <= 256 && /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*(?:\.git)?$/.test(source.repository)
    && typeof source.ref === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(source.ref)
    && !source.ref.includes('..') && !source.ref.includes('//') && !source.ref.endsWith('.')
    && source.ref.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'));
}
export function isBankIdentity(value: unknown): value is BankIdentity {
  return isBankSource(value) && ((value as BankIdentity).commit === null || isCommit((value as BankIdentity).commit));
}
export function sameBankSource(a: BankSource, b: BankSource): boolean {
  return a.repository.replace(/\.git$/, '').toLowerCase() === b.repository.replace(/\.git$/, '').toLowerCase() && a.ref === b.ref;
}
export function assertBankSourceState(value: BankSourceState): void {
  if (!value || !isBankSource(value.source) || !isSourceRevision(value.source.revision)
    || !['deployment', 'override'].includes(value.source.origin) || !isBankSource(value.defaultSource)
    || !isBankIdentity(value.current) || value.pending !== null && (!isBankIdentity(value.pending) || !isCommit(value.pending.commit))) {
    throw new ManagementError('INVALID_RESPONSE', '题库来源响应无效，请刷新后重试。');
  }
}
