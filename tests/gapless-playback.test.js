/* eslint-disable no-console */
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const babel = require('@babel/core');

// Run the actual ES modules with controlled browser/network boundaries. No app
// startup, credentials, sound device or real-time sleeps are needed.
function loadModule(file, dependencies, globals) {
  const filename = path.resolve(__dirname, '..', file);
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    babelrc: false,
    configFile: false,
    plugins: ['@babel/plugin-transform-modules-commonjs'],
    filename,
  });
  const module = { exports: {} };
  vm.runInNewContext(
    code,
    {
      ...globals,
      module,
      exports: module.exports,
      require(name) {
        assert(name in dependencies, `Unexpected import: ${name}`);
        return dependencies[name];
      },
    },
    { filename }
  );
  return module.exports;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function track(id) {
  return {
    id,
    name: `Track ${id}`,
    dt: 100000,
    ar: [{ name: 'Artist' }],
    al: { name: 'Album', picUrl: 'https://example.invalid/cover' },
  };
}

function audioBuffer(duration = 100, channels = 2, sampleRate = 48000) {
  const length = Math.round(duration * sampleRate);
  const data = Array.from({ length: channels }, () => new Float32Array(length));
  return {
    duration,
    length,
    sampleRate,
    numberOfChannels: channels,
    getChannelData: channel => data[channel],
    copyToChannel: (samples, channel) => data[channel].set(samples),
  };
}

function environment() {
  const timeouts = [];
  const intervals = [];
  const storage = new Map();
  const listeners = new Set();
  const cacheWrites = [];
  const outputStreams = [];
  const sinks = [];
  const windowEvents = new Map();
  const requests = {
    detail: async id => ({ songs: [track(id)] }),
    fm: async () => ({ data: [track(3)] }),
    cache: async () => null,
    outputDevice: async () => {},
    sinkPlay: async () => {},
    download: async () => ({ data: new ArrayBuffer(8) }),
  };
  const store = {
    state: {
      settings: { gaplessPlayback: true },
      liked: { songs: [] },
      lastfm: {},
    },
    commit() {},
    dispatch() {},
  };
  class Context {
    constructor() {
      this.state = 'suspended';
      this.currentTime = 0;
      this.sources = [];
      this.destination = {};
    }
    createGain() {
      const connections = new Set();
      return {
        connections,
        connect(target) {
          connections.add(target);
        },
        disconnect(target) {
          if (target) connections.delete(target);
          else connections.clear();
        },
        gain: {
          value: 0,
          cancelScheduledValues() {},
          setValueAtTime(value) {
            this.value = value;
          },
          linearRampToValueAtTime(value) {
            this.value = value;
          },
        },
      };
    }
    createMediaStreamDestination() {
      const track = {
        stopped: false,
        stop() {
          this.stopped = true;
        },
      };
      const destination = { stream: { getTracks: () => [track] } };
      outputStreams.push(destination);
      return destination;
    }
    createBufferSource() {
      const source = {
        connect() {},
        disconnect() {},
        playbackRate: { value: 1 },
        start(when, offset = 0) {
          this.when = when;
          this.offset = offset;
        },
        stop() {
          this.stopped = true;
        },
      };
      this.sources.push(source);
      return source;
    }
    decodeAudioData(bytes, resolve) {
      resolve(this.decoded);
    }
    async resume() {
      this.state = 'running';
    }
    async suspend() {
      this.state = 'suspended';
    }
    async close() {
      this.state = 'closed';
    }
  }
  class Sink {
    constructor() {
      this.paused = true;
      this.srcObject = null;
      sinks.push(this);
    }
    setSinkId(id) {
      this.deviceId = id;
      return requests.outputDevice(id);
    }
    play() {
      this.paused = false;
      return requests.sinkPlay(this);
    }
    pause() {
      this.paused = true;
    }
  }
  class Howl {
    constructor(options) {
      this.options = options;
      this._sounds = [];
      this.events = {};
      this._volume = options.volume;
      this.position = 0;
      this.active = false;
    }
    on(event, callback) {
      this.events[event] = callback;
    }
    once(event, callback) {
      this.events[event] = callback;
    }
    emit(event, ...args) {
      const callback = this.events[event];
      delete this.events[event];
      callback?.(...args);
    }
    playing() {
      return this.active;
    }
    play() {
      this.active = true;
      Promise.resolve().then(() => this.emit('play'));
    }
    pause() {
      this.active = false;
    }
    stop() {
      this.active = false;
    }
    unload() {
      this.active = false;
      this.unloaded = true;
    }
    seek(value) {
      if (value !== undefined) this.position = value;
      return this.position;
    }
    volume(value) {
      if (value !== undefined) this._volume = value;
      return this._volume;
    }
    fade(from, to) {
      this._volume = to;
    }
  }
  const globals = {
    console: { log() {}, debug() {}, warn() {} },
    process: { env: { IS_ELECTRON: false } },
    window: {
      AudioContext: Context,
      addEventListener: (name, callback) => windowEvents.set(name, callback),
    },
    Audio: Sink,
    navigator: {},
    document: {
      addEventListener: (name, fn) => listeners.add(fn),
      removeEventListener: (name, fn) => listeners.delete(fn),
    },
    ArrayBuffer,
    AbortController,
    Uint8Array,
    setInterval(fn) {
      intervals.push(fn);
      return 1;
    },
    clearInterval() {},
    setTimeout(fn) {
      timeouts.push(fn);
    },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
  };
  const AudioEngine = loadModule(
    'src/utils/AudioEngine.js',
    {},
    globals
  ).default;
  const dependencies = {
    '@/api/album': {},
    '@/api/artist': {},
    '@/api/lastfm': {},
    '@/api/others': { personalFM: () => requests.fm() },
    '@/api/playlist': {},
    '@/api/track': {
      getTrackDetail: id => requests.detail(id),
      scrobble: async () => {},
    },
    '@/store': store,
    '@/utils/auth': {},
    '@/utils/db': {
      getTrackSource: id => requests.cache(id),
      cacheTrackSource: async (...args) => {
        cacheWrites.push(args);
      },
    },
    '@/utils/platform': { isCreateMpris: false, isCreateTray: false },
    howler: {
      Howl,
      Howler: {
        unload() {
          assert.fail(
            'Switching must not recreate the global Howler AudioContext'
          );
        },
      },
    },
    'lodash/shuffle': list => list.slice().reverse(),
    '@/utils/base64': {},
    '@/utils/AudioEngine': AudioEngine,
    axios: { get: (...args) => requests.download(...args) },
  };
  const Player = loadModule(
    'src/utils/Player.js',
    dependencies,
    globals
  ).default;
  class TestPlayer extends Player {
    _init() {}
  }
  async function player(id = 1) {
    const p = new TestPlayer();
    p._currentTrack = track(id);
    p._list = [1, 2, 3];
    p._current = id - 1;
    p._initAudioEngine();
    p._audioMode = 'web-audio';
    p._playRequested = true;
    p._setPlaying(true);
    p._getAudioSourceMeta = async () => ({
      buffer: audioBuffer(1),
      url: 'source',
    });
    await p._engine.loadAndPlay(p.currentTrack, { buffer: audioBuffer(1) });
    return p;
  }
  return {
    AudioEngine,
    Player,
    player,
    requests,
    store,
    storage,
    timeouts,
    intervals,
    listeners,
    cacheWrites,
    sinks,
    outputStreams,
    windowEvents,
    globals,
  };
}

