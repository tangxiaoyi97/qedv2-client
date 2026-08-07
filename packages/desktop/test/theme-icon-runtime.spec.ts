import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  desktopThemeIconPath,
  loadDesktopThemeBackgrounds,
  normalizeDesktopAccent,
} from '../src/main/theme-icon.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Desktop runtime theme icon selection', () => {
  it('accepts future Web theme ids without accepting path input', () => {
    expect(normalizeDesktopAccent('weed')).toBe('weed');
    expect(normalizeDesktopAccent('sky')).toBe('sky');
    expect(normalizeDesktopAccent('raspberry')).toBe('raspberry');
    expect(normalizeDesktopAccent('violette')).toBe('violette');
    expect(normalizeDesktopAccent('future-sunset')).toBe('future-sunset');
    expect(normalizeDesktopAccent('../sky')).toBe('weed');
    expect(normalizeDesktopAccent('Sky')).toBe('weed');
    expect(normalizeDesktopAccent(null)).toBe('weed');
  });

  it('chooses the native artifact for each platform without accepting path input', () => {
    const root = '/opt/qed2/theme-icons';
    expect(desktopThemeIconPath(root, 'sky', 'darwin')).toBe(
      '/opt/qed2/theme-icons/sky/icon-1024.png',
    );
    expect(desktopThemeIconPath(root, 'raspberry', 'win32')).toBe(
      '/opt/qed2/theme-icons/raspberry/icon.ico',
    );
    expect(desktopThemeIconPath(root, 'violette', 'linux')).toBe(
      '/opt/qed2/theme-icons/violette/icon-512.png',
    );
  });

  it('loads only validated pre-paint colors generated from shared CSS tokens', () => {
    const root = mkdtempSync(join(tmpdir(), 'qed2-theme-backgrounds-'));
    temporaryDirectories.push(root);
    writeFileSync(join(root, 'theme-backgrounds.v1.json'), JSON.stringify({
      schemaVersion: 1,
      themes: {
        weed: { light: '#f5f5f6', dark: '#161613' },
        sky: { light: 'Canvas', dark: '#16191a' },
        '../escape': { light: '#ffffff', dark: '#000000' },
      },
    }));

    expect(loadDesktopThemeBackgrounds(root)).toEqual({
      weed: { light: '#f5f5f6', dark: '#161613' },
    });
  });
});
