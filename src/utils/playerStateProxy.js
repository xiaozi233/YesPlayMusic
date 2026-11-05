/**
 * Keep disk writes off the playback control path. Runtime engine fields are
 * non-enumerable; changing them must not serialize the entire playlist.
 */
export default function createPlayerStateProxy(player) {
  let pending = false;
  const flush = () => {
    if (!pending) return;
    pending = false;
    player.saveSelfToLocalStorage();
    player.sendSelfToIpcMain();
  };
  // A raw timer or the audio clock can advance without touching this Proxy.
  // Always capture the live position on exit, even with no pending mutation.
  window.addEventListener('beforeunload', () => {
    pending = false;
    player.saveSelfToLocalStorage();
    player.sendSelfToIpcMain();
  });
  return new Proxy(player, {
    set(target, prop, value) {
      target[prop] = value;
      if (Object.getOwnPropertyDescriptor(target, prop)?.enumerable === false)
        return true;
      if (!pending) {
        pending = true;
        setTimeout(flush, 0);
      }
      return true;
    },
  });
}
