import { create } from 'zustand';
import type { Identity } from '../lib/identity';
import { loadIdentity, createIdentity, updateHandle as persistHandle } from '../lib/identity';
import { loadRating, saveRating } from '../lib/storage';
import { STARTING_ELO } from '../lib/elo';

type IdentityStore = {
  identity: Identity | null;
  rating: number;
  loaded: boolean;
  load: () => Promise<void>;
  signUp: (handle: string) => Promise<void>;
  setHandle: (handle: string) => Promise<void>;
  setIdentity: (id: Identity) => void;
  setRating: (r: number) => Promise<void>;
};

export const useIdentityStore = create<IdentityStore>((set, get) => ({
  identity: null,
  rating: STARTING_ELO,
  loaded: false,

  async load() {
    const [identity, rating] = await Promise.all([loadIdentity(), loadRating()]);
    set({ identity, rating, loaded: true });
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
}));