const cases = [];
const test = (name, run) => cases.push({ name, run });

test('a restart restores the same song and exact position from one saved snapshot', async () => {
  const env = environment(),
    p = await env.player(2);
  p._enabled = true;
  p._engine.ctx.currentTime = p._engine.current.startAt + 0.625;
  p._progress = 0.1; // the UI's last one-second tick is deliberately stale
  p.saveSelfToLocalStorage();
  const snapshot = JSON.parse(env.storage.get('player'));
  assert.equal(snapshot._currentTrack.id, 2);
  assert.equal(snapshot._current, 1);
  assert.equal(snapshot._playbackState.trackID, 2);
  assert.equal(snapshot._playbackState.position, 0.625);
  env.storage.set('playerCurrentTrackTime', 99); // obsolete, unrelated old key
  const restored = new env.Player();
  restored._getAudioSourceMeta = async () => ({
    buffer: audioBuffer(1),
    url: 'restored',
  });
  await flush();
  assert.equal(restored.currentTrackID, 2);
  assert.equal(restored.current, 1);
  assert.equal(restored._engine.current.track.id, 2);
  assert.equal(restored._engine.position, 0.625);
  assert.equal(restored._engine.current.source, null);
  assert.equal(restored.playing, false);
  await restored.play();
  assert.equal(restored._engine.current.source.offset, 0.625);
});

test('progress ticks write a song-bound checkpoint and ignore unfinished startup loads', async () => {
  const env = environment(),
    p = await env.player();
  p._setIntervals();
  const tick = env.intervals[env.intervals.length - 1];
  p.saveSelfToLocalStorage();
  const fullSnapshot = env.storage.get('player');
  p._engine.ctx.currentTime = p._engine.current.startAt + 0.75;
  tick();
  assert.equal(
    env.storage.get('player'),
    fullSnapshot,
    'Progress must not serialize the playlist every second'
  );
  assert.equal(
    JSON.parse(env.storage.get('playerPlaybackState')).position,
    0.75
  );
  p._loadingTrack = true;
  p._engine.clearAllSources();
  tick();
  assert.equal(
    JSON.parse(env.storage.get('playerPlaybackState')).position,
    0.75
  );
});

test('a mismatched old progress checkpoint is never applied to a different song', async () => {
  const env = environment(),
    p = await env.player(2);
  p._engine.ctx.currentTime = p._engine.current.startAt + 0.25;
  p.saveSelfToLocalStorage();
  env.storage.set(
    'playerPlaybackState',
    JSON.stringify({ trackID: 1, position: 99 })
  );
  const restored = new env.Player();
  assert.equal(restored.currentTrackID, 2);
  assert.equal(restored._restorePosition, 0.25);
  assert.equal(restored.progress, 0.25);
});

test('exiting while the next song downloads saves the audible song with its own list index', async () => {
  for (const shuffle of [false, true]) {
    const env = environment(),
      p = await env.player(),
      download = deferred();
    if (shuffle) {
      p._shuffle = true;
      p._shuffledList = [3, 1, 2];
      p._shuffledCurrent = 1;
    }
    p._engine.ctx.currentTime = p._engine.current.startAt + 0.4;
    p._getAudioSourceMeta = () => download.promise;
    p.current = shuffle ? 2 : 1;
    const pending = p._replaceCurrentTrack(2);
    await flush();
    p.saveSelfToLocalStorage();
    const snapshot = JSON.parse(env.storage.get('player'));
    assert.equal(snapshot._currentTrack.id, 1);
    assert.equal(snapshot._playbackState.position, 0.4);
    assert.equal(
      shuffle ? snapshot._shuffledCurrent : snapshot._current,
      shuffle ? 1 : 0
    );
    download.resolve({ buffer: audioBuffer(1), url: 'selected' });
    await pending;
  }
});

test('a stale startup restore cannot seek or pause a newer selection', async () => {
  const env = environment(),
    p = await env.player(),
    old = deferred();
  p._restorePosition = 0.8;
  p._getAudioSourceMeta = t =>
    t.id === 1
      ? old.promise
      : Promise.resolve({ buffer: audioBuffer(1), url: 'new' });
  const restoring = p._restorePlayback();
  await flush();
  await p._replaceCurrentTrack(2);
  const source = p._engine.current.source;
  old.resolve({ buffer: audioBuffer(1), url: 'old' });
  assert.equal(await restoring, false);
  assert.equal(p.currentTrackID, 2);
  assert.equal(p._engine.current.source, source);
  assert.equal(source.offset, 0);
  assert.equal(p.playing, true);
});

test('a failed startup restore retains its song instead of silently skipping to the next', async () => {
  const env = environment(),
    p = await env.player(2);
  p._getAudioSourceMeta = async () => {
    throw new Error('offline');
  };
  p._getAudioSource = async () => null;
  assert.equal(await p._restorePlayback(), false);
  assert.equal(p.currentTrackID, 2);
  assert.equal(p.current, 1);
});

