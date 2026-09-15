import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, reactive, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import { ApiError } from '@qed2/core-logic';
import { setUiLocale } from '@qed2/ui';
import FeedbackDialog from '../src/routes/FeedbackDialog.vue';
import FeedbackSettings from '../src/routes/settings/FeedbackSettings.vue';
import { useFeedbackStore } from '../src/stores/feedback.js';

const state = vi.hoisted(() => ({
  auth: { isLoggedIn: true, transitioning: false, session: { user: { id: 'test-user' }, serverBaseUrl: 'https://server.example' } },
  app: { config: { serverBaseUrl: 'https://server.example' }, online: true, serverClient: { submitFeedback: vi.fn(), feedbackOptions: vi.fn() } },
  ui: { openAuthModal: vi.fn() },
}));
vi.mock('../src/stores/auth.js', () => ({ useAuthStore: () => state.auth }));
vi.mock('../src/stores/app.js', () => ({ useAppStore: () => state.app }));
vi.mock('../src/stores/ui.js', () => ({ useUiStore: () => state.ui }));
vi.mock('../src/services.js', () => ({ APP_VERSION: '2.5.0', ports: { shell: { capabilities: { desktop: false } } } }));
const OPTIONS = {
  schemaVersion: 2, idempotent: true,
  categories: { question: ['question_error', 'answer_error', 'numbering_error', 'attachment_error', 'other'], bug: ['software_error', 'other'], suggestion: ['feature_request'] },
  limits: { subjectMin: 3, subjectMax: 120, messageMin: 5, messageMax: 2000 },
};
let app: App | undefined;
let pinia: Pinia;
let host: HTMLElement;
async function settle(): Promise<void> { for (let index = 0; index < 4; index++) { await nextTick(); await Promise.resolve(); } }
function query<T extends Element = HTMLElement>(selector: string): T { return document.querySelector<T>(selector)!; }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function mount(question = false): Promise<void> {
  pinia = createPinia(); setActivePinia(pinia);
  host = document.createElement('div'); document.body.append(host);
  app = createApp({ render: () => h('div', [h(FeedbackSettings), h(FeedbackDialog)]) });
  app.use(pinia); app.mount(host);
  if (question) useFeedbackStore().openQuestion('2026-question-1', { partId: '2026-question-1-a', coreBaseUrl: 'https://pinned-core.example', bankCommit: 'a'.repeat(40) });
  else { const button = query<HTMLButtonElement>('[data-feedback-entry="software"]'); button.focus(); button.click(); }
  await settle();
}
async function fill(selector: string, value: string): Promise<void> {
  const element = query<HTMLInputElement | HTMLSelectElement>(selector);
  element.value = value; element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); await settle();
}
async function fillReport(issue = 'software_error'): Promise<void> {
  await fill('#feedback-issue', issue); await fill('#feedback-subject', 'A test report'); await fill('#feedback-message', 'A user-written test description.');
}
async function submit(): Promise<void> { query('form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); await settle(); }
async function clickLabel(label: string): Promise<void> {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find(item => item.textContent?.trim() === label);
  expect(button).toBeDefined(); button!.click(); await settle();
}
function escape(): KeyboardEvent { const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true }); document.dispatchEvent(event); return event; }

beforeEach(() => {
  state.auth = reactive({ isLoggedIn: true, transitioning: false, session: { user: { id: 'test-user' }, serverBaseUrl: 'https://server.example' } });
  state.app = reactive({ config: { serverBaseUrl: 'https://server.example' }, online: true, serverClient: { submitFeedback: vi.fn(), feedbackOptions: vi.fn().mockResolvedValue(structuredClone(OPTIONS)) } });
  state.ui.openAuthModal.mockReset();
  setUiLocale('de');
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
});
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); setUiLocale('de'); });

