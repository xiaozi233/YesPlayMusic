/** Capture the renderer's live playback state before destroying its window. */
export default async function flushPlaybackState(win) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  let timeout;
  try {
    await Promise.race([
      win.webContents.executeJavaScript(
        'window.yesplaymusic?.player?.saveSelfToLocalStorage()'
      ),
      new Promise((resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Saving playback state timed out')),
          1500
        );
      }),
    ]);
    win.webContents.session.flushStorageData();
  } finally {
    clearTimeout(timeout);
  }
}
