import { create } from "zustand";

export type CommandPaletteIntent = "search" | "create-file";

interface UIState {
  isCommandPaletteOpen: boolean;
  commandPaletteIntent: CommandPaletteIntent;
  commandPaletteSearch: string;

  /**
   * `extensionId:command` of the open extension panel, or `null`.
   *
   * One at a time on purpose: the panel shares the window with the editor, and
   * the point of an extension here is to work alongside a note rather than to
   * become a second workspace.
   */
  openExtensionPanel: string | null;

  openCommandPalette: (intent?: CommandPaletteIntent) => void;
  closeCommandPalette: () => void;
  setCommandPaletteSearch: (search: string) => void;
  setExtensionPanel: (panel: string | null) => void;
  toggleExtensionPanel: (panel: string) => void;
}

export const useUIStore = create<UIState>((set) => ({
  isCommandPaletteOpen: false,
  commandPaletteIntent: "search",
  commandPaletteSearch: "",
  openExtensionPanel: null,

  openCommandPalette: (intent = "search") =>
    set({ isCommandPaletteOpen: true, commandPaletteIntent: intent, commandPaletteSearch: "" }),
  closeCommandPalette: () =>
    set({
      isCommandPaletteOpen: false,
      commandPaletteIntent: "search",
      commandPaletteSearch: "",
    }),
  setCommandPaletteSearch: (search: string) => set({ commandPaletteSearch: search }),
  setExtensionPanel: (panel) => set({ openExtensionPanel: panel }),
  toggleExtensionPanel: (panel) =>
    set((state) => ({ openExtensionPanel: state.openExtensionPanel === panel ? null : panel })),
}));