test('the fallback backend restores its position before play and preserves it across another save', async () => {
  const env = environment(),
    p = await env.player(2);
  env.store.state.settings.gaplessPlayback = false;
  p._getAudioSource = async () => 'fallback';
  p._restorePosition = 0.6;
  await p._restorePlayback();
  assert.equal(p._howler.seek(), 0.6);
  assert.equal(p.playing, false);
  p.saveSelfToLocalStorage();
  assert.equal(
    JSON.parse(env.storage.get('player'))._playbackState.position,
    0.6
  );
});

test('saving a fallback still loading metadata preserves its queued restore position', async () => {
  const env = environment(),
    p = await env.player(2);
  env.store.state.settings.gaplessPlayback = false;
  p._getAudioSource = async () => 'fallback';
  p._restorePosition = 0.6;
  await p._restorePlayback();
  p._howler.state = () => 'loading';
  p._howler.position = 0;
  p.saveSelfToLocalStorage();
  assert.equal(
    JSON.parse(env.storage.get('player'))._playbackState.position,
    0.6
  );
});

test('play retries the saved song and position after an offline startup failure', async () => {
  const env = environment(),
    p = await env.player(2);
  p._engine.clearAllSources();
  p._enabled = true;
  p._progress = 0.55;
  p._restorePosition = 0.55;
  p._getAudioSourceMeta = async () => {
    throw new Error('offline');
  };
  p._getAudioSource = async () => null;
  assert.equal(await p._restorePlayback(), false);
  p._getAudioSourceMeta = async () => ({
    buffer: audioBuffer(1),
    url: 'online',
  });
  assert.equal(await p.play(), true);
  assert.equal(p.currentTrackID, 2);
  assert.equal(p._engine.current.source.offset, 0.55);
  assert.equal(p.playing, true);
});

test('initial FM replenishment cannot replace the saved current FM track', async () => {
  const env = environment(),
    p = await env.player(2);
  p._isPersonalFM = true;
  p._personalFMTrack = track(2);
  p._personalFMNextTrack = track(2);
  p._engine.ctx.currentTime = p._engine.current.startAt + 0.5;
  p.saveSelfToLocalStorage();
  const restored = new env.Player();
  await flush();
  assert.equal(restored.currentTrackID, 2);
  assert.equal(restored.personalFMTrack.id, 2);
  assert.equal(restored._personalFMNextTrack.id, 3);
  assert.equal(restored._restorePosition, 0.5);
});

test('exit captures the live position even when the proxy has no pending writes', async () => {
  const env = environment(),
    raw = await env.player();
  const createProxy = loadModule(
    'src/utils/playerStateProxy.js',
    {},
    env.globals
  ).default;
  createProxy(raw);
  raw._engine.ctx.currentTime = raw._engine.current.startAt + 0.9;
  env.windowEvents.get('beforeunload')();
  assert.equal(
    JSON.parse(env.storage.get('player'))._playbackState.position,
    0.9
  );
});

test('saving at a natural boundary captures the promoted song and its own progress', async () => {
  const env = environment(),
    p = await env.player();
  await p._prefetchNextTrack();
  p._engine.ctx.currentTime = p._engine.upcoming.startAt + 0.125;
  p.saveSelfToLocalStorage();
  const snapshot = JSON.parse(env.storage.get('player'));
  assert.equal(snapshot._currentTrack.id, 2);
  assert.equal(snapshot._current, 1);
  assert.equal(snapshot._playbackState.trackID, 2);
  assert.equal(snapshot._playbackState.position, 0.125);
});

test('main-process quit waits for renderer saving before flushing storage', async () => {
  const saved = deferred(),
    events = [];
  const flushState = loadModule(
    'src/electron/playbackState.js',
    {},
    { setTimeout, clearTimeout }
  ).default;
  const win = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: script => {
        assert(script.includes('saveSelfToLocalStorage'));
        events.push('save');
        return saved.promise;
      },
      session: { flushStorageData: () => events.push('flush') },
    },
  };
  const closing = flushState(win);
  assert.deepEqual(events, ['save']);
  saved.resolve();
  await closing;
  assert.deepEqual(events, ['save', 'flush']);
});

test('default playback never creates a MediaStream consumer, including after long pauses', async () => {
  const env = environment(),
    p = await env.player();
  const engine = p._engine;
  engine.ctx.currentTime = engine.current.startAt + 0.3;
  await p.pause();
  engine.ctx.currentTime += 120;
  await p.play();
  assert.equal(env.sinks.length, 0);
  assert.equal(env.outputStreams.length, 0);
  assert.equal(engine.gain.connections.size, 1);
  assert(engine.gain.connections.has(engine.ctx.destination));
  assert(Math.abs(engine.current.source.offset - 0.3) < 1e-7);
});

test('custom output discards its live stream on pause and starts a fresh consumer on resume', async () => {
  const env = environment(),
    p = await env.player(),
    engine = p._engine;
  await engine.setOutputDevice('headphones');
  const sink = engine.sink,
    stream = engine.streamDestination.stream;
  assert.equal(sink.deviceId, 'headphones');
  assert.equal(engine.gain.connections.size, 1);
  assert(!engine.gain.connections.has(engine.ctx.destination));
  await p.pause();
  assert.equal(sink.paused, true);
  assert.equal(sink.srcObject, null);
  assert(stream.getTracks().every(track => track.stopped));
  assert.equal(engine.sink, null);
  engine.ctx.currentTime += 120;
  await p.play();
  assert.notEqual(engine.sink, sink);
  assert.equal(engine.sink.deviceId, 'headphones');
  assert.equal(engine.sink.playbackRate, 1);
  assert.equal(engine.gain.connections.size, 1);
  const resumedStream = engine.streamDestination.stream;
  await engine.setOutputDevice('default');
  assert.equal(engine.sink, null);
  assert(resumedStream.getTracks().every(track => track.stopped));
  assert(engine.gain.connections.has(engine.ctx.destination));
});

test('a delayed device change cannot reconnect an output released during pause', async () => {
  const env = environment(),
    p = await env.player(),
    pending = deferred(),
    engine = p._engine;
  env.requests.outputDevice = () => pending.promise;
  const changing = engine.setOutputDevice('old-device');
  const oldSink = engine.sink;
  await p.pause();
  env.requests.outputDevice = async () => {};
  await engine.setOutputDevice('new-device');
  assert.equal(engine.sink, null);
  await p.play();
  const currentSink = engine.sink;
  pending.resolve();
  await changing;
  assert.equal(engine.sink, currentSink);
  assert.equal(currentSink.deviceId, 'new-device');
  assert.equal(oldSink.srcObject, null);
  assert.equal(engine.gain.connections.size, 1);
});

