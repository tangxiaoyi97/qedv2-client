import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { LeaderboardProfile } from '@qed2/core-logic';
import { useAppStore } from './app.js';
import { useAuthStore } from './auth.js';

export const useLeaderboardStore = defineStore('leaderboard', () => {
  const profile = ref<LeaderboardProfile | undefined>();
  const loadingProfile = ref(false);

  async function refreshProfile(): Promise<LeaderboardProfile | undefined> {
    const auth = useAuthStore();
    if (!auth.isLoggedIn) {
      profile.value = undefined;
      return undefined;
    }
    loadingProfile.value = true;
    try {
      profile.value = await useAppStore().serverClient.getLeaderboardProfile();
      return profile.value;
    } finally {
      loadingProfile.value = false;
    }
  }

  async function saveNickname(nickname: string): Promise<void> {
    profile.value = await useAppStore().serverClient.saveLeaderboardProfile(nickname);
  }

  async function leave(): Promise<void> {
    await useAppStore().serverClient.leaveLeaderboard();
    const auth = useAuthStore();
    profile.value = {
      participating: false,
      suggestedNickname: auth.username ?? '',
    };
  }

  function clear(): void {
    profile.value = undefined;
  }

  return { profile, loadingProfile, refreshProfile, saveNickname, leave, clear };
});
