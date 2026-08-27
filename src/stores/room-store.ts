"use client";

import { create } from "zustand";

type RoomControlsState = {
  muted: boolean;
  deafened: boolean;
  toggleMute: () => void;
  toggleDeafen: () => void;
  resetControls: () => void;
};

// Only local device controls belong in client state. Shared room and match data
// always comes from Supabase, so a refresh cannot create a different game state.
export const useRoomControlsStore = create<RoomControlsState>((set) => ({
  muted: false,
  deafened: false,
  toggleMute: () => set((state) => ({ muted: !state.muted })),
  toggleDeafen: () => set((state) => ({ deafened: !state.deafened })),
  resetControls: () => set({ muted: false, deafened: false })
}));
