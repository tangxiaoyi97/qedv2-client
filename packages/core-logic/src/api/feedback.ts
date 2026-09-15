/** Feedback belongs to the authenticated Server account, never the Core. */
export type FeedbackCategory = 'bug' | 'question' | 'suggestion';
export type QuestionFeedbackIssueType = 'question_error' | 'answer_error' | 'numbering_error' | 'attachment_error' | 'other';
export type SoftwareFeedbackIssueType = 'software_error' | 'other';
export type FeedbackIssueType = QuestionFeedbackIssueType | SoftwareFeedbackIssueType | 'feature_request';

/** Identifiers and provenance only; no answer, archive, credential or attachment. */
export interface FeedbackContext {
  partId?: string;
  coreBaseUrl?: string;
  bankCommit?: string;
  contentRevision?: string;
}

export interface FeedbackSubmission {
  category: FeedbackCategory;
  subject: string;
  message: string;
  /** Optional for compatibility with the original feedback endpoint. */
  issueType?: FeedbackIssueType;
  /** Reuse only for an explicit retry of the same submission on the same account. */
  submissionId?: string;
  clientVersion?: string;
  platform?: string;
  requestId?: string;
  questionId?: string;
  context?: FeedbackContext;
}

export interface FeedbackReceipt {
  id: string;
  status: 'open' | 'in_progress' | 'resolved';
  createdAt: string;
}

export class FeedbackProtocolError extends Error {
  override readonly name = 'FeedbackProtocolError';
  readonly code = 'FEEDBACK_INVALID_RESPONSE';

  constructor() {
    super('The Server did not return a valid feedback receipt. Delivery is unconfirmed.');
  }
}

/** A 2xx response is not confirmation until its receipt is complete and valid. */
export function parseFeedbackReceipt(value: unknown): FeedbackReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FeedbackProtocolError();
  const receipt = value as Record<string, unknown>;
  const { id, status, createdAt } = receipt;
  if (typeof id !== 'string' || id.length > 128 || !id.trim() || /[\u0000-\u001f\u007f]/u.test(id)
    || (status !== 'open' && status !== 'in_progress' && status !== 'resolved')
    || typeof createdAt !== 'string' || createdAt.length > 64
    || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(createdAt)
    || !Number.isFinite(Date.parse(createdAt))) {
    throw new FeedbackProtocolError();
  }
  // Date.parse normalizes impossible calendar dates such as February 30.
  const calendarDate = createdAt.slice(0, 10);
  if (new Date(`${calendarDate}T00:00:00Z`).toISOString().slice(0, 10) !== calendarDate) {
    throw new FeedbackProtocolError();
  }
  return { id, status, createdAt };
}

export interface FeedbackOptions {
  schemaVersion: 2;
  categories: {
    question: QuestionFeedbackIssueType[];
    bug: SoftwareFeedbackIssueType[];
    suggestion: 'feature_request'[];
  };
  limits: { subjectMin: 3; subjectMax: 120; messageMin: 5; messageMax: 2000 };
  idempotent: true;
}

/** Never copy arbitrary input objects, including objects nested in context. */
export function projectFeedbackSubmission(input: FeedbackSubmission): FeedbackSubmission {
  const string = (value: unknown, field: string): string => {
    if (typeof value !== 'string') throw new TypeError(`Feedback ${field} must be a string`);
    return value;
  };
  const optional = (value: unknown, field: string): string | undefined => value === undefined || value === ''
    ? undefined : string(value, field);
  const body: FeedbackSubmission = {
    category: string(input.category, 'category') as FeedbackCategory,
    subject: string(input.subject, 'subject'),
    message: string(input.message, 'message'),
  };
  for (const key of ['submissionId', 'clientVersion', 'platform', 'requestId', 'questionId'] as const) {
    const value = optional(input[key], key);
    if (value !== undefined) body[key] = value;
  }
  if (input.issueType !== undefined) body.issueType = string(input.issueType, 'issueType') as FeedbackIssueType;
  if (input.context !== undefined) {
    if (!input.context || typeof input.context !== 'object' || Array.isArray(input.context)) {
      throw new TypeError('Feedback context must be an object');
    }
    const context: FeedbackContext = {};
    for (const key of ['partId', 'coreBaseUrl', 'bankCommit', 'contentRevision'] as const) {
      const value = optional(input.context[key], `context.${key}`);
      if (value !== undefined) context[key] = value;
    }
    if (context.coreBaseUrl !== undefined) {
      const value = context.coreBaseUrl;
      const url = new URL(value);
      if (value.length > 512 || value !== value.trim() || /[?#\u0000-\u0020\u007f]/u.test(value)
        || !['http:', 'https:'].includes(url.protocol) || !url.hostname
        || url.username || url.password || url.search || url.hash) {
        throw new TypeError('Feedback Core URL must use HTTP(S) without credentials, query or fragment');
      }
    }
    if (Object.keys(context).length > 0) body.context = context;
  }
  return body;
}
