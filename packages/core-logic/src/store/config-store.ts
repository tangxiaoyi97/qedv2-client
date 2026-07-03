/**
 * Config store — persists user overrides of the client configuration and the
 * theme preference. Reads always merge over DEFAULT_CONFIG so new config
 * fields pick up their defaults without a migration.
 */
import { STORAGE } from '../ports/index.js';
import type { StoragePort } from '../ports/index.js';
import { mergeConfig } from '../config/index.js';
import type { ClientConfig } from '../config/index.js';

export type Theme = 'light' | 'dark' | 'system';

const CONFIG_KEY = 'overrides';
const THEME_KEY = 'theme';

export class ConfigStore {
  constructor(private readonly storage: StoragePort) {}

  async getConfig(): Promise<ClientConfig> {
    const overrides = await this.storage.get<Partial<ClientConfig>>(STORAGE.config, CONFIG_KEY);
    return mergeConfig(overrides);
  }

  /**
   * Raw user overrides only — lets shells layer their own defaults between
   * the package defaults and the user's explicit choices (e.g. Vite dev env
   * URLs), which getConfig() cannot distinguish.
   */
  async getOverrides(): Promise<Partial<ClientConfig> | undefined> {
    return this.storage.get<Partial<ClientConfig>>(STORAGE.config, CONFIG_KEY);
  }

  /** Merge a partial update into the stored overrides (not into defaults). */
  async setConfig(partial: Partial<ClientConfig>): Promise<void> {
    const overrides =
      (await this.storage.get<Partial<ClientConfig>>(STORAGE.config, CONFIG_KEY)) ?? {};
    await this.storage.set(STORAGE.config, CONFIG_KEY, { ...overrides, ...partial });
  }

  async getTheme(): Promise<Theme> {
    return (await this.storage.get<Theme>(STORAGE.config, THEME_KEY)) ?? 'system';
  }

  async setTheme(theme: Theme): Promise<void> {
    await this.storage.set(STORAGE.config, THEME_KEY, theme);
  }
}
