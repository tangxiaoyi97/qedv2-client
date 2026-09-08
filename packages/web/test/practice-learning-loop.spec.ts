import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const route = readFileSync(resolve(process.cwd(), 'src/routes/PracticeView.vue'), 'utf8');
const bar = readFileSync(resolve(process.cwd(), '../ui/src/practice/PracticeBottomBar.vue'), 'utf8');

describe('practice learning loop route contract', () => {
  it('keeps the first attempt self-first and figure assessment fail-closed', () => {
    expect(route).toContain('playerState.value.selfAssessment?.selectedPoints != null');
    expect(route).toContain('playerState.value.selfAssessment?.grading != null');
    expect(route).toContain('ai.canAssess(current.value.part, current.value.question)');
    expect(route).not.toContain('manualAssessment:');
    expect(route).not.toContain('applySuggestion');
    expect(route).not.toContain('suggestedSelfAssessment');
    expect(route).toContain('practice.sessionIdentityDurable');
    expect(route).toContain('ai.canLearn(current.value.question, current.value.part)');
  });

  it('has one progressive help surface and no legacy walkthrough panel', () => {
    expect(route).toContain('<AiLearningPanel');
    expect(route).toContain("mode: 'hint'");
    expect(route).toContain("mode: 'diagnosis'");
    expect(route).not.toContain("mode: identity ? 'diagnosis' : 'answer'");
    expect(route).toContain("type: 'start-correction'");
    expect(route).not.toContain('<AiExplainPanel');
    expect(route).not.toContain('showWalkthrough');
    expect(route).toContain("if (stage !== 'hint') authoredHint.value = null");
    expect(route).toContain(':can-request-diagnosis="learningStage === \'diagnosis\' && firstNeedsCorrection');
  });

  it('never reveals the official solution before a real first attempt', () => {
    expect(bar).toContain(":show-solution=\"state.phase !== 'answering' && solutionReady !== false\"");
    expect(bar).toContain('Lernhilfe öffnen');
    expect(bar).not.toContain('KI-Hilfe öffnen');
  });

  it('records correction by exact attempt and tells the truth about lost paid responses', () => {
    expect(route).toContain('practice.recordCorrection(attemptId, payload.partId, payload.result)');
    expect(route).toContain(':restored-first-result="practice.currentReview?.result"');
    expect(route).toContain("case 'AI_REQUEST_ALREADY_COMPLETED':");
    expect(route).toContain('Es wird nicht automatisch erneut bezahlt');
  });

  it('locks navigation and manual grading until local commits are durable', () => {
    expect(route).toContain(':grading-disabled="gradingOverrideDisabled"');
    expect(route).toContain('commitBusy.value\n  || commitError.value !== null');
    expect(route).toContain('playerState.value.attemptPhase === \'correction\'');
    expect(route).toContain('onBeforeRouteLeave(canLeaveCurrentAnswer)');
    expect(route).toContain('onBeforeRouteUpdate(async (to, from) => {');
    expect(route).toContain('return canLeaveCurrentAnswer();');
    expect(route).toContain('return !hasUndurableWork.value;');
    expect(route).toContain('if (answerDraftSaveBusy.value && !(await flushAnswerDraft())) return false;');
    expect(route).toContain("window.addEventListener('beforeunload', onBeforeUnload)");
    expect(route).toContain('ev.defaultPrevented');
  });

  it('clears a failed pre-save once the atomic answer commit consumes that grading', () => {
    const committed = route.slice(
      route.indexOf('pendingGrading.value = null;'),
      route.indexOf('pendingGradeCommit.value = null;'),
    );
    expect(committed).toContain('pendingGradingSaveSequence += 1');
    expect(committed).toContain('pendingGradingSaveBusy.value = false');
    expect(committed).toContain('pendingGradingSaveError.value = null');
  });

  it('never carries paid result or retry state into another learning phase', () => {
    expect(route).toContain("[() => playerState.value.phase, () => playerState.value.attemptPhase]");
    expect(route).toContain('assistResult.value = null;');
    expect(route).toContain('assistRenewGeneration.value = null;');
    expect(route).toContain('watch(learningStage, (stage, previousStage) => {');
    expect(route).toContain('learningError.value = null;');
    expect(route).toContain('learningRenewGeneration.value = null;');
    expect(route).toContain('pendingHintLevel.value = null;');
  });

  it('restores private answer drafts only from the account-scoped practice session', () => {
    expect(route).toContain(':restored-answer-draft="practice.currentAnswerDraft"');
    expect(route).toContain('@answer-draft="onAnswerDraft"');
    expect(route).toContain(':restored-submission-unavailable="Boolean(');
    expect(route).toContain('practice.saveAnswerDraft(partId, submission)');
    const answerDraftHandler = route.slice(
      route.indexOf('function onAnswerDraft'),
      route.indexOf('async function flushAnswerDraft'),
    );
    expect(answerDraftHandler).not.toContain('setTimeout');
    expect(answerDraftHandler).toContain('const operation = practice.saveAnswerDraft(partId, submission)');
    expect(answerDraftHandler).toContain("outcome.status === 'superseded-by-grade'");
    expect(answerDraftHandler).toContain("type: 'restore-review'");
  });
});