test('failed custom output leaves exactly one working direct connection', async () => {
  const env = environment(),
    p = await env.player();
  env.requests.outputDevice = async () => {
    throw new Error('unplugged');
  };
  await p._engine.setOutputDevice('missing-device');
  assert.equal(p._engine.sink, null);
  assert.equal(p._engine.gain.connections.size, 1);
  assert(p._engine.gain.connections.has(p._engine.ctx.destination));
  assert(env.outputStreams.every(item => item.stream.getTracks()[0].stopped));
});

test('manual switching coalesces playlist persistence and schedules audio before saving', async () => {
  const metrics = [];
  for (const legacy of [true, false]) {
    const env = environment(),
      raw = await env.player();
    raw._list = Array.from({ length: 10000 }, (_, i) => i + 1);
    await raw._prefetchNextTrack();
    let writes = 0,
      sends = 0,
      writesBeforeAudio;
    const save = raw.saveSelfToLocalStorage.bind(raw);
    raw.saveSelfToLocalStorage = () => {
      writes++;
      save();
    };
    raw.sendSelfToIpcMain = () => {
      sends++;
    };
    const start = raw._engine._startSource.bind(raw._engine);
    raw._engine._startSource = (...args) => {
      if (args[0].track.id === 2) writesBeforeAudio = writes;
      start(...args);
    };
    const createProxy = loadModule(
      'src/utils/playerStateProxy.js',
      {},
      env.globals
    ).default;
    const p = legacy
      ? new Proxy(raw, {
          set(target, prop, value) {
            target[prop] = value;
            if (prop !== '_howler' && prop !== '_engine') {
              target.saveSelfToLocalStorage();
              target.sendSelfToIpcMain();
            }
            return true;
          },
        })
      : createProxy(raw);
    let loading;
    const replace = raw._replaceCurrentTrack;
    raw._replaceCurrentTrack = function (...args) {
      return (loading = replace.apply(this, args));
    };
    const began = performance.now();
    p.playNextTrack();
    await loading;
    await flush();
    const audioReadyMs = performance.now() - began;
    if (!legacy) {
      assert.equal(writesBeforeAudio, 0);
      assert.equal(writes, 0);
      assert.equal(env.timeouts.length, 1);
    }
    env.timeouts.splice(0).forEach(fn => fn());
    if (!legacy) {
      assert.equal(writes, 1);
      assert.equal(sends, 1);
      p._loadGen++;
      await flush();
      assert.equal(
        env.timeouts.length,
        0,
        'Runtime fields must not persist the playlist'
      );
      p.volume = 0.4;
      env.windowEvents.get('beforeunload')();
      assert.equal(writes, 2, 'Shutdown must flush the final state');
    } else assert(writesBeforeAudio > 5);
    metrics.push({
      implementation: legacy ? 'previous' : 'batched',
      writesBeforeAudio,
      audioReadyMs,
    });
  }
  console.log(
    '10,000-track manual switch (mocked download/decoder):',
    JSON.stringify(metrics)
  );
});

test('returning to a recent song reuses its decoded buffer and changing quality invalidates reuse', async () => {
  const env = environment(),
    p = await env.player();
  let downloads = 0;
  p._getAudioSourceMeta = async t => {
    if (t.id === 1) downloads++;
    return { buffer: audioBuffer(1), url: 'source' };
  };
  await p._replaceCurrentTrack(1);
  await flush();
  let loading;
  const replace = p._replaceCurrentTrack.bind(p);
  p._replaceCurrentTrack = (...args) => (loading = replace(...args));
  p.playNextTrack();
  await loading;
  p.playPrevTrack();
  await loading;
  assert.equal(p.currentTrackID, 1);
  assert.equal(downloads, 1);
  env.store.state.settings.musicQuality = 'flac';
  await p._replaceCurrentTrack(1);
  assert.equal(downloads, 2);
});

test('rapid selection aborts an obsolete audio download before the new song starts', async () => {
  const env = environment(),
    p = await env.player(),
    downloads = new Map();
  p._list = [8, 9];
  p._current = 1;
  p._engine.ctx.decoded = audioBuffer(1);
  p._getAudioSourceMeta = async (t, options) => ({
    buffer: await p._downloadAudioBuffer(String(t.id), options),
    url: String(t.id),
  });
  env.requests.download = (url, { signal }) => {
    const pending = deferred();
    downloads.set(url, { ...pending, signal });
    signal.addEventListener('abort', () =>
      pending.reject(new Error('cancelled'))
    );
    return pending.promise;
  };
  const old = p._replaceCurrentTrack(8);
  await flush();
  const selected = p._replaceCurrentTrack(9);
  await flush();
  assert.equal(downloads.get('8').signal.aborted, true);
  assert.equal(downloads.get('9').signal.aborted, false);
  downloads.get('9').resolve({ data: new ArrayBuffer(8) });
  assert.equal(await selected, true);
  assert.equal(await old, false);
  assert.equal(p._engine.current.track.id, 9);
  assert.equal(p._engine.playing, true);
});

test('decoded reuse is bounded by memory and oversized tracks are not retained', async () => {
  const env = environment(),
    p = await env.player();
  const downloads = new Map();
  p._getAudioSourceMeta = async t => {
    downloads.set(t.id, (downloads.get(t.id) || 0) + 1);
    const buffer = audioBuffer(0.01);
    // Model large decoded buffers without allocating hundreds of MB in a VM test.
    buffer.length = (t.id === 99 ? 32 : 8) * 1024 * 1024;
    return { buffer, url: 'source' };
  };
  for (const id of [10, 11, 12, 11, 10, 99, 99]) await p._prepareTrack(id);
  assert.equal(downloads.get(11), 1, 'Recently used buffer was not reused');
  assert.equal(
    downloads.get(10),
    2,
    'Old buffer was not evicted at the memory limit'
  );
  assert.equal(downloads.get(99), 2, 'Oversized buffer remained in the cache');
});

