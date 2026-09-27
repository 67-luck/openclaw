import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enLobsterdex = {
  quickSettings: {
    appearance: {
      lobsterdexColoringTitle: "Coloring sheets",
      lobsterdexColoringDescription:
        "Print a lobster of your own. Includes every lobster, even those you haven’t met. PDFs are created on this device.",
      lobsterdexColoringAll: "Download all coloring sheets (ZIP)",
      lobsterdexColoringDownload: "Coloring PDF",
      lobsterdexColoringDownloadLabel: "Download coloring sheet for {name} (PDF)",
      lobsterdexColoringProgress: "Preparing coloring sheets… {completed}/{total}",
      lobsterdexColoringDownloaded: "Download started. Check your browser’s downloads.",
      lobsterdexColoringError:
        "Couldn’t create the coloring sheets. Try again, or reload this page if the problem continues.",
    },
  },
} satisfies TranslationMap;

export const registerLobsterdexEnglish = Object.assign(
  () => {
    Object.assign(en.quickSettings.appearance, enLobsterdex.quickSettings.appearance);
  },
  { catalog: enLobsterdex },
);
