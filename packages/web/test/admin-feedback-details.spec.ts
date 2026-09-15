import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { ManagementClient } from '../src/admin/api.js';
import FeedbackSection from '../src/admin/sections/FeedbackSection.vue';
import type { Capabilities } from '../src/admin/server-types.js';

const apps: App[] = [];
const feedback = {
  id: 'feedback-1', user: { username: 'alice' }, category: 'question', issueType: 'attachment_error',
  status: 'open', subject: 'Missing question image', message: 'The diagram does not appear.',
  createdAt: '2026-09-15T10:00:00Z', questionId: 'exam/2026:question-1',
  context: { partId: 'question-1/a', coreBaseUrl: 'https://core.example/qed', bankCommit: 'a'.repeat(40), contentRevision: 'revision-v2' },
  clientVersion: '2.5.0', platform: 'web', submissionId: '30665c88-e4aa-43dd-af90-4a7e473944e0', requestId: '3d6998a8-86a5-4472-9047-2258bfdeef99',
};
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const page = (items: unknown[], current = 1, total = items.length) => ({ items, total, page: current, pageSize: 25 });
async function settle() { await nextTick(); await new Promise((done) => setTimeout(done, 0)); await nextTick(); }
async function setup(capabilities: Capabilities, handler: (url: string, init?: RequestInit) => Response | Promise<Response> = (url) => json(url.endsWith('/feedback/feedback-1') ? feedback : page([feedback]))) {
  const transport = vi.fn<typeof fetch>(async (url, init) => String(url).endsWith('/auth/login')
    ? json({ token: 'test-admin-token-1234567890', requiresPasswordSetup: false, expiresAt: new Date(Date.now() + 600_000).toISOString() })
    : handler(String(url), init));
  const client = new ManagementClient('https://server.example', transport);
  await client.login('test-password');
  const host = document.createElement('div'); document.body.append(host);
  const app = createApp(FeedbackSection, { client, capabilities }); app.mount(host); apps.push(app);
  await settle();
  return { host, transport };
}
async function change(host: ParentNode, selector: string, value: string) {
  const field = host.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
  field.value = value;
  field.dispatchEvent(new Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  await nextTick();
}
async function click(host: ParentNode, label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label)!;
  expect(button).toBeTruthy(); button.click(); await settle();
}
async function filter(host: ParentNode) {
  host.querySelector('.filter-fields')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle();
}
afterEach(() => { apps.splice(0).forEach((app) => app.unmount()); document.body.innerHTML = ''; vi.restoreAllMocks(); });

describe('feedback review context', () => {
  it('shows issue and question references in the list and exact identifiers in details', async () => {
    const { host } = await setup({ feedback: true, feedbackFilters: true, feedbackDetails: true });
    const list = host.querySelector('tbody')!;
    expect(list.textContent).toContain('附件错误');
    expect(list.textContent).toContain(feedback.questionId);
    expect(list.textContent).toContain(feedback.context.partId);
    await click(host, feedback.subject);
    const detail = host.querySelector('.feedback-detail')!;
    for (const value of [feedback.context.coreBaseUrl, feedback.context.bankCommit, feedback.context.contentRevision, feedback.id, feedback.submissionId, feedback.requestId, feedback.clientVersion, feedback.platform]) {
      expect(detail.textContent).toContain(value);
    }
    expect(detail.querySelector('a')).toBeNull();
  });

  it('shows old and unknown classifications safely without inventing provenance', async () => {
    const legacy = { ...feedback, user: null, issueType: null, questionId: null, context: null, submissionId: null, requestId: null };
    const { host } = await setup({ feedback: true }, (url) => json(url.endsWith('/feedback/feedback-1') ? legacy : page([{ ...legacy, issueType: '__proto__' }])));
    expect(host.querySelector('tbody')?.textContent).toContain('未知类型（__proto__）');
    await click(host, feedback.subject);
    const detail = host.querySelector('.feedback-detail')!;
    expect(detail.textContent).toContain('未分类');
    expect(detail.textContent).toContain('用户已删除');
    expect(detail.textContent).not.toContain(feedback.context.coreBaseUrl);
    expect([...detail.querySelectorAll('dd')].filter((item) => item.textContent === '—').length).toBe(7);
  });

  it('renders hostile feedback and source metadata as inert text', async () => {
    const hostile = { ...feedback, subject: '<img src=x onerror=alert(1)>', message: '<script>alert(1)</script>', issueType: '<svg onload=alert(1)>', context: { ...feedback.context, coreBaseUrl: 'javascript:alert(document.cookie)' }, token: 'never-render-token', answer: 'never-render-answer' };
    const { host } = await setup({ feedback: true, feedbackDetails: true }, (url) => json(url.endsWith('/feedback/feedback-1') ? hostile : page([hostile])));
    await click(host, hostile.subject);
    expect(host.textContent).toContain(hostile.message);
    expect(host.textContent).toContain(hostile.context.coreBaseUrl);
    expect(host.textContent).not.toContain('never-render-token');
    expect(host.textContent).not.toContain('never-render-answer');
    expect(host.querySelector('img, script, svg, a')).toBeNull();
  });
});