test('track detail misses share one HTTP request and cached background failures are handled', async () => {
  for (const cacheHit of [false, true]) {
    const env = environment();
    let requests = 0;
    const cached = { songs: [track(1)], privileges: [{ id: 1 }] };
    const api = loadModule(
      'src/api/track.js',
      {
        '@/store': env.store,
        '@/utils/request': async () => {
          requests++;
          if (cacheHit) throw new Error('offline');
          return cached;
        },
        '@/utils/common': { mapTrackPlayableStatus: songs => songs },
        '@/utils/db': {
          getTrackDetailFromCache: async () => (cacheHit ? cached : undefined),
          cacheTrackDetail() {},
        },
      },
      env.globals
    );
    assert.equal((await api.getTrackDetail(1)).songs[0].id, 1);
    await flush();
    assert.equal(requests, 1);
  }
});

test('track details use primary keys and preserve requested order and duplicate IDs', async () => {
  const env = environment();
  const keys = [];
  class Dexie {
    constructor() {
      this.trackDetail = {
        bulkGet: async ids => {
          keys.push(ids);
          return ids.map(id =>
            id === 9 ? undefined : { detail: track(id), privileges: { id } }
          );
        },
        filter() {
          assert.fail('Track lookup must not scan the entire table');
        },
      };
    }
    version() {
      return this;
    }
    stores() {
      return this;
    }
    upgrade() {
      return this;
    }
  }
  const db = loadModule(
    'src/utils/db.js',
    { axios: {}, dexie: Dexie, '@/store': env.store },
    env.globals
  );
  const result = await db.getTrackDetailFromCache(['3', '1', '3']);
  assert.deepEqual(
    Array.from(result.songs, song => song.id),
    [3, 1, 3]
  );
  assert.deepEqual(Array.from(keys[0]), [3, 1, 3]);
  assert.equal(await db.getTrackDetailFromCache(['9']), undefined);
});

test('restored mute and low volume are applied before first engine playback', async () => {
  for (const volume of [0, 0.15]) {
    const env = environment();
    env.storage.set(
      'player',
      JSON.stringify({ _volume: volume, _enabled: false })
    );
    const p = new env.Player();
    assert.equal(p.volume, volume);
    assert.equal(p._engine.volume, volume);
    await p._engine.loadAndPlay(track(1), { buffer: audioBuffer(1) });
    assert.equal(p._engine.gain.gain.value, volume);
  }
});

test('repeat mode and shuffle changes schedule their new successor immediately', async () => {
  const env = environment(),
    p = await env.player();
  await p._prefetchNextTrack();
  const cancelled = p._engine.upcoming.source;
  p.repeatMode = 'one';
  await flush();
  assert.equal(cancelled.stopped, true);
  assert.equal(p._engine.upcoming.track.id, 1);
  assert.equal(p._engine.upcoming.buffer, p._engine.currentBuffer);
  p.repeatMode = 'off';
  p.shuffle = true;
  await flush();
  assert.equal(p._engine.upcoming.track.id, 3);
  p.shuffle = false;
  await flush();
  assert.equal(p._engine.upcoming.track.id, 2);
});

test('reversing playback replaces C with A while B keeps playing', async () => {
  const env = environment(),
    p = await env.player(2);
  await p._prefetchNextTrack();
  const cancelled = p._engine.upcoming.source;
  p.reversed = true;
  await flush();
  assert.equal(cancelled.stopped, true);
  assert.equal(p._engine.current.track.id, 2);
  assert.equal(p._engine.upcoming.track.id, 1);
});

test('adding, removing and clearing play-next entries always refill the schedule', async () => {
  const env = environment(),
    p = await env.player();
  await p._prefetchNextTrack();
  p.addTrackToPlayNext(8);
  p.addTrackToPlayNext(9);
  await flush();
  assert.equal(p._engine.upcoming.track.id, 8);
  p.removeTrackFromQueue(0);
  await flush();
  assert.equal(p._engine.upcoming.track.id, 9);
  p.clearPlayNextList();
  await flush();
  assert.equal(p._engine.upcoming.track.id, 2);
});

test('outdated prefetch cannot overwrite the replacement schedule', async () => {
  const env = environment(),
    p = await env.player(),
    old = deferred();
  p._getAudioSourceMeta = t =>
    t.id === 2
      ? old.promise
      : Promise.resolve({ buffer: audioBuffer(1), url: 'new' });
  const pending = p._prefetchNextTrack();
  await flush();
  p.addTrackToPlayNext(8);
  await flush();
  old.resolve({ buffer: audioBuffer(1), url: 'old' });
  await pending;
  assert.equal(p._engine.upcoming.track.id, 8);
});

test('FM keeps scheduling across multiple natural boundaries', async () => {
  const env = environment(),
    p = await env.player();
  p._isPersonalFM = true;
  p._personalFMTrack = track(1);
  p._personalFMNextTrack = track(2);
  let next = 3;
  env.requests.fm = async () => ({ data: [track(next++)] });
  await p._prefetchNextTrack();
  for (const id of [2, 3, 4]) {
    p._engine.ctx.currentTime = p._engine.upcoming.startAt;
    p._engine._onTick();
    await flush();
    assert.equal(p.currentTrackID, id);
    assert.equal(p._engine.upcoming.track.id, id + 1);
    assert.equal(p._personalFMNextLoading, false);
  }
});

test('disabling gapless switches control, position and volume to Howler', async () => {
  const env = environment(),
    p = await env.player();
  env.store.state.settings.gaplessPlayback = false;
  p._getAudioSource = async () => 'fallback';
  p.volume = 0.25;
  assert.equal(
    await p._replaceCurrentTrackAudio(p.currentTrack, true, false),
    true
  );
  await flush();
  assert.equal(p.audioMode, 'howler');
  assert.equal(p._engine.current, null);
  p.seek(42);
  assert.equal(p.seek(), 42);
  assert.equal(p._howler.volume(), 0.25);
  p.pause();
  p._howler.emit('fade');
  assert.equal(p._howler.playing(), false);
  p.play();
  await flush();
  assert.equal(p._howler.playing(), true);
});

test('current decode failure falls back and the next track can use Web Audio again', async () => {
  const env = environment(),
    p = await env.player();
  const prepare = p._engine.prepare.bind(p._engine);
  p._engine.prepare = async () => {
    throw new Error('decode');
  };
  p._getAudioSource = async () => 'fallback';
  assert.equal(
    await p._replaceCurrentTrackAudio(p.currentTrack, true, false),
    true
  );
  assert.equal(p.audioMode, 'howler');
  const previousHowl = p._howler;
  p._engine.prepare = prepare;
  assert.equal(await p._replaceCurrentTrack(2), true);
  assert.equal(p.audioMode, 'web-audio');
  assert.equal(p._howler, null);
  assert.equal(previousHowl.unloaded, true);
});

