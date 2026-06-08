import { create } from 'zustand';
import { setMasterVolume } from '../lib/sfx';

type Settings = {
  volume: number;            // 0..1, applied to the SFX master gain
  showOpponentNames: boolean;
  showOpponentAvatars: boolean;
  chatEnabled: boolean;
  inGameEmojisEnabled: boolean;
  animationsEnabled: boolean;
};

const STORAGE_KEY = 'vcc.settings.v1';

const DEFAULTS: Settings = {
  volume: 0.8,
  showOpponentNames: true,
  showOpponentAvatars: true,
  chatEnabled: true,
  inGameEmojisEnabled: true,
  animationsEnabled: true,
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return DEFAULTS;
  }
}

function save(s: Settings) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {}
}

type SettingsStore = Settings & {
  setVolume: (v: number) => void;
  setShowOpponentNames: (v: boolean) => void;
  setShowOpponentAvatars: (v: boolean) => void;
  setChatEnabled: (v: boolean) => void;
  setInGameEmojisEnabled: (v: boolean) => void;
  setAnimationsEnabled: (v: boolean) => void;
};

export const useSettingsStore = create<SettingsStore>((set, get) => {
  const initial = load();
  // Apply the persisted volume to the audio bus on first load.
  setMasterVolume(initial.volume);
  return {
    ...initial,
    setVolume(v) {
      const next = Math.max(0, Math.min(1, v));
      setMasterVolume(next);
      const s = { ...get(), volume: next };
      save(s);
      set({ volume: next });
    },
    setShowOpponentNames(v) {
      save({ ...get(), showOpponentNames: v });
      set({ showOpponentNames: v });
    },
    setShowOpponentAvatars(v) {
      save({ ...get(), showOpponentAvatars: v });
      set({ showOpponentAvatars: v });
    },
    setChatEnabled(v) {
      save({ ...get(), chatEnabled: v });
      set({ chatEnabled: v });
    },
    setInGameEmojisEnabled(v) {
      save({ ...get(), inGameEmojisEnabled: v });
      set({ inGameEmojisEnabled: v });
    },
    setAnimationsEnabled(v) {
      save({ ...get(), animationsEnabled: v });
      set({ animationsEnabled: v });
    },
  };
});