describe('feedback query compatibility', () => {
  it('requires feedbackDetails independently of the old feedbackFilters capability', async () => {
    const { host, transport } = await setup({ feedback: true, feedbackFilters: true });
    expect(host.querySelector('#feedback-search')).not.toBeNull();
    expect(host.querySelector('#feedback-issue-type')).toBeNull();
    expect(host.querySelector('#feedback-question-id')).toBeNull();
    await change(host, '#feedback-category', 'question');
    await change(host, '#feedback-search', ' image ');
    await filter(host);
    const url = new URL(String(transport.mock.calls.at(-1)![0]));
    expect(url.searchParams.get('q')).toBe('image');
    expect(url.searchParams.get('category')).toBe('question');
    expect(url.searchParams.has('issueType')).toBe(false);
    expect(url.searchParams.has('questionId')).toBe(false);
  });

  it('encodes exact question references, narrows category choices and resets all filters', async () => {
    const { host, transport } = await setup({ feedback: true, feedbackFilters: true, feedbackDetails: true });
    await change(host, '#feedback-category', 'question');
    await change(host, '#feedback-issue-type', 'attachment_error');
    await change(host, '#feedback-question-id', ' exam/2026:question-1 ');
    await filter(host);
    let url = new URL(String(transport.mock.calls.at(-1)![0]));
    expect(url.searchParams.get('issueType')).toBe('attachment_error');
    expect(url.searchParams.get('questionId')).toBe(feedback.questionId);
    expect(url.searchParams.get('page')).toBe('1');
    await change(host, '#feedback-category', 'bug');
    const issueField = host.querySelector<HTMLSelectElement>('#feedback-issue-type')!;
    expect(issueField.value).toBe('');
    expect([...issueField.options].map((item) => item.value)).toEqual(['', 'software_error', 'other']);
    await click(host, '重置');
    url = new URL(String(transport.mock.calls.at(-1)![0]));
    expect([...url.searchParams.keys()]).toEqual(['page']);
  });

  it('keeps the applied filter across pagination and writes only the status when reviewed', async () => {
    const { host, transport } = await setup({ feedback: true, feedbackFilters: true, feedbackDetails: true }, (url, init) => {
      if (init?.method === 'PATCH') return json({ ...feedback, status: 'resolved' });
      if (url.endsWith('/feedback/feedback-1')) return json(feedback);
      return json(page([feedback], Number(new URL(url).searchParams.get('page')), 26));
    });
    await change(host, '#feedback-issue-type', 'attachment_error'); await filter(host);
    await change(host, '#feedback-issue-type', 'question_error');
    await click(host, '下一页');
    const url = new URL(String(transport.mock.calls.at(-1)![0]));
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('issueType')).toBe('attachment_error');
    await click(host, feedback.subject);
    await change(host, '#feedback-status', 'resolved');
    host.querySelector('.feedback-detail form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    const writes = transport.mock.calls.filter(([, init]) => init?.method === 'PATCH');
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]![1]!.body as string)).toEqual({ status: 'resolved' });
    expect(host.textContent).toContain('反馈状态已保存');
  });
});