test('a browser without AudioContext falls back to Howler', async () => {
  const env = environment(),
    p = await env.player();
  p._engine.dispose();
  env.globals.window.AudioContext = undefined;
  p._initAudioEngine();
  p._getAudioSource = async () => 'web-fallback';
  assert.equal(
    await p._replaceCurrentTrackAudio(p.currentTrack, true, false),
    true
  );
  assert.equal(p.audioMode, 'howler');
  assert.equal(p._howler.playing(), true);
});

test('the cache writer reuses supplied audio bytes without another audio request', async () => {
  const env = environment(),
    writes = [],
    urls = [];
  env.globals.process.env.IS_ELECTRON = true;
  env.store.state.settings.cacheLimit = false;
  class Dexie {
    constructor() {
      this.trackSources = {
        toArray: async () => [],
        put: async record => {
          writes.push(record);
        },
      };
    }
    version() {
      return this;
    }
    stores() {
      return this;
    }
    upgrade() {
      return this;
    }
  }
  const { cacheTrackSource } = loadModule(
    'src/utils/db.js',
    {
      axios: {
        get: async url => {
          urls.push(url);
          return { data: new ArrayBuffer(8) };
        },
      },
      dexie: Dexie,
      '@/store': env.store,
    },
    env.globals
  );
  const bytes = new ArrayBuffer(32);
  const result = await cacheTrackSource(
    track(1),
    'audio-url',
    320000,
    'netease',
    bytes
  );
  assert.equal(result.source, bytes);
  assert.equal(writes[0].source, bytes);
  assert.equal(writes[0].url, 'audio-url');
  assert.equal(urls.includes('audio-url'), false);
  await cacheTrackSource(track(2), 'audio-url', 320000);
  assert.equal(urls.filter(url => url === 'audio-url').length, 1);
});

test('obsolete audio success, failure and missing sources cannot disturb a newer load', async () => {
  for (const outcome of ['success', 'failure', 'missing']) {
    const env = environment(),
      p = await env.player(),
      old = deferred();
    p._getAudioSourceMeta = t =>
      t.id === 1
        ? old.promise
        : Promise.resolve({ buffer: audioBuffer(1), url: 'new' });
    const pending = p._replaceCurrentTrackAudio(track(1), true, false);
    assert.equal(await p._replaceCurrentTrack(2), true);
    const active = p._engine.current.source;
    if (outcome === 'failure') old.reject(new Error('old failure'));
    else
      old.resolve(
        outcome === 'missing' ? null : { buffer: audioBuffer(1), url: 'old' }
      );
    assert.equal(await pending, false);
    assert.equal(p.currentTrackID, 2);
    assert.equal(p._engine.current.source, active);
    assert.equal(active.stopped, undefined);
    assert.equal(p.audioMode, 'web-audio');
  }
});

test('track detail responses cannot reorder user requests, even for A-B-A', async () => {
  const env = environment(),
    p = await env.player(),
    first = deferred();
  let count = 0;
  env.requests.detail = id =>
    ++count === 1 ? first.promise : Promise.resolve({ songs: [track(id)] });
  const pending = p._replaceCurrentTrack(1);
  await p._replaceCurrentTrack(2);
  await p._replaceCurrentTrack(1);
  const active = p._engine.current.source;
  first.resolve({ songs: [track(1)] });
  assert.equal(await pending, false);
  assert.equal(p._engine.current.source, active);
});

test('obsolete Howler failures do not skip a newer track', async () => {
  const env = environment(),
    p = await env.player(),
    old = deferred();
  env.store.state.settings.gaplessPlayback = false;
  p._getAudioSource = t => (t.id === 1 ? old.promise : Promise.resolve('new'));
  const pending = p._replaceCurrentTrackAudio(track(1), true, false);
  await p._replaceCurrentTrack(2);
  old.resolve(null);
  assert.equal(await pending, false);
  assert.equal(p.currentTrackID, 2);
  assert.equal(p.audioMode, 'howler');
});

test('the old track ending during a new download cannot skip the selected track', async () => {
  const env = environment(),
    p = await env.player(),
    download = deferred();
  p._getAudioSourceMeta = () => download.promise;
  const loading = p._replaceCurrentTrack(3);
  await flush();
  p._engine.ctx.currentTime = p._engine.cursor;
  p._engine._onTick();
  download.resolve({ buffer: audioBuffer(1), url: 'selected' });
  assert.equal(await loading, true);
  assert.equal(p.currentTrackID, 3);
  assert.equal(p._engine.current.track.id, 3);
});

test('caching receives the already downloaded bytes and a cache hit avoids downloading', async () => {
  const env = environment(),
    p = await env.player();
  const bytes = new ArrayBuffer(16);
  p._getAudioSourceMeta = env.Player.prototype._getAudioSourceMeta;
  p._getNeteaseAudioURL = async () => ({
    url: 'audio-url',
    bitRate: 320000,
    from: 'netease',
  });
  let downloads = 0;
  p._downloadAudioBuffer = async () => {
    downloads++;
    return bytes;
  };
  env.store.state.settings.automaticallyCacheSongs = true;
  const result = await p._getAudioSourceMeta(track(1));
  assert.equal(result.buffer, bytes);
  assert.equal(downloads, 1);
  assert.equal(env.cacheWrites.length, 1);
  assert.equal(env.cacheWrites[0][4], bytes);
  env.requests.cache = async () => ({
    source: bytes,
    url: 'audio-url',
    from: 'netease',
  });
  assert.equal((await p._getAudioSourceMeta(track(1))).buffer, bytes);
  assert.equal(downloads, 1);
});

test('stopping at queue end prevents a pending same-track load from restarting playback', async () => {
  const env = environment(),
    p = await env.player(3),
    download = deferred();
  p._getAudioSourceMeta = () => download.promise;
  const loading = p._replaceCurrentTrack(3);
  await flush();
  assert.equal(p.playNextTrack(), false);
  download.resolve({ buffer: audioBuffer(1), url: 'obsolete' });
  assert.equal(await loading, false);
  assert.equal(p._engine.current, null);
  assert.equal(p.playing, false);
});

