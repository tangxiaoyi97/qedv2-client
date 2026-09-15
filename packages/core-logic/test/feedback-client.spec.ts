import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerClient } from '../src/api/server-client.js';
import type { FeedbackSubmission } from '../src/api/feedback.js';

afterEach(() => vi.unstubAllGlobals());

describe('voluntary support submission', () => {
  const response = { id: 'feedback-1', status: 'open', createdAt: '2026-09-13T12:00:00Z' };
  const submission = {
    category: 'question' as const,
    issueType: 'attachment_error' as const,
    subject: 'Question diagram missing',
    message: 'The image attachment does not load.',
    questionId: 'exam/2026:question-1',
    submissionId: '30665c88-e4aa-43dd-af90-4a7e473944e0',
  };
  it('uses ordinary user authentication and projects only support fields', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ id: 'feedback-1', status: 'open', createdAt: '2026-09-13T12:00:00Z' }) });
    vi.stubGlobal('fetch', fetcher);
    const client = new ServerClient('https://server.example', () => 'ordinary-user-token');
    const body = { category: 'bug' as const, subject: 'A support issue', message: 'A deliberate description.', clientVersion: '2.5.0', platform: 'web', archive: { secret: true }, answer: 'private', token: 'never-upload' };
    expect(await client.submitFeedback(body)).toMatchObject({ id: 'feedback-1', status: 'open' });
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://server.example/me/feedback');
    const init = fetcher.mock.calls[0]?.[1] as { headers: Record<string, string>; body: string; credentials: string };
    expect(init.headers.Authorization).toBe('Bearer ordinary-user-token');
    expect(init.credentials).toBe('omit');
    expect(JSON.parse(init.body)).toEqual({ category: 'bug', subject: 'A support issue', message: 'A deliberate description.', clientVersion: '2.5.0', platform: 'web' });
  });

  it('does not silently retry when support delivery is uncertain', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('network failure'));
    vi.stubGlobal('fetch', fetcher);
    const client = new ServerClient('https://server.example', () => 'ordinary-user-token');
    await expect(client.submitFeedback({ category: 'suggestion', subject: 'A suggestion', message: 'User-written description.' })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('projects v2 context identifiers without nested private data or toJSON hooks', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify(response) });
    vi.stubGlobal('fetch', fetcher);
    const client = new ServerClient('https://server.example', () => 'ordinary-user-token');
    const context = {
      partId: 'question-1/a', coreBaseUrl: 'https://core.example/qed', bankCommit: 'a'.repeat(40), contentRevision: 'r2026.1',
      answer: 'private answer', archive: { secret: true }, token: 'never-upload',
      toJSON: () => ({ token: 'never-call-context-toJSON' }),
    };
    await client.submitFeedback({ ...submission, requestId: '3d6998a8-86a5-4472-9047-2258bfdeef99', context });
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body)).toEqual({
      ...submission, requestId: '3d6998a8-86a5-4472-9047-2258bfdeef99',
      context: { partId: context.partId, coreBaseUrl: context.coreBaseUrl, bankCommit: context.bankCommit, contentRevision: context.contentRevision },
    });
  });

  it.each([
    'https://user:secret@core.example', 'https://core.example?token=private', 'https://core.example#token',
    'https://core.example?', 'https://core.example#', 'file:///private/archive.json', 'javascript:alert(1)',
    'https://core.\texample', 'https://core.example/with space', `https://core.example/${'a'.repeat(512)}`,
  ])('rejects unsafe provenance before sending credentials or feedback: %s', (coreBaseUrl) => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const client = new ServerClient('https://server.example', () => 'ordinary-user-token');
    expect(() => client.submitFeedback({ ...submission, context: { coreBaseUrl } })).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects nested metadata objects rather than serializing private fields', () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const client = new ServerClient('https://server.example');
    const body = { ...submission, context: { partId: { toJSON: () => 'private-token' } } } as unknown as FeedbackSubmission;
    expect(() => client.submitFeedback(body)).toThrow('context.partId must be a string');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('discovers feedback capabilities using the current user token and a cancellable GET', async () => {
    const options = { schemaVersion: 2, categories: { question: ['question_error', 'answer_error', 'numbering_error', 'attachment_error', 'other'], bug: ['software_error', 'other'], suggestion: ['feature_request'] }, limits: { subjectMin: 3, subjectMax: 120, messageMin: 5, messageMax: 2000 }, idempotent: true };
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(options) });
    vi.stubGlobal('fetch', fetcher);
    let token = 'first-user-token';
    const client = new ServerClient('https://server.example', () => token);
    expect(await client.feedbackOptions()).toEqual(options);
    token = 'refreshed-user-token';
    const controller = new AbortController();
    controller.abort();
    await client.feedbackOptions({ signal: controller.signal });
    const [url, init] = fetcher.mock.calls[1]!;
    expect(url).toBe('https://server.example/me/feedback/options');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer refreshed-user-token');
    expect(init.credentials).toBe('omit');
    expect(init.body).toBeUndefined();
    expect(init.signal.aborted).toBe(true);
  });

  it('preserves idempotency conflicts for an explicit user decision without retrying', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 409, statusText: 'Conflict', text: async () => JSON.stringify({ error: { code: 'FEEDBACK_SUBMISSION_CONFLICT', message: 'Submission already used.' } }) });
    vi.stubGlobal('fetch', fetcher);
    const client = new ServerClient('https://server.example', () => 'ordinary-user-token');
    await expect(client.submitFeedback(submission)).rejects.toMatchObject({ status: 409, code: 'FEEDBACK_SUBMISSION_CONFLICT' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    undefined, null, {}, [],
    { ...response, id: '' }, { ...response, id: '   ' }, { ...response, id: 'x'.repeat(129) },
    { ...response, id: 'invalid\nreference' }, { ...response, status: 'unknown' },
    { ...response, createdAt: undefined }, { ...response, createdAt: 'invalid' },
    { ...response, createdAt: '2026-02-30T12:00:00Z' }, { ...response, createdAt: '2026-09-15T24:00:00Z' },
    { ...response, createdAt: '2026-09-15' }, { ...response, createdAt: '2026-09-15T12:00:00+25:00' },
  ])('rejects an incomplete or malformed successful receipt without retrying: %j', async (receipt) => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK', text: async () => receipt === undefined ? '' : JSON.stringify(receipt) });
    vi.stubGlobal('fetch', fetcher);
    const client = new ServerClient('https://server.example', () => 'ordinary-user-token');
    await expect(client.submitFeedback(submission)).rejects.toMatchObject({ name: 'FeedbackProtocolError', code: 'FEEDBACK_INVALID_RESPONSE' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['open', 'in_progress', 'resolved'])('accepts %s receipts and ignores future fields', async (status) => {
    const receipt = { ...response, status, createdAt: '2024-02-29T23:59:59.123+02:00' };
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 201, statusText: 'Created', text: async () => JSON.stringify({ ...receipt, schemaVersion: 3, futureField: { available: true } }) });
    vi.stubGlobal('fetch', fetcher);
    const client = new ServerClient('https://server.example', () => 'ordinary-user-token');
    expect(await client.submitFeedback(submission)).toEqual(receipt);
  });
});
