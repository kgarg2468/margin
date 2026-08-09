/** A readable local filename that cannot introduce a path or control byte. */
export function exportFilename(title: string, extension: string): string {
  const base = title
    .normalize("NFC")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .slice(0, 160)
    .replace(/[.\s]+$/g, "");
  const suffix = extension.replace(/^\.+/, "");
  return `${base.length > 0 ? base : "export"}.${suffix}`;
}

/** Trigger a client-side text download without retaining the object URL. */
export function downloadText(
  contents: string,
  filename: string,
  mimeType: string,
): void {
  const url = URL.createObjectURL(new Blob([contents], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