test('play during pause fade cancels the stop for direct and toggle controls', async () => {
  for (const toggle of [false, true]) {
    const env = environment(),
      p = await env.player();
    env.store.state.settings.playPauseFade = true;
    const pausing = p.pause();
    assert.equal(p.playing, false);
    if (toggle) p.playOrPause();
    else p.play();
    await flush();
    env.timeouts.splice(0).forEach(fn => fn());
    assert.equal(await pausing, false);
    assert.equal(p._engine.ctx.state, 'running');
    assert.equal(p._engine.playing, true);
    assert.equal(p.playing, true);
  }
});

test('a delayed resume cannot undo a newer pause', async () => {
  const env = environment(),
    p = await env.player(),
    sink = deferred();
  p._engine.playing = false;
  p._engine._ensureSinkPlaying = () => sink.promise;
  const resuming = p.play();
  const pausing = p.pause();
  sink.resolve();
  await Promise.all([resuming, pausing]);
  assert.equal(p._engine.playing, false);
  assert.equal(p.playing, false);
  assert.equal(p._engine.ctx.state, 'running');
  assert.equal(p._engine.current.source, null);
});

test('pause keeps position fixed while the clock runs and resume schedules the remaining audio', async () => {
  const env = environment(),
    p = await env.player();
  await p._prefetchNextTrack();
  const engine = p._engine,
    context = engine.ctx,
    oldCurrent = engine.current.source,
    oldNext = engine.upcoming.source;
  context.suspend = () =>
    assert.fail('Pause must not suspend the output clock');
  context.currentTime = engine.current.startAt + 0.4;
  await p.pause();
  const position = p.seek();
  context.currentTime += 60;
  engine._onTick();
  assert.equal(p.seek(), position);
  assert.equal(p.currentTrackID, 1);
  assert.equal(oldCurrent.stopped, true);
  assert.equal(oldNext.stopped, true);
  assert.equal(engine.current.source, null);
  assert.equal(engine.upcoming.source, null);
  assert.equal(context.state, 'running');
  await p.play();
  assert.equal(engine.current.source.offset, position);
  assert.equal(engine.current.source.playbackRate.value, 1);
  assert.equal(engine.current.startAt, context.currentTime + 0.01);
  assert.equal(engine.upcoming.startAt, engine.current.startAt + 1 - position);
  const sourceCount = context.sources.length;
  await Promise.all([p.play(), p.play()]);
  assert.equal(context.sources.length, sourceCount);
  assert.equal(p.playing, true);
});

test('play and pause are immediate by default and fades can be enabled on both backends', async () => {
  for (const webAudio of [true, false]) {
    const env = environment(),
      p = await env.player();
    if (!webAudio) {
      env.store.state.settings.gaplessPlayback = false;
      p._getAudioSource = async () => 'fallback';
      await p._replaceCurrentTrackAudio(p.currentTrack, true, false);
    }
    let fadeCalls = 0;
    if (!webAudio) {
      const fade = p._howler.fade.bind(p._howler);
      p._howler.fade = (...args) => {
        fadeCalls++;
        fade(...args);
      };
    }
    await p.pause();
    assert.equal(p.playing, false);
    assert.equal(
      webAudio ? p._engine.current.source : p._howler.playing(),
      webAudio ? null : false
    );
    assert.equal(env.timeouts.length, 0);
    await p.play();
    await flush();
    assert.equal(p.playing, true);
    assert.equal(
      webAudio ? p._engine.gain.gain.value : p._howler.volume(),
      p.volume
    );
    assert.equal(fadeCalls, 0);
    env.store.state.settings.playPauseFade = true;
    const pausing = p.pause();
    assert.equal(webAudio ? p._engine.playing : p._howler.playing(), true);
    if (webAudio) {
      assert.equal(p._engine.fadeDuration, 0.2);
      env.timeouts.splice(0).forEach(fn => fn());
    } else {
      assert.equal(fadeCalls, 1);
      p._howler.emit('fade');
    }
    await pausing;
    assert.equal(webAudio ? p._engine.playing : p._howler.playing(), false);
    await p.play();
    await flush();
    assert.equal(p.playing, true);
    if (!webAudio) assert.equal(fadeCalls, 2);
  }
});

test('manual next reuses the decoded successor without requesting or decoding it again', async () => {
  const env = environment(),
    p = await env.player();
  const counts = { detail: 0, source: 0, decode: 0 };
  env.requests.detail = async id => {
    if (id === 2) counts.detail++;
    return { songs: [track(id)] };
  };
  p._getAudioSourceMeta = async t => {
    if (t.id === 2) counts.source++;
    return { buffer: audioBuffer(1), url: 'prepared' };
  };
  const prepare = p._engine.prepare.bind(p._engine);
  p._engine.prepare = async (t, data) => {
    if (t.id === 2) counts.decode++;
    return prepare(t, data);
  };
  await p._prefetchNextTrack();
  const buffer = p._engine.upcoming.buffer;
  let loading;
  const replace = p._replaceCurrentTrack.bind(p);
  p._replaceCurrentTrack = (...args) => (loading = replace(...args));
  assert.equal(p.playNextTrack(), true);
  assert.equal(await loading, true);
  assert.equal(p.currentTrackID, 2);
  assert.equal(p._engine.currentBuffer, buffer);
  assert.deepEqual(counts, { detail: 1, source: 1, decode: 1 });
});

test('manual next shares an in-flight detail, download or decode task with prefetch', async () => {
  for (const stage of ['detail', 'source', 'decode']) {
    const env = environment(),
      p = await env.player(),
      pending = deferred();
    const counts = { detail: 0, source: 0, decode: 0 };
    const buffer = audioBuffer(1);
    env.requests.detail = async id => {
      if (id === 2) {
        counts.detail++;
        if (stage === 'detail') await pending.promise;
      }
      return { songs: [track(id)] };
    };
    p._getAudioSourceMeta = async t => {
      if (t.id === 2) {
        counts.source++;
        if (stage === 'source') await pending.promise;
      }
      return { buffer, url: 'pending' };
    };
    const prepare = p._engine.prepare.bind(p._engine);
    p._engine.prepare = async (t, data) => {
      if (t.id === 2) {
        counts.decode++;
        if (stage === 'decode') await pending.promise;
      }
      return prepare(t, data);
    };
    const prefetching = p._prefetchNextTrack();
    await flush();
    let loading;
    const replace = p._replaceCurrentTrack.bind(p);
    p._replaceCurrentTrack = (...args) => (loading = replace(...args));
    p.playNextTrack();
    await flush();
    pending.resolve();
    await prefetching;
    assert.equal(await loading, true);
    assert.equal(p.currentTrackID, 2);
    assert.equal(p._engine.currentBuffer, buffer);
    assert.deepEqual(counts, { detail: 1, source: 1, decode: 1 }, stage);
  }
});

