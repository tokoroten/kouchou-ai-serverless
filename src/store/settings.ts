import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  DEFAULT_SETTINGS,
  type PresetId,
  type ProviderConfig,
  type Settings,
  type SlotSelection,
} from "../types/settings";

// 設定は localStorage に保存する(DESIGN §4.1)。
// API キーは「このブラウザにのみ保存され、選択した API 以外に送信されない」旨を UI に明記する。

type SettingsStore = {
  settings: Settings;
  setProvider: (id: PresetId, config: Partial<ProviderConfig>) => void;
  removeProvider: (id: PresetId) => void;
  setChatSlot: (slot: Partial<SlotSelection>) => void;
  setEmbeddingSlot: (slot: Partial<SlotSelection>) => void;
  setConcurrency: (n: number) => void;
  clearAll: () => void;
};

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      settings: DEFAULT_SETTINGS,
      setProvider: (id, config) =>
        set((state) => ({
          settings: {
            ...state.settings,
            providers: {
              ...state.settings.providers,
              [id]: { baseUrl: "", apiKey: "", ...state.settings.providers[id], ...config },
            },
          },
        })),
      removeProvider: (id) =>
        set((state) => {
          const providers = { ...state.settings.providers };
          delete providers[id];
          const clearSlot = (slot: SlotSelection): SlotSelection =>
            slot.provider === id ? { provider: null, model: "" } : slot;
          return {
            settings: {
              ...state.settings,
              providers,
              chatSlot: clearSlot(state.settings.chatSlot),
              embeddingSlot: clearSlot(state.settings.embeddingSlot),
            },
          };
        }),
      setChatSlot: (slot) =>
        set((state) => ({ settings: { ...state.settings, chatSlot: { ...state.settings.chatSlot, ...slot } } })),
      setEmbeddingSlot: (slot) =>
        set((state) => ({
          settings: { ...state.settings, embeddingSlot: { ...state.settings.embeddingSlot, ...slot } },
        })),
      setConcurrency: (n) => set((state) => ({ settings: { ...state.settings, concurrency: n } })),
      clearAll: () => set({ settings: DEFAULT_SETTINGS }),
    }),
    {
      name: "kouchou-ai-settings",
      version: 2,
      migrate: () => ({ settings: DEFAULT_SETTINGS }),
    },
  ),
);
