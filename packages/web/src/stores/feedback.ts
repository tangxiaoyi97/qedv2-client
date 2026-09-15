import { defineStore } from 'pinia';
import { shallowRef } from 'vue';
import type { FeedbackContext } from '@qed2/core-logic';

export type FeedbackTarget = { scope: 'software' } | {
  scope: 'question';
  questionId: string;
  context?: FeedbackContext;
};

/** Only the open dialog's target is shared. Reports never enter local storage. */
export const useFeedbackStore = defineStore('feedback', () => {
  const target = shallowRef<FeedbackTarget | null>(null);

  function openSoftware(): void {
    if (!target.value) target.value = { scope: 'software' };
  }

  function openQuestion(questionId: string, context?: FeedbackContext): void {
    if (!target.value) target.value = {
      scope: 'question', questionId,
      ...(context ? { context: { ...context } } : {}),
    };
  }

  function close(): void { target.value = null; }
  return { target, openSoftware, openQuestion, close };
});
