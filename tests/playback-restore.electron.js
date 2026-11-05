/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

if (!process.versions.electron) {
  const os = require('os');
  const { spawnSync } = require('child_process');
  const babel = require('@babel/core');
  const root = path.resolve(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(root, 'yesplaymusic-restore-'));
  const sources = {};
  for (const [name, file] of Object.entries({
    Player: 'src/utils/Player.js',
    AudioEngine: 'src/utils/AudioEngine.js',
    createProxy: 'src/utils/playerStateProxy.js',
    flushState: 'src/electron/playbackState.js',
  })) {
    sources[name] = babel.transformSync(
      fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'),
      {
        babelrc: false,
        configFile: false,
        plugins: ['@babel/plugin-transform-modules-commonjs'],
      }
    ).code;
  }
  sources.howler = require.resolve('howler');
  sources.mp3 = fs
    .readFileSync(path.join(__dirname, 'fixtures/gapless-tone.mp3'))
    .toString('base64');
  fs.writeFileSync(path.join(profile, 'sources.json'), JSON.stringify(sources));
  fs.writeFileSync(
    path.join(profile, 'index.html'),
    '<!doctype html><title>Playback restore test</title>'
  );
  let exitCode = 0;
  for (let phase = 0; phase < 4; phase++) {
    const result = spawnSync(
      require('electron'),
      [__filename, profile, String(phase)],
      {
        windowsHide: true,
        stdio: 'inherit',
        timeout: 20000,
      }
    );
    if (result.error || result.status !== 0) {
      console.error(result.error || `Restore phase ${phase} failed`);
      exitCode = 1;
      break;
    }
  }
  // Only remove the test-owned directory directly inside the system temp root.
  if (
    path.dirname(path.resolve(profile)) !== root ||
    !path.basename(profile).startsWith('yesplaymusic-restore-')
  )
    throw new Error('Unexpected test profile path');
  fs.rmSync(profile, { recursive: true, force: true });
  process.exitCode = exitCode;
} else {
  const { app, BrowserWindow } = require('electron');
  const profile = process.argv[2];
  const phase = Number(process.argv[3]);
  const sources = JSON.parse(
    fs.readFileSync(path.join(profile, 'sources.json'), 'utf8')
  );
  app.setPath('userData', path.join(profile, 'user-data'));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  const timeout = setTimeout(() => app.exit(1), 15000);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        backgroundThrottling: false,
      },
    });
    try {
      await win.loadFile(path.join(profile, 'index.html'));
      const result = await win.webContents.executeJavaScript(
        `(${verifyRestore.toString()})(${JSON.stringify(sources)}, ${phase})`
      );
      const module = { exports: {} };
      new Function('module', 'exports', sources.flushState)(
        module,
        module.exports
      );
      let saved = false;
      app.on('before-quit', event => {
        if (saved) return;
        event.preventDefault();
        module.exports
          .default(win)
          .then(() => {
            saved = true;
            clearTimeout(timeout);
            console.log(JSON.stringify({ phase, ...result }));
            app.quit();
          })
          .catch(error => {
            console.error(error);
            app.exit(1);
          });
      });
      app.quit();
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
}

