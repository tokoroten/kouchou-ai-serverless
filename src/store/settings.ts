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
      // 以前はバージョンを上げるたびに DEFAULT_SETTINGS で全上書きしていたため、
      // API キーもモデル選択も消えていた(ラベル生成が理由も分からず押せなくなる原因)。
      // 欠けているフィールドだけを既定値で補い、ユーザが入力した値は保持する。
      migrate: (persisted) => {
        const saved = (persisted as { settings?: Partial<Settings> } | undefined)?.settings;
        if (!saved) return { settings: DEFAULT_SETTINGS };
        // providers はプロバイダごとに中身を merge する。丸ごと差し替えると、
        // 保存当時にまだ無かったフィールドが欠けたまま残る。
        const providers = { ...DEFAULT_SETTINGS.providers } as Settings["providers"];
        for (const [id, config] of Object.entries(saved.providers ?? {})) {
          const key = id as keyof Settings["providers"];
          providers[key] = { ...DEFAULT_SETTINGS.providers[key], ...config };
        }
        return {
          settings: {
            ...DEFAULT_SETTINGS,
            ...saved,
            providers,
            chatSlot: { ...DEFAULT_SETTINGS.chatSlot, ...saved.chatSlot },
            embeddingSlot: { ...DEFAULT_SETTINGS.embeddingSlot, ...saved.embeddingSlot },
          },
        };
      },
    },
  ),
);
