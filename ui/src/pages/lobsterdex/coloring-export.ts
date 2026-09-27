import { jsPDF } from "jspdf";
import { svg2pdf } from "svg2pdf.js";
import type {
  LobsterPetPalette,
  LobsterPetPaletteId,
} from "../../components/lobster-pet-contract.ts";
import { lobsterPaletteName } from "../../components/lobster-pet-lore.ts";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import { createColoringArt, type ColoringMode } from "./coloring-art.ts";

function coloringSheetFilename(palette: LobsterPetPalette, mode: ColoringMode): string {
  const name = lobsterPaletteName(palette.id)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-");
  return (
    "lobsterdex-" + palette.id + "-" + name + (mode === "color" ? "-color-guide" : "") + ".pdf"
  );
}

async function createColoringPdf(
  palette: LobsterPetPalette,
  mode: ColoringMode,
): Promise<ArrayBuffer> {
  const art = createColoringArt(palette, mode);
  try {
    const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
    const name = lobsterPaletteName(palette.id);
    pdf.setProperties({ title: name + " - Lobsterdex", creator: "OpenClaw" });
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(24);
    pdf.text(name, 105, 30, { align: "center" });
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(10);
    pdf.text("OpenClaw / Lobsterdex", 105, 40, { align: "center" });
    await svg2pdf(art.svg, pdf, {
      x: 20,
      y: 55,
      width: 170,
      height: 210,
      loadExternalStyleSheets: false,
      loadImages: false,
    });
    return pdf.output("arraybuffer");
  } finally {
    art.dispose();
  }
}

export async function createColoringDownload(
  target: LobsterPetPaletteId | "all",
  mode: ColoringMode,
  signal: AbortSignal,
  onProgress: (completed: number, total: number) => void,
): Promise<{ filename: string; blob: Blob }> {
  signal.throwIfAborted();
  if (target !== "all") {
    const palette = LOBSTER_PET_PALETTES.find((entry) => entry.id === target);
    if (!palette) {
      throw new Error("Unknown lobster palette");
    }
    const data = await createColoringPdf(palette, mode);
    signal.throwIfAborted();
    return {
      filename: coloringSheetFilename(palette, mode),
      blob: new Blob([data], { type: "application/pdf" }),
    };
  }
  const { zipSync } = await import("fflate");
  signal.throwIfAborted();
  const files: Record<string, Uint8Array> = {};
  // One PDF at a time bounds memory and lets the page paint progress between
  // sheets. The catalog, never discovery storage, owns the complete inventory.
  for (const [index, palette] of LOBSTER_PET_PALETTES.entries()) {
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
    signal.throwIfAborted();
    files[coloringSheetFilename(palette, mode)] = new Uint8Array(
      await createColoringPdf(palette, mode),
    );
    signal.throwIfAborted();
    onProgress(index + 1, LOBSTER_PET_PALETTES.length);
  }
  // PDFs are already compressed; storing this small archive avoids both
  // redundant compression work and worker/blob-script CSP requirements.
  const blob = new Blob([zipSync(files, { level: 0 })], { type: "application/zip" });
  signal.throwIfAborted();
  return {
    filename: mode === "color" ? "lobsterdex-color-guides.zip" : "lobsterdex-coloring-sheets.zip",
    blob,
  };
}