test('pause while downloading is preserved when the replacement becomes ready', async () => {
  const env = environment(),
    p = await env.player(),
    download = deferred();
  p._getAudioSourceMeta = () => download.promise;
  p.current = 1;
  const loading = p._replaceCurrentTrack(2);
  await flush();
  const pausing = p.pause();
  download.resolve({ buffer: audioBuffer(1), url: 'new' });
  await loading;
  env.timeouts.splice(0).forEach(fn => fn());
  await pausing;
  await flush();
  assert.equal(p.currentTrackID, 2);
  assert.equal(p._engine.playing, false);
  assert.equal(p._engine.ctx.state, 'running');
  assert.equal(p._engine.current.source, null);
  assert.equal(p.playing, false);
  assert.equal(p._engine.upcoming.track.id, 3);
});

test('pause from the previous track cannot stop its replacement', async () => {
  const env = environment(),
    p = await env.player();
  env.store.state.settings.playPauseFade = true;
  const pausing = p.pause();
  await p._replaceCurrentTrack(2);
  env.timeouts.splice(0).forEach(fn => fn());
  assert.equal(await pausing, false);
  assert.equal(p._engine.ctx.state, 'running');
  assert.equal(p.playing, true);
});

test('reaching an unprepared boundary during fade cannot undo pause intent', async () => {
  const env = environment(),
    p = await env.player();
  p.current = 0;
  env.store.state.settings.playPauseFade = true;
  const pausing = p.pause();
  p._engine.ctx.currentTime = p._engine.cursor;
  p._engine._onTick();
  assert.equal(p.currentTrackID, 1);
  assert.equal(p._playRequested, false);
  env.timeouts.splice(0).forEach(fn => fn());
  await pausing;
  assert.equal(p._engine.ctx.state, 'running');
  assert.equal(p._engine.current.source, null);
  await p.play();
  p._engine.ctx.currentTime = p._engine.cursor;
  p._engine._onTick();
  await flush();
  assert.equal(p.currentTrackID, 2);
  assert.equal(p.playing, true);
});

test('pause fade crossing a prepared boundary saves the new track position only once', async () => {
  const env = environment(),
    p = await env.player();
  env.store.state.settings.playPauseFade = true;
  await p._prefetchNextTrack();
  const boundary = p._engine.upcoming.startAt;
  const pausing = p.pause();
  p._engine.ctx.currentTime = boundary + 0.05;
  env.timeouts.splice(0).forEach(fn => fn());
  await pausing;
  await flush();
  assert.equal(p.currentTrackID, 2);
  assert(Math.abs(p.seek() - 0.05) < 1e-7);
  assert.equal(p._engine.current.source, null);
  assert.equal(p._engine.upcoming.track.id, 3);
  assert.equal(p._engine.upcoming.source, null);
  p._engine.ctx.currentTime += 20;
  p._engine._onTick();
  await p.play();
  assert.equal(p.currentTrackID, 2);
  assert(Math.abs(p._engine.current.source.offset - 0.05) < 1e-7);
  assert(
    Math.abs(p._engine.upcoming.startAt - p._engine.current.startAt - 0.95) <
      1e-7
  );
});

test('seek preserves pause and rebuilds the next track on the audio clock', async () => {
  const env = environment(),
    p = await env.player();
  const pausing = p.pause();
  env.timeouts.splice(0).forEach(fn => fn());
  await pausing;
  p.seek(0.4);
  await flush();
  assert.equal(p.seek(), 0.4);
  assert.equal(p._engine.ctx.state, 'running');
  assert.equal(p._engine.current.source, null);
  assert.equal(p._engine.upcoming.startAt, p._engine.current.startAt + 0.6);
});

test('decoded PCM retains intentional leading and trailing silence byte for byte', async () => {
  const env = environment(),
    engine = new env.AudioEngine();
  engine._ensureContext();
  const original = audioBuffer(1);
  for (let c = 0; c < 2; c++)
    original.getChannelData(c).fill(0.25, 1440, 46560);
  engine.ctx.decoded = original;
  const result = await engine.prepare(track(1), new ArrayBuffer(8));
  assert.equal(result.length, 48000);
  assert.equal(result, original);
  assert.deepEqual(result.getChannelData(0), original.getChannelData(0));
});

test('sample scheduling is contiguous and metadata is never promoted early', async () => {
  const env = environment(),
    p = await env.player();
  await p._prefetchNextTrack();
  const end = p._engine.current.startAt + p._engine.currentBuffer.duration;
  assert.equal(p._engine.upcoming.source.when, end);
  p._engine.ctx.currentTime = end - 0.01;
  p._engine._onTick();
  assert.equal(p.currentTrackID, 1);
  p._engine.ctx.currentTime = end;
  p._engine._onTick();
  await flush();
  assert.equal(p.currentTrackID, 2);
  assert.equal(p._engine.upcoming.source.when, end + 1);
});

test('natural queue end stops and invalidates pending loads', async () => {
  const env = environment(),
    p = await env.player(3);
  p._engine.ctx.currentTime = p._engine.cursor;
  p._engine._onTick();
  assert.equal(p._engine.current, null);
  assert.equal(p.playing, false);
  assert.equal(p._playRequested, false);
});

test('disposing the engine releases its gesture listeners', async () => {
  const env = environment(),
    p = await env.player();
  assert.equal(env.listeners.size, 1);
  p._engine.dispose();
  assert.equal(env.listeners.size, 0);
});

(async () => {
  let failures = 0;
  for (const { name, run } of cases) {
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures++;
      console.error(`FAIL ${name}\n`, error);
    }
  }
  console.log(
    `${cases.length - failures}/${cases.length} gapless regression tests passed`
  );
  process.exitCode = failures ? 1 : 0;
})();
