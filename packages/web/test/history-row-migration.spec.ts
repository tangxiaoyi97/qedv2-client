import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { HISTORY_EVENT_ROW_PREFIX, STORAGE } from '@qed2/core-logic';
import { historyLog, storage } from '../src/services.js';

describe('local history row migration', () => {
  beforeEach(async () => {
    await storage.clear(STORAGE.history);
  });

  it('keeps entries written before local profiles initialize', async () => {
    await historyLog.append({
      partId: 'part-1',
      questionId: 'question-1',
      verdict: 'correct',
      awardedPoints: 1,
      maxPoints: 1,
      grading: 'good',
      gradedAt: '2026-08-15T10:00:00.000Z',
    });
    await historyLog.append({
      partId: 'part-2',
      questionId: 'question-2',
      verdict: 'incorrect',
      awardedPoints: 0,
      maxPoints: 1,
      grading: 'baffled',
      gradedAt: '2026-08-14T10:00:00.000Z',
    });

    expect(await historyLog.count()).toBe(2);
    expect((await storage.keys(STORAGE.history)).filter(
      (key) => key.startsWith(HISTORY_EVENT_ROW_PREFIX),
    )).toHaveLength(2);
  });
});
