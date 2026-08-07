import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: class BrowserWindow {},
  Menu: {
    buildFromTemplate: vi.fn(),
    setApplicationMenu: vi.fn(),
  },
}));

import { buildApplicationMenuTemplate } from '../src/main/menu.js';

function submenu(
  template: MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions[] {
  const item = template.find((candidate) => candidate.label === label);
  if (!item || !Array.isArray(item.submenu)) throw new Error(`Missing ${label} menu`);
  return item.submenu;
}

function click(items: MenuItemConstructorOptions[], label: string): void {
  const item = items.find((candidate) => candidate.label === label);
  if (!item?.click) throw new Error(`Missing ${label} action`);
  item.click({} as never, undefined, {} as never);
}

describe('desktop application menu', () => {
  it('makes every singleton window and native log recovery discoverable', () => {
    const openPracticeWindow = vi.fn();
    const openUpdateCenterWindow = vi.fn();
    const openNodeDiagnosticsWindow = vi.fn();
    const openLogs = vi.fn();
    const dispatch = vi.fn();
    const template = buildApplicationMenuTemplate({
      appName: 'QED2',
      platform: 'darwin',
      dispatch,
      openPracticeWindow,
      openUpdateCenterWindow,
      openNodeDiagnosticsWindow,
      openLogs,
    });

    const windows = submenu(template, 'Fenster');
    click(windows, 'Üben in eigenem Fenster');
    click(windows, 'Update-Center');
    click(windows, 'Knotendiagnose');
    click(submenu(template, 'Hilfe'), 'Diagnoseprotokoll anzeigen');

    expect(openPracticeWindow).toHaveBeenCalledOnce();
    expect(openUpdateCenterWindow).toHaveBeenCalledOnce();
    expect(openNodeDiagnosticsWindow).toHaveBeenCalledOnce();
    expect(openLogs).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('disables native actions whose main-process capability is absent', () => {
    const template = buildApplicationMenuTemplate({
      appName: 'QED2',
      platform: 'linux',
      dispatch: vi.fn(),
    });
    const windows = submenu(template, 'Fenster');

    expect(windows.find((item) => item.label === 'Üben in eigenem Fenster')?.enabled).toBe(false);
    expect(windows.find((item) => item.label === 'Update-Center')?.enabled).toBe(false);
    expect(windows.find((item) => item.label === 'Knotendiagnose')?.enabled).toBe(false);
  });
});
