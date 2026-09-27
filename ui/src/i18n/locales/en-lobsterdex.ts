import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enLobsterdex = {
  quickSettings: {
    appearance: {
      lobsterdexColoringTitle: "Coloring sheets and guides",
      lobsterdexColoringDescription:
        "Print a lobster of your own. Includes every lobster, even those you haven’t met. PDFs are created on this device.",
      lobsterdexColoringAll: "Download all (ZIP)",
      lobsterdexColoringSheetPdf: "Coloring sheet (PDF)",
      lobsterdexColorGuidePdf: "Color guide (PDF)",
      lobsterdexColoringSheetsZip: "Coloring sheets (ZIP)",
      lobsterdexColorGuidesZip: "Color guides (ZIP)",
      lobsterdexColoringDownloadLabel: "Download PDFs for {name}",
      lobsterdexColoringProgress: "Preparing PDFs… {completed}/{total}",
      lobsterdexColoringDownloaded: "Download started. Check your browser’s downloads.",
      lobsterdexColoringError:
        "Couldn’t create the PDFs. Try again, or reload this page if the problem continues.",
    },
  },
} satisfies TranslationMap;

export const registerLobsterdexEnglish = Object.assign(
  () => {
    Object.assign(en.quickSettings.appearance, enLobsterdex.quickSettings.appearance);
  },
  { catalog: enLobsterdex },
);
