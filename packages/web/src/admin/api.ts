export type NodeKind = 'server' | 'core';
export interface Grant { token: string; requiresPasswordSetup: boolean; expiresAt: string | number }
export interface NodeStatus { service: string; initialized: boolean; apiVersion: number }
export interface Page<T> { items: T[]; total: number; page: number; pageSize: number }
export type Data = Record<string, unknown>;

export class ManagementError extends Error {
  constructor(readonly code: string, message: string, readonly status = 0) { super(message); }
}

const MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: '密码或初始密钥不正确。', UNAUTHENTICATED: '认证失败或会话已过期，请重新登录。',
  INVALID_SESSION: '会话已过期，请重新登录。', SETUP_REQUIRED: '请先设置管理密码。', PASSWORD_REQUIRED: '请先设置管理密码。',
  INVALID_INPUT: '请检查输入内容。管理密码至少 12 个字符，最多 256 个 UTF-8 字节。',
  INVALID_REQUEST: '请求字段无效，请检查输入内容。', INVALID_PASSWORD: '管理密码至少 12 个字符，最多 256 个 UTF-8 字节。',
  VALIDATION_FAILED: '输入内容不符合要求，请检查字段。', CONFLICT: '记录已存在，请使用其他用户名或邀请码。',
  RATE_LIMITED: '请求过于频繁，请稍后再试。', AUTH_BUSY: '节点正在处理认证，请稍后再试。',
  ORIGIN_DENIED: '该节点尚未允许当前管理页面来源，请检查节点的管理 CORS 配置。',
  OPERATION_DISABLED: '该节点未启用此操作。', MANAGEMENT_BUSY: '已有维护任务正在运行，请等待完成。',
  CONFIRMATION_REQUIRED: '确认内容与目标不匹配，请重新输入。', DB_UNAVAILABLE: '数据库或管理数据结构不可用，请检查节点状态。',
  NOT_FOUND: '未找到记录或管理接口，请检查节点地址及版本。', FORBIDDEN: '当前会话无权执行此操作。',
  MANAGEMENT_UNAVAILABLE: '管理服务暂时不可用，请稍后重新连接。', STORAGE_UNAVAILABLE: '节点的管理身份存储不可用。',
  BANK_UPDATE_CHECK_FAILED: '无法检查远端题库版本，请稍后重试。', BANK_UPDATE_CHANGED: '远端题库已变化，请重新检查后再操作。',
  MANAGEMENT_ERROR: '节点处理请求失败，请检查节点日志。', INTERNAL_ERROR: '节点处理请求失败，请检查节点日志。',
};

/** Only a node origin may be persisted; never accept embedded credentials. */
export function normalizeNodeAddress(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new ManagementError('ADDRESS_INVALID', '请输入完整的节点地址，例如 https://qedsync.barcarolle.studio。'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash
    || !['', '/', '/management', '/management/'].includes(url.pathname)) {
    throw new ManagementError('ADDRESS_INVALID', '节点地址必须为 HTTPS，或本机 HTTP；不能包含密码、查询参数或其他路径。');
  }
  return url.origin;
}