describe('account-scoped feedback dialog', () => {
  it('opens a visible guest entry with deliberate login and does not fetch or submit', async () => {
    state.auth.isLoggedIn = false; await mount();
    expect(query('[role="dialog"]').textContent).toContain('Melde dich an');
    expect(document.querySelector('form')).toBeNull();
    expect(state.app.serverClient.feedbackOptions).not.toHaveBeenCalled();
    await clickLabel('Anmelden');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(state.ui.openAuthModal).toHaveBeenCalledOnce();
    expect(state.app.serverClient.submitFeedback).not.toHaveBeenCalled();
  });

  it('requires fields, associates each error and focuses the first invalid field', async () => {
    await mount(); await submit();
    expect(state.app.serverClient.submitFeedback).not.toHaveBeenCalled();
    for (const field of ['issue', 'subject', 'message']) {
      expect(query(`#feedback-${field}`).getAttribute('aria-invalid')).toBe('true');
      expect(query(`#feedback-${field}`).getAttribute('aria-describedby')).toContain(`feedback-${field}-error`);
    }
    expect(document.activeElement).toBe(query('#feedback-issue'));
  });

  it('focuses the dialog while options are pending, then enables and focuses the type field', async () => {
    const pending = deferred<unknown>(); state.app.serverClient.feedbackOptions.mockReturnValue(pending.promise);
    await mount();
    await vi.waitFor(() => expect(document.activeElement).toBe(query('#feedback-title')));
    expect(query<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true);
    pending.resolve(structuredClone(OPTIONS)); await settle();
    expect(document.activeElement).toBe(query('#feedback-issue'));
  });

  it('returns to the edited field when cancelling the discard confirmation', async () => {
    await mount(); await fillReport();
    query<HTMLElement>('#feedback-message').focus(); escape(); await settle();
    expect(document.activeElement).toBe(query('[data-keep-feedback]'));
    await clickLabel('Weiter bearbeiten');
    expect(document.activeElement).toBe(query('#feedback-message'));
  });

  it.each(OPTIONS.categories.question)('prefills immutable question context and submits %s without answers or attachments', async (issue) => {
    state.app.serverClient.submitFeedback.mockResolvedValue({ id: 'feedback-question', status: 'open', createdAt: '2026-09-15T00:00:00Z' });
    await mount(true);
    expect(query('[data-feedback-question]').textContent).toBe('2026-question-1');
    expect(query<HTMLInputElement>('#feedback-subject').value).toContain('2026-question-1');
    expect(Array.from(query<HTMLSelectElement>('#feedback-issue').options).slice(1).map(item => item.value)).toEqual(OPTIONS.categories.question);
    await fill('#feedback-issue', issue); await fill('#feedback-message', 'Wrong attachment in this question.'); await submit();
    expect(state.app.serverClient.submitFeedback).toHaveBeenCalledWith({
      category: 'question', issueType: issue, subject: 'Aufgabenfeedback: 2026-question-1', message: 'Wrong attachment in this question.',
      questionId: '2026-question-1', context: { partId: '2026-question-1-a', coreBaseUrl: 'https://pinned-core.example', bankCommit: 'a'.repeat(40) },
      clientVersion: '2.5.0', platform: 'web', submissionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    }, { signal: expect.any(AbortSignal) });
    expect(query('[role="status"]').textContent).toContain('feedback-question');
    expect(document.querySelector('form')).toBeNull();
  });

  it.each([['software_error', 'bug'], ['other', 'bug'], ['feature_request', 'suggestion']])('uses software scope for %s without invented question context', async (issue, category) => {
    state.app.serverClient.submitFeedback.mockResolvedValue({ id: 'software-report', status: 'open', createdAt: '2026-09-15T00:00:00Z' });
    await mount(); await fillReport(issue); await submit();
    expect(state.app.serverClient.submitFeedback.mock.calls[0]![0]).toEqual({ category, issueType: issue, subject: 'A test report', message: 'A user-written test description.', clientVersion: '2.5.0', platform: 'web', submissionId: expect.any(String) });
  });

  it('retains failed text and retry identity, changes the key only when the report changes', async () => {
    state.app.serverClient.submitFeedback.mockRejectedValue(new Error('offline'));
    await mount(); await fillReport(); await submit();
    const first = state.app.serverClient.submitFeedback.mock.calls[0]![0].submissionId;
    expect(query<HTMLTextAreaElement>('#feedback-message').value).toBe('A user-written test description.');
    expect(query('[role="alert"]').textContent).toContain('Übertragung nicht bestätigt');
    expect(state.app.serverClient.submitFeedback).toHaveBeenCalledTimes(1);
    await submit(); expect(state.app.serverClient.submitFeedback.mock.calls[1]![0].submissionId).toBe(first);
    await fill('#feedback-message', '  A user-written test description.  '); await submit();
    expect(state.app.serverClient.submitFeedback.mock.calls[2]![0].submissionId).toBe(first);
    await fill('#feedback-message', 'An amended description.'); await submit();
    expect(state.app.serverClient.submitFeedback.mock.calls[3]![0].submissionId).not.toBe(first);
  });

  it.each([{}, { id: '', status: 'open', createdAt: '2026-09-15T00:00:00Z' }, { id: 'receipt', status: 'open', createdAt: 'not a date' }])('retains the report and retry identity when HTTP success carries an invalid receipt', async (receipt) => {
    state.app.serverClient.submitFeedback.mockResolvedValue(receipt);
    await mount(); await fillReport(); await submit();
    const first = state.app.serverClient.submitFeedback.mock.calls[0]![0].submissionId;
    expect(query<HTMLTextAreaElement>('#feedback-message').value).toBe('A user-written test description.');
    expect(query('[role="alert"]').textContent).toContain('Übertragung nicht bestätigt');
    await submit(); expect(state.app.serverClient.submitFeedback.mock.calls[1]![0].submissionId).toBe(first);
  });

  it('blocks duplicate POSTs and closing while an explicit submission is pending', async () => {
    const pending = deferred<unknown>(); state.app.serverClient.submitFeedback.mockReturnValue(pending.promise);
    await mount(); await fillReport(); await submit(); await submit();
    expect(state.app.serverClient.submitFeedback).toHaveBeenCalledOnce();
    expect(query<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true);
    escape(); await settle(); expect(document.querySelector('form')).not.toBeNull();
    pending.resolve({ id: 'one-receipt', status: 'open', createdAt: '2026-09-15T00:00:00Z' }); await settle();
    expect(query('[role="status"]').textContent).toContain('one-receipt');
  });

  it('confirms draft discard, traps Escape before practice handlers, and restores entry focus', async () => {
    await mount(); await fillReport();
    const practiceKeydown = vi.fn(); document.addEventListener('keydown', practiceKeydown);
    try {
      expect(escape().defaultPrevented).toBe(true); await settle();
      expect(practiceKeydown).not.toHaveBeenCalled();
      expect(query('[role="dialog"]').textContent).toContain('Nicht gesendete');
      escape(); await settle();
      expect(query<HTMLTextAreaElement>('#feedback-message').value).toBe('A user-written test description.');
      escape(); await settle(); await clickLabel('Verwerfen');
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(query('[data-feedback-entry="software"]'));
    } finally { document.removeEventListener('keydown', practiceKeydown); }
  });

  it.each([404, 405])('fails closed on a legacy server options response %s', async (status) => {
    state.app.serverClient.feedbackOptions.mockRejectedValue(new ApiError(status, 'NOT_FOUND', 'old server'));
    await mount();
    expect(query('[role="alert"]').textContent).toContain('Server aktualisieren');
    expect(query<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true);
    await submit(); expect(state.app.serverClient.submitFeedback).not.toHaveBeenCalled();
  });

  it.each([
    { ...OPTIONS, idempotent: false }, { ...OPTIONS, schemaVersion: 1 },
    { ...OPTIONS, categories: { ...OPTIONS.categories, question: ['other'] } },
    { ...OPTIONS, limits: null },
  ])('rejects unsupported option schemas without silently dropping structured fields', async (options) => {
    state.app.serverClient.feedbackOptions.mockResolvedValue(options);
    await mount(); expect(query('[role="alert"]').textContent).toContain('Server aktualisieren');
    await submit(); expect(state.app.serverClient.submitFeedback).not.toHaveBeenCalled();
  });

  it.each([401, 429, 409])('keeps the draft and shows an actionable %s response', async (status) => {
    state.app.serverClient.submitFeedback.mockRejectedValue(new ApiError(status, 'FEEDBACK_ERROR', 'private backend detail'));
    await mount(); await fillReport(); await submit();
    expect(query('[role="alert"]').textContent).not.toContain('private backend detail');
    expect(query('[role="alert"]').textContent).toContain(status === 401 ? 'erneut anmelden' : status === 429 ? 'Zu viele' : 'Übertragungskonflikt');
    expect(query<HTMLTextAreaElement>('#feedback-message').value).toBe('A user-written test description.');
    expect(state.app.serverClient.submitFeedback).toHaveBeenCalledOnce();
  });

  it('asks before discarding an expired-session report for deliberate sign-in', async () => {
    state.app.serverClient.submitFeedback.mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'expired'));
    await mount(); await fillReport(); await submit(); await clickLabel('Anmelden');
    expect(state.ui.openAuthModal).not.toHaveBeenCalled();
    await clickLabel('Weiter bearbeiten');
    expect(query<HTMLTextAreaElement>('#feedback-message').value).toBe('A user-written test description.');
    await clickLabel('Anmelden'); await clickLabel('Verwerfen');
    expect(state.ui.openAuthModal).toHaveBeenCalledOnce();
  });

  it.each(['user', 'server', 'logout', 'transition'])('clears the report on %s boundary and ignores its late response', async (boundary) => {
    const pending = deferred<unknown>(); state.app.serverClient.submitFeedback.mockReturnValue(pending.promise);
    await mount(); await fillReport(); await submit();
    const signal = state.app.serverClient.submitFeedback.mock.calls[0]![1].signal;
    if (boundary === 'user') state.auth.session.user.id = 'second-user';
    if (boundary === 'server') { state.app.config.serverBaseUrl = 'https://other.example'; state.auth.session.serverBaseUrl = 'https://other.example'; }
    if (boundary === 'logout') state.auth.isLoggedIn = false;
    if (boundary === 'transition') state.auth.transitioning = true;
    await settle(); expect(signal.aborted).toBe(true); expect(document.querySelector('[role="dialog"]')).toBeNull();
    state.auth.isLoggedIn = true; state.auth.transitioning = false; await settle();
    useFeedbackStore().openSoftware(); await settle(); await fillReport(); await fill('#feedback-message', 'A new owner report.');
    pending.resolve({ id: 'wrong-owner-receipt', status: 'open', createdAt: '2026-09-15T00:00:00Z' }); await settle();
    expect(document.body.textContent).not.toContain('wrong-owner-receipt');
    expect(query<HTMLTextAreaElement>('#feedback-message').value).toBe('A new owner report.');
    expect(query<HTMLButtonElement>('button[type="submit"]').disabled).toBe(false);
  });

  it('does not let an old finally release the new owner’s pending submit', async () => {
    const old = deferred<unknown>(); const current = deferred<unknown>();
    state.app.serverClient.submitFeedback.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await mount(); await fillReport(); await submit(); state.auth.session.user.id = 'new-user'; await settle();
    useFeedbackStore().openSoftware(); await settle(); await fillReport(); await submit();
    old.resolve({ id: 'old', status: 'open', createdAt: '2026-09-15T00:00:00Z' }); await settle();
    expect(query<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true);
    current.resolve({ id: 'new', status: 'open', createdAt: '2026-09-15T00:00:00Z' }); await settle(); expect(query('[role="status"]').textContent).toContain('new');
  });

  it('does not let late options fill a reopened dialog and does not POST while offline', async () => {
    const old = deferred<unknown>(); state.app.serverClient.feedbackOptions.mockReturnValueOnce(old.promise);
    await mount(); useFeedbackStore().close(); await settle(); useFeedbackStore().openSoftware(); await settle();
    old.reject(new ApiError(404, 'NOT_FOUND', 'old')); await settle();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await fillReport(); state.app.online = false; await submit();
    expect(query('[role="alert"]').textContent).toContain('offline');
    expect(state.app.serverClient.submitFeedback).not.toHaveBeenCalled();
  });

  it('translates the form and fixed issue names with the existing app language', async () => {
    state.app.serverClient.submitFeedback.mockResolvedValue({ id: 'translated-receipt', status: 'open', createdAt: '2026-09-15T00:00:00Z' });
    setUiLocale('en'); await mount(true);
    expect(query('#feedback-title').textContent).toBe('Question feedback');
    expect(query<HTMLSelectElement>('#feedback-issue').textContent).toContain('Attachment or image error');
    expect(query('#feedback-data-note').textContent).toContain('not attached automatically');
    await fill('#feedback-issue', 'question_error'); await fill('#feedback-message', 'Check this question please.'); await submit();
    expect(query('[role="dialog"]').textContent).toContain('Feedback sent. Reference:');
    expect(query('[role="dialog"]').textContent).toContain('Done');
    expect(query('[role="dialog"]').textContent).not.toContain('Fertig');
  });
});