async function verifyRestore(sources, phase) {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const waitFor = async condition => {
    for (let i = 0; i < 300; i++) {
      if (condition()) return;
      await delay(10);
    }
    throw new Error('Playback did not become ready');
  };
  const track = id => ({
    id,
    name: `Track ${id}`,
    dt: 1000,
    ar: [{ name: 'Test' }],
    al: { name: 'Test', picUrl: '' },
  });
  const load = (code, dependencies = {}) => {
    const module = { exports: {} };
    new Function('require', 'module', 'exports', 'process', code)(
      name => {
        if (!(name in dependencies))
          throw new Error(`Unexpected test import: ${name}`);
        return dependencies[name];
      },
      module,
      module.exports,
      { env: { IS_ELECTRON: false } }
    );
    return module.exports.default;
  };
  const store = {
    state: {
      settings: { gaplessPlayback: phase !== 3, playPauseFade: false },
      liked: { songs: [] },
      lastfm: {},
    },
    commit() {},
    dispatch() {},
  };
  const AudioEngine = load(sources.AudioEngine);
  const Player = load(sources.Player, {
    '@/api/album': {},
    '@/api/artist': {},
    '@/api/lastfm': {},
    '@/api/playlist': {},
    '@/api/others': {
      personalFM: async () => ({ data: [track(7), track(8)] }),
    },
    '@/api/track': {
      getTrackDetail: async id => ({ songs: [track(id)] }),
      scrobble: async () => {},
    },
    '@/store': store,
    '@/utils/auth': {},
    '@/utils/db': {},
    '@/utils/platform': { isCreateMpris: false, isCreateTray: false },
    howler: require(sources.howler),
    'lodash/shuffle': list => list.slice().reverse(),
    '@/utils/base64': {},
    '@/utils/AudioEngine': AudioEngine,
    axios: {},
  });
  const createProxy = load(sources.createProxy);
  const buffer = new OfflineAudioContext(2, 48000, 48000).createBuffer(
    2,
    48000,
    48000
  );
  Player.prototype._getAudioSourceMeta = async () => ({ buffer, url: 'test' });
  Player.prototype._getAudioSource = async () =>
    `data:audio/mpeg;base64,${sources.mp3}`;
  const p = createProxy(new Player());
  store.state.player = p;
  if (phase > 0) {
    await waitFor(
      () =>
        !p._loadingTrack && (p._engine.ready || p._howler?.state() === 'loaded')
    );
    const expectedID = phase === 2 ? 3 : 2;
    const expectedPosition = [0, 0.625, 0.375, 0.5][phase];
    assert(
      p.currentTrackID === expectedID,
      `Restart selected ${p.currentTrackID}, expected ${expectedID}`
    );
    assert(
      p.current === expectedID - 1,
      'Restart restored the wrong queue index'
    );
    assert(
      Math.abs(p.seek() - expectedPosition) < 1e-5,
      `Restart position ${p.seek()}, expected ${expectedPosition}`
    );
    assert(!p.playing, 'Restart unexpectedly autoplayed');
    console.log(
      `PASS real process restart: track ${expectedID}, position ${p.seek()}, ${
        p.audioMode
      }`
    );
  }
  if (phase === 1) {
    p.volume = 0;
    await p.play();
    assert(
      p._engine.current.source && p._engine.current.offset === 0.625,
      'Web Audio resumed from the wrong offset'
    );
    await delay(40);
    await p.pause();
    assert(
      p.seek() >= 0.625 && p.seek() < 0.9,
      'Restored Web Audio did not advance normally'
    );
  }
  if (phase === 0 || phase === 1) {
    p._list = [1, 2, 3];
    const id = phase === 0 ? 2 : 3;
    p.current = id - 1;
    await p._replaceCurrentTrack(id, false, null, {
      seek: phase === 0 ? 0.625 : 0.375,
    });
    p._enabled = true;
    // Make both the UI field and the old standalone key stale. Closing must
    // query the actual audio backend instead of saving either value.
    p._progress = 0.1;
    localStorage.setItem('playerCurrentTrackTime', '99');
  } else if (phase === 2) {
    store.state.settings.gaplessPlayback = false;
    p.current = 1;
    await p._replaceCurrentTrack(2, false, null, { seek: 0.5 });
    await waitFor(() => p._howler?.state() === 'loaded');
    assert(
      Math.abs(p.seek() - 0.5) < 1e-5,
      'Howler failed to queue the initial seek'
    );
  } else {
    p.volume = 0;
    p.play();
    await waitFor(() => p.playing);
    await delay(40);
    p.pause();
    assert(
      p.seek() >= 0.5 && p.seek() < 0.9,
      'Restored fallback did not play from the saved position'
    );
  }
  return {
    savedTrack: p.currentTrackID,
    savedPosition: p.seek(),
    backend: p.audioMode,
  };
}
