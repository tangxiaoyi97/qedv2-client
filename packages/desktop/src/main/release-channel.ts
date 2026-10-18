export type DesktopReleaseChannel = 'stable' | 'preview';

/** The channel is compiled into the app; a launch-time variable cannot change it. */
export function desktopReleaseIdentity(channel: DesktopReleaseChannel) {
  return channel === 'preview'
    ? {
      name: 'QED2 Preview',
      appId: 'studio.barcarolle.qed2.preview',
      sessionPartition: 'persist:qed2-preview-desktop-v2',
      selfUpdate: false,
    }
    : {
      name: 'QED2',
      appId: 'studio.barcarolle.qed2',
      sessionPartition: 'persist:qed2-desktop-v2',
      selfUpdate: true,
    };
}
