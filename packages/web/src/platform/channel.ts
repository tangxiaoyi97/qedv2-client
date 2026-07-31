/**
 * Release channel — the one place the app knows which environment it is.
 *
 * Stable and preview live on different origins on purpose (architecture §1.2):
 * same origin would mean one IndexedDB, and a preview build with a changed
 * archive shape would sync corruption into real accounts carrying a perfectly
 * valid checksum. Everything here follows from that separation.
 */
import { DEFAULT_CONFIG, type ClientConfig } from '@qed2/core-logic';

export type ReleaseChannel = 'stable' | 'preview';

export const CHANNEL: ReleaseChannel = __QED2_CHANNEL__ === 'preview' ? 'preview' : 'stable';

export const IS_PREVIEW = CHANNEL === 'preview';

/**
 * Sentinel string baked into the bundle.
 *
 * The production deploy asserts this token is ABSENT from dist/. It cannot
 * simply grep for "preview": the answer-preview feature already puts that word
 * in the bundle about two dozen times (`answerPreview`, `bar__preview`,
 * `showPreview`, …), so a naive guard would fail on day one, get bypassed, and
 * then protect nothing.
 */
export const CHANNEL_SENTINEL = __QED2_CHANNEL_SENTINEL__;

/**
 * Endpoint defaults for this channel.
 *
 * A stable build compiles the empty string here, so no preview host name ever
 * reaches the production bundle — the guard above has nothing to find because
 * there is nothing there, not because it was stripped.
 */
export function channelDefaults(): Partial<ClientConfig> {
  const overrides: Partial<ClientConfig> = {};
  if (__QED2_DEFAULT_CORE__) overrides.coreBaseUrl = __QED2_DEFAULT_CORE__;
  if (__QED2_DEFAULT_SERVER__) overrides.serverBaseUrl = __QED2_DEFAULT_SERVER__;
  return overrides;
}

/** The endpoints this build ships with, before any user override. */
export function channelConfig(): ClientConfig {
  return { ...DEFAULT_CONFIG, ...channelDefaults() };
}

/**
 * Mark the document with the channel, once, at startup.
 *
 * Two jobs. It gives the preview banner a CSS hook, and it makes the sentinel
 * a live reference — an export nothing reads is tree-shaken away, and the
 * deploy guard would then find no sentinel in a build that genuinely is a
 * preview. (That is exactly how this was caught.)
 */
export function applyChannelMarker(): void {
  const root = document.documentElement;
  root.dataset.qed2Channel = CHANNEL;
  if (IS_PREVIEW) root.dataset.qed2ChannelSentinel = CHANNEL_SENTINEL;
}
