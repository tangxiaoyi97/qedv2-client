/** The shell owns catalog loading; shared chips only request a detail view. */
import { inject, provide, type InjectionKey } from 'vue';

export interface CompetencyDetailsRequest {
  code: string;
  description?: string;
}

export type CompetencyDetailsHandler = (request: CompetencyDetailsRequest) => void;

const KEY: InjectionKey<CompetencyDetailsHandler> = Symbol('qed2-competency-details');

export function provideCompetencyDetails(handler: CompetencyDetailsHandler): void {
  provide(KEY, handler);
}

export function useCompetencyDetails(): CompetencyDetailsHandler | null {
  return inject(KEY, null);
}
