/**
 * Grundkompetenz-category rollups.
 *
 * The same eight-line grouping loop was written three times across the home
 * and progress views. It is arithmetic over domain data, so it belongs next
 * to `competencyCategory`, not in a component.
 */
import { competencyCategory } from '../model/question.js';
import { CATEGORY_ORDER, type CategoryCode } from '../model/labels.js';

export interface CategoryMastery {
  code: CategoryCode;
  /** Mean mastery of the competencies in this category, 0…1 (0 when none). */
  mastery: number;
  /** How many competencies contributed — 0 means the category is untouched. */
  count: number;
}

/**
 * Average mastery per category, in SRDP order.
 *
 * ALL four categories are always returned, untouched ones with `count: 0`, so
 * the radar can plot a complete axis set and list views can filter on `count`
 * themselves. Competencies outside the four (`other`) are ignored.
 */
export function groupMasteryByCategory(
  entries: readonly { code: string; mastery: number }[],
): CategoryMastery[] {
  const groups = new Map<CategoryCode, number[]>();
  for (const entry of entries) {
    const category = competencyCategory(entry.code);
    if (category === 'other') continue;
    const list = groups.get(category) ?? [];
    list.push(entry.mastery);
    groups.set(category, list);
  }
  return CATEGORY_ORDER.map((code) => {
    const list = groups.get(code) ?? [];
    const mastery = list.length > 0 ? list.reduce((sum, m) => sum + m, 0) / list.length : 0;
    return { code, mastery, count: list.length };
  });
}
