import { roundScore } from '@qed2/core-logic';
import { useI18n } from '../i18n.js';

export function formatUiScore(points: number): string {
  return useI18n().formatNumber(roundScore(points), { useGrouping: false, maximumFractionDigits: 2 });
}

export function formatUiScoreRatio(awarded: number, maximum: number): string {
  const { t } = useI18n();
  return `${formatUiScore(awarded)} / ${formatUiScore(maximum)} ${t('P')}`;
}
