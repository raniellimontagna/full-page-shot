export async function copyToClipboard(blob: Blob): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}

export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob)
  try {
    await chrome.downloads.download({ url, filename, saveAs: false })
  } finally {
    // chrome.downloads.download() resolves once the download is queued, not
    // once Chrome has finished reading the blob. Revoking the object URL
    // immediately can abort an in-flight download, so we hold onto it for a
    // minute to give Chrome time to take ownership of the data.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}