/** A credential belongs to exactly one node instance. Tokens are memory-only. */
export class ManagementClient {
  private grant: Grant | null = null;
  private generation = 0;
  readonly address: string;
  constructor(address: string, private readonly transport: typeof fetch = (...args) => fetch(...args)) {
    this.address = normalizeNodeAddress(address);
  }
  get session(): Grant | null { return this.grant ? { ...this.grant } : null; }
  forget(): void { this.generation++; this.grant = null; }
  async status(): Promise<NodeStatus> { return this.request('/auth/status', undefined, false); }
  async login(secret: string): Promise<Grant> {
    this.forget();
    const generation = this.generation;
    return this.acceptGrant(await this.request('/auth/login', { secret }, false), generation);
  }
  async setup(password: string): Promise<Grant> {
    validateManagementPassword(password);
    const generation = this.generation;
    return this.acceptGrant(await this.request('/auth/setup', { password }), generation);
  }
  async changePassword(currentPassword: string, password: string): Promise<Grant> {
    validateManagementPassword(password);
    const generation = this.generation;
    return this.acceptGrant(await this.request('/auth/password', { currentPassword, password }), generation);
  }
  async logout(): Promise<void> {
    const generation = this.generation;
    try { if (this.grant) await this.request('/auth/logout', {}); } finally { if (generation === this.generation) this.forget(); }
  }
  private acceptGrant(value: Grant, generation: number): Grant {
    if (generation !== this.generation) throw new ManagementError('INVALID_SESSION', MESSAGES.INVALID_SESSION!);
    if (!value || typeof value.token !== 'string' || value.token.length < 20 || typeof value.requiresPasswordSetup !== 'boolean'
      || !Number.isFinite(new Date(value.expiresAt).getTime())) {
      throw new ManagementError('INVALID_RESPONSE', '节点返回了无法识别的认证响应。');
    }
    this.generation++;
    this.grant = { token: value.token, requiresPasswordSetup: value.requiresPasswordSetup, expiresAt: value.expiresAt };
    return { ...this.grant };
  }
  async request<T>(path: string, body?: unknown, authenticated = true, method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE', signal?: AbortSignal): Promise<T> {
    let decodedPath = '';
    try { decodedPath = decodeURIComponent(path.split('?')[0]!); } catch { /* rejected below */ }
    if (!/^\/[a-z][a-z0-9/?=&%._-]*$/i.test(path) || path.startsWith('//') || !decodedPath || decodedPath.split('/').some((part) => part === '.' || part === '..')) {
      throw new ManagementError('INVALID_PATH', '无效的管理接口路径。');
    }
    const generation = this.generation;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (authenticated) {
      if (!this.grant || new Date(this.grant.expiresAt).getTime() <= Date.now()) {
        this.forget();
        throw new ManagementError('INVALID_SESSION', MESSAGES.INVALID_SESSION!);
      }
      headers.Authorization = `Bearer ${this.grant.token}`;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 15_000);
    try {
      const response = await this.transport(`${this.address}/management${path}`, {
        method: method ?? (body === undefined ? 'GET' : 'POST'), headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
      });
      if (response.status === 401 && authenticated && generation === this.generation) this.forget();
      let value: unknown;
      try { value = await response.json(); } catch { throw new ManagementError('INVALID_RESPONSE', '节点未返回 JSON。请检查地址、管理端口或访问网关。', response.status); }
      if (!response.ok) {
        const detail = value as { error?: { code?: unknown }; code?: unknown };
        const rawCode = detail?.error?.code ?? detail?.code;
        const code = typeof rawCode === 'string' ? rawCode : 'REQUEST_FAILED';
        throw new ManagementError(code, MESSAGES[code] ?? `请求未成功（HTTP ${response.status}）。请检查输入或节点状态。`, response.status);
      }
      if (authenticated && generation !== this.generation) throw new ManagementError('SESSION_CHANGED', '管理会话已更新，请重新查询。');
      return value as T;
    } catch (error) {
      if (error instanceof ManagementError) throw error;
      if (signal?.aborted) throw new ManagementError('CANCELLED', '查询已取消。');
      throw new ManagementError('NETWORK_ERROR', body === undefined && (!method || method === 'POST')
        ? '无法连接节点。请检查地址、网络和该节点允许的管理页面来源。'
        : '连接中断，操作结果尚未确认。请先刷新相关列表或节点状态，避免重复提交。');
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
  }
}

export function validateManagementPassword(password: string): void {
  if ([...password].length < 12 || new TextEncoder().encode(password).length > 256) {
    throw new ManagementError('INVALID_INPUT', MESSAGES.INVALID_INPUT!);
  }
}
export function errorText(error: unknown): string {
  return error instanceof ManagementError ? error.message : '操作未完成，请检查节点状态后重试。';
}
export function dateText(value: unknown): string {
  if (!value || (typeof value !== 'string' && typeof value !== 'number')) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date) : '—';
}
export function numberText(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value) : '—';
}
