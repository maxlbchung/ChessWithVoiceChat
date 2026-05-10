import { create } from 'zustand';
import type { Identity } from '../lib/identity';
import { loadIdentity, createIdentity, updateHandle as persistHandle } from '../lib/identity';
import { loadRating, saveRating } from '../lib/storage';
import { loadAvatar, saveAvatar, clearAvatar } from '../lib/avatar';
import { STARTING_ELO } from '../lib/elo';

type IdentityStore = {
  identity: Identity | null;
  rating: number;
  avatar: string | null;
  loaded: boolean;
  load: () => Promise<void>;
  signUp: (handle: string) => Promise<void>;
  setHandle: (handle: string) => Promise<void>;
  setIdentity: (id: Identity) => void;
  setRating: (r: number) => Promise<void>;
  setAvatar: (dataUrl: string | null) => Promise<void>;
};

export const useIdentityStore = create<IdentityStore>((set, get) => ({
  identity: null,
  rating: STARTING_ELO,
  avatar: null,
  loaded: false,

  async load() {
    const [identity, rating, avatar] = await Promise.all([
      loadIdentity(),
      loadRating(),
      loadAvatar(),
    ]);
    set({ identity, rating, avatar, loaded: true });
  },

  async signUp(handle: string) {
    const identity = await createIdentity(handle.trim() || 'anon');
    set({ identity });
  },

  async setHandle(handle: string) {
    const cur = get().identity;
    if (!cur) return;
    const next = await persistHandle(cur, handle.trim());
    set({ identity: next });
  },

  setIdentity(id) {
    set({ identity: id });
  },

  async setRating(r: number) {
    await saveRating(r);
    set({ rating: r });
  },

  async setAvatar(dataUrl: string | null) {
    if (dataUrl) await saveAvatar(dataUrl);
    else await clearAvatar();
    set({ avatar: dataUrl });
  },
}));
