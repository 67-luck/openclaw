export function downloadTextFile(filename: string, content: string, type = "text/plain"): void {
  downloadBlobFile(filename, new Blob([content], { type }));
}

export function downloadBlobFile(filename: string, content: Blob): void {
  const url = URL.createObjectURL(content);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  try {
    link.click();
  } finally {
    // Let the browser consume the click before releasing the download payload,
    // including when dispatch fails and the caller offers a retry.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
