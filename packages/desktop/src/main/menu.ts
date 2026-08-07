import type { ShellCommand } from '@qed2/core-logic';
import { BrowserWindow, Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';

export type ShellCommandDispatcher = (
  command: ShellCommand,
  targetWindow?: BrowserWindow,
) => void;

export interface ApplicationMenuOptions {
  appName: string;
  dispatch: ShellCommandDispatcher;
  /** Opens or focuses the singleton practice workspace. */
  openPracticeWindow?: () => void;
  /** Opens or focuses the shared-UI update window. */
  openUpdateCenterWindow?: () => void;
  /** Opens or focuses the shared-UI local-node window. */
  openNodeDiagnosticsWindow?: () => void;
  /** Reveals the main-process diagnostic log in the native file manager. */
  openLogs?: () => void;
  /** Injectable for deterministic menu tests; defaults to process.platform. */
  platform?: NodeJS.Platform;
}

/**
 * A total mapping intentionally makes additions to ShellCommand fail typecheck
 * until the native menu has made an explicit decision about the new command.
 */
export const SHELL_COMMAND_LABELS = {
  'navigate-home': 'Startseite',
  'navigate-practice': 'Üben',
  'navigate-questions': 'Aufgaben',
  'navigate-history': 'Verlauf',
  'navigate-progress': 'Fortschritt',
  'open-settings': 'Einstellungen…',
  'open-update-center': 'Update-Center…',
  'go-back': 'Zurück',
  'go-forward': 'Vorwärts',
} satisfies Record<ShellCommand, string>;

function acceleratorFor(command: ShellCommand, platform: NodeJS.Platform): string | undefined {
  switch (command) {
    case 'navigate-home':
      return 'CmdOrCtrl+1';
    case 'navigate-practice':
      return 'CmdOrCtrl+2';
    case 'navigate-questions':
      return 'CmdOrCtrl+3';
    case 'navigate-progress':
      return 'CmdOrCtrl+4';
    case 'navigate-history':
      return 'CmdOrCtrl+5';
    case 'open-settings':
      return 'CmdOrCtrl+,';
    case 'go-back':
      return platform === 'darwin' ? 'Cmd+[' : 'Alt+Left';
    case 'go-forward':
      return platform === 'darwin' ? 'Cmd+]' : 'Alt+Right';
    case 'open-update-center':
      return undefined;
  }
}

function commandItem(
  command: ShellCommand,
  options: ApplicationMenuOptions,
  platform: NodeJS.Platform,
): MenuItemConstructorOptions {
  const accelerator = acceleratorFor(command, platform);
  return {
    label: SHELL_COMMAND_LABELS[command],
    ...(accelerator ? { accelerator } : {}),
    click: (_item, window) => {
      options.dispatch(command, window instanceof BrowserWindow ? window : undefined);
    },
  };
}

function nativeActionItem(
  label: string,
  action: (() => void) | undefined,
  accelerator?: string,
): MenuItemConstructorOptions {
  return {
    label,
    enabled: typeof action === 'function',
    ...(accelerator ? { accelerator } : {}),
    click: () => action?.(),
  };
}

function appMenu(
  options: ApplicationMenuOptions,
  platform: NodeJS.Platform,
): MenuItemConstructorOptions {
  return {
    label: options.appName,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      commandItem('open-settings', options, platform),
      nativeActionItem('Update-Center', options.openUpdateCenterWindow),
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  };
}

function fileMenu(
  options: ApplicationMenuOptions,
  platform: NodeJS.Platform,
): MenuItemConstructorOptions {
  const submenu: MenuItemConstructorOptions[] = [];
  if (platform !== 'darwin') {
    submenu.push(
      commandItem('open-settings', options, platform),
      nativeActionItem('Update-Center', options.openUpdateCenterWindow),
      { type: 'separator' },
    );
  }
  submenu.push(platform === 'darwin' ? { role: 'close' } : { role: 'quit' });
  return { label: 'Datei', submenu };
}

function editMenu(): MenuItemConstructorOptions {
  return {
    label: 'Bearbeiten',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'pasteAndMatchStyle' },
      { role: 'delete' },
      { role: 'selectAll' },
    ],
  };
}

function navigationMenu(
  options: ApplicationMenuOptions,
  platform: NodeJS.Platform,
): MenuItemConstructorOptions {
  return {
    label: 'Navigation',
    submenu: [
      commandItem('go-back', options, platform),
      commandItem('go-forward', options, platform),
      { type: 'separator' },
      commandItem('navigate-home', options, platform),
      commandItem('navigate-practice', options, platform),
      commandItem('navigate-questions', options, platform),
      commandItem('navigate-progress', options, platform),
      commandItem('navigate-history', options, platform),
    ],
  };
}

function viewMenu(): MenuItemConstructorOptions {
  return {
    label: 'Darstellung',
    submenu: [
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };
}

function windowMenu(
  options: ApplicationMenuOptions,
  platform: NodeJS.Platform,
): MenuItemConstructorOptions {
  const practiceWindow = nativeActionItem(
    'Üben in eigenem Fenster',
    options.openPracticeWindow,
    'CmdOrCtrl+Shift+2',
  );
  const updateWindow = nativeActionItem('Update-Center', options.openUpdateCenterWindow);
  const nodeWindow = nativeActionItem('Knotendiagnose', options.openNodeDiagnosticsWindow);
  return {
    label: 'Fenster',
    role: 'windowMenu',
    submenu: platform === 'darwin'
      ? [
          practiceWindow,
          updateWindow,
          nodeWindow,
          { type: 'separator' },
          { role: 'minimize' },
          { role: 'zoom' },
          { type: 'separator' },
          { role: 'front' },
        ]
      : [
          practiceWindow,
          updateWindow,
          nodeWindow,
          { type: 'separator' },
          { role: 'minimize' },
          { role: 'close' },
        ],
  };
}

function helpMenu(options: ApplicationMenuOptions): MenuItemConstructorOptions {
  return {
    label: 'Hilfe',
    role: 'help',
    submenu: [
      nativeActionItem('Diagnoseprotokoll anzeigen', options.openLogs),
      { type: 'separator' },
      {
        label: `Über ${options.appName}`,
        role: 'about',
        visible: (options.platform ?? process.platform) !== 'darwin',
      },
    ],
  };
}

export function buildApplicationMenuTemplate(
  options: ApplicationMenuOptions,
): MenuItemConstructorOptions[] {
  const platform = options.platform ?? process.platform;
  return [
    ...(platform === 'darwin' ? [appMenu(options, platform)] : []),
    fileMenu(options, platform),
    editMenu(),
    navigationMenu(options, platform),
    viewMenu(),
    windowMenu(options, platform),
    helpMenu(options),
  ];
}

export function installApplicationMenu(options: ApplicationMenuOptions): Menu {
  const menu = Menu.buildFromTemplate(buildApplicationMenuTemplate(options));
  Menu.setApplicationMenu(menu);
  return menu;
}
