import { getAlbum } from '@/api/album';
import { getArtist } from '@/api/artist';
import { trackScrobble, trackUpdateNowPlaying } from '@/api/lastfm';
import { fmTrash, personalFM } from '@/api/others';
import { getPlaylistDetail, intelligencePlaylist } from '@/api/playlist';
import { getLyric, getMP3, getTrackDetail, scrobble } from '@/api/track';
import store from '@/store';
import { isAccountLoggedIn } from '@/utils/auth';
import { cacheTrackSource, getTrackSource } from '@/utils/db';
import { isCreateMpris, isCreateTray } from '@/utils/platform';
import { Howl } from 'howler';
import shuffle from 'lodash/shuffle';
import { decode as base642Buffer } from '@/utils/base64';
import AudioEngine from '@/utils/AudioEngine';
import axios from 'axios';

const PLAY_PAUSE_FADE_DURATION = 200;
const PREPARED_CACHE_BYTES = 128 * 1024 * 1024;

const INDEX_IN_PLAY_NEXT = -1;

/**
 * @readonly
 * @enum {string}
 */
const UNPLAYABLE_CONDITION = {
  PLAY_NEXT_TRACK: 'playNextTrack',
  PLAY_PREV_TRACK: 'playPrevTrack',
};

const electron =
  process.env.IS_ELECTRON === true ? window.require('electron') : null;
const ipcRenderer =
  process.env.IS_ELECTRON === true ? electron.ipcRenderer : null;
const delay = ms =>
  new Promise(resolve => {
    setTimeout(() => {
      resolve('');
    }, ms);
  });
const excludeSaveKeys = [
  '_playing',
  '_personalFMLoading',
  '_personalFMNextLoading',
  // 以下是无缝播放引擎的内部状态，不需要也不能持久化
  '_engine',
  '_audioMode',
  '_prefetched',
  '_prefetchGen',
  '_scrobbledTrackID',
  '_scheduledNextIndex',
  '_currentSourceLabel',
  '_loadGen',
  '_loadingTrack',
  '_playRequested',
  '_playbackToken',
  '_preparingTrack',
  '_preparedTracks',
  '_restorePosition',
  '_howlerTrack',
];

// 单曲循环时用来标记“已经排程的下一首就是当前曲”
const INDEX_IN_REPEAT_ONE = -2;

function setTitle(track) {
  document.title = track
    ? `${track.name} · ${track.ar[0].name} - YesPlayMusic`
    : 'YesPlayMusic';
  if (isCreateTray) {
    ipcRenderer?.send('updateTrayTooltip', document.title);
  }
  store.commit('updateTitle', document.title);
}

function setTrayLikeState(isLiked) {
  if (isCreateTray) {
    ipcRenderer?.send('updateTrayLikeState', isLiked);
  }
}

export default class {
  constructor() {
    // 播放器状态
    this._playing = false; // 是否正在播放中
    this._progress = 0; // 当前播放歌曲的进度
    this._enabled = false; // 是否启用Player
    this._repeatMode = 'off'; // off | on | one
    this._shuffle = false; // true | false
    this._reversed = false;
    this._volume = 1; // 0 to 1
    this._volumeBeforeMuted = 1; // 用于保存静音前的音量
    this._personalFMLoading = false; // 是否正在私人FM中加载新的track
    this._personalFMNextLoading = false; // 是否正在缓存私人FM的下一首歌曲

    // 播放信息
    this._list = []; // 播放列表
    this._current = 0; // 当前播放歌曲在播放列表里的index
    this._shuffledList = []; // 被随机打乱的播放列表，随机播放模式下会使用此播放列表
    this._shuffledCurrent = 0; // 当前播放歌曲在随机列表里面的index
    this._playlistSource = { type: 'album', id: 123 }; // 当前播放列表的信息
    this._currentTrack = { id: 86827685 }; // 当前播放歌曲的详细信息
    this._playNextList = []; // 当这个list不为空时，会优先播放这个list的歌
    this._isPersonalFM = false; // 是否是私人FM模式
    this._personalFMTrack = { id: 0 }; // 私人FM当前歌曲
    this._personalFMNextTrack = {
      id: 0,
    }; // 私人FM下一首歌曲信息（为了快速加载下一首）

    /**
     * The blob records for cleanup.
     *
     * @private
     * @type {string[]}
     */
    this.createdBlobRecords = [];

    // howler (https://github.com/goldfire/howler.js)
    this._howler = null;
    Object.defineProperty(this, '_howler', {
      enumerable: false,
    });

    // 无缝播放引擎（AudioContext + 预解码 + 绝对时刻排程）。
    // 这些字段必须不可枚举：Vuex 会把 player 变成响应式对象，
    // 引擎实例一旦被观察/序列化会带来严重问题。
    this._engine = null;
    this._audioMode = 'howler'; // 'web-audio' | 'howler'
    this._prefetched = null; // { trackID, buffer, track }
    this._prefetchGen = 0;
    this._scrobbledTrackID = null;
    this._scheduledNextIndex = null;
    this._currentSourceLabel = '';
    this._loadGen = 0;
    this._loadingTrack = false;
    this._playRequested = false;
    this._playbackToken = 0;
    this._preparingTrack = null;
    this._preparedTracks = new Map();
    this._restorePosition = 0;
    this._howlerTrack = null;
    [
      '_engine',
      '_audioMode',
      '_prefetched',
      '_prefetchGen',
      '_scrobbledTrackID',
      '_scheduledNextIndex',
      '_currentSourceLabel',
      '_loadGen',
      '_loadingTrack',
      '_playRequested',
      '_playbackToken',
      '_preparingTrack',
      '_preparedTracks',
      '_restorePosition',
      '_howlerTrack',
    ].forEach(key =>
      Object.defineProperty(this, key, {
        enumerable: false,
        writable: true,
        configurable: true,
      })
    );

    // init
    this._init();

    window.yesplaymusic = {};
    window.yesplaymusic.player = this;
  }

  get repeatMode() {
    return this._repeatMode;
  }
  set repeatMode(mode) {
    if (this._isPersonalFM) return;
    if (!['off', 'on', 'one'].includes(mode)) {
      console.warn("repeatMode: invalid args, must be 'on' | 'off' | 'one'");
      return;
    }
    this._repeatMode = mode;
    this._refreshUpcoming();
  }
  get shuffle() {
    return this._shuffle;
  }
  set shuffle(shuffle) {
    if (this._isPersonalFM) return;
    if (shuffle !== true && shuffle !== false) {
      console.warn('shuffle: invalid args, must be Boolean');
      return;
    }
    this._shuffle = shuffle;
    if (shuffle) {
      this._shuffleTheList();
    }
    // 同步当前歌曲在列表中的下标
    this.current = this.list.indexOf(this.currentTrackID);
    this._refreshUpcoming();
  }
  get reversed() {
    return this._reversed;
  }
  set reversed(reversed) {
    if (this._isPersonalFM) return;
    if (reversed !== true && reversed !== false) {
      console.warn('reversed: invalid args, must be Boolean');
      return;
    }
    console.log('changing reversed to:', reversed);
    this._reversed = reversed;
    this._refreshUpcoming();
  }
  get volume() {
    return this._volume;
  }
  set volume(volume) {
    this._volume = volume;
    this._howler?.volume(volume);
    this._engine?.setVolume(volume);
  }
  get list() {
    return this.shuffle ? this._shuffledList : this._list;
  }
  set list(list) {
    this._list = list;
  }
  get current() {
    return this.shuffle ? this._shuffledCurrent : this._current;
  }
  set current(current) {
    if (this.shuffle) {
      this._shuffledCurrent = current;
    } else {
      this._current = current;
    }
  }
  get enabled() {
    return this._enabled;
  }
  get playing() {
    return this._playing;
  }
  get audioMode() {
    return this._audioMode;
  }
  /**
   * 当前音源标签，用于判断是否来自 kuwo 等第三方音源。
   * Web Audio 模式下没有 Howler 实例，由 _getAudioSourceMeta 记录。
   */
  get currentSourceLabel() {
    if (this._audioMode === 'howler') {
      // Howler 在 load() 之后会把 _src 从数组替换成命中的那个 URL 字符串
      const src = this._howler?._src;
      if (!src) return '';
      return Array.isArray(src) ? src.join(' ') : String(src);
    }
    return this._currentSourceLabel;
  }
  get currentTrack() {
    return this._currentTrack;
  }
  get currentTrackID() {
    return this._currentTrack?.id ?? 0;
  }
  get playlistSource() {
    return this._playlistSource;
  }
  get playNextList() {
    return this._playNextList;
  }
  get isPersonalFM() {
    return this._isPersonalFM;
  }
  get personalFMTrack() {
    return this._personalFMTrack;
  }
  get currentTrackDuration() {
    const trackDuration = this._currentTrack.dt || 1000;
    let duration = ~~(trackDuration / 1000);
    return duration > 1 ? duration - 1 : duration;
  }
  get progress() {
    return this._progress;
  }
  set progress(value) {
    this.seek(value);
  }
  get isCurrentTrackLiked() {
    return store.state.liked.songs.includes(this.currentTrack.id);
  }

  _init() {
    this._loadSelfFromLocalStorage();
    this._initAudioEngine();
    this._howler?.volume(this.volume);

    if (this._enabled) {
      this._restorePlayback();
      this._initMediaSession();
    }

    this._setIntervals();

    // 初始化私人FM
    if (
      this._personalFMTrack.id === 0 ||
      this._personalFMNextTrack.id === 0 ||
      this._personalFMTrack.id === this._personalFMNextTrack.id
    ) {
      personalFM().then(result => {
        if (!this._personalFMTrack.id) this._personalFMTrack = result.data[0];
        this._personalFMNextTrack = result.data.find(
          track => track.id !== this._personalFMTrack.id
        ) ?? { id: 0 };
        return this._personalFMTrack;
      });
    }
  }
  _restorePlayback() {
    // 恢复进度属于本次加载；不能等异步完成后再 seek 当时正在播放的歌曲。
    // 失败时保留原曲供用户重试，不自动跳过恢复目标。
    return this._replaceCurrentTrack(this.currentTrackID, false, null, {
      seek: this._restorePosition,
    });
  }
  _initAudioEngine() {
    try {
      this._engine = new AudioEngine({
        onTrackStart: track => this._handleTrackStart(track),
        onGap: reason => this._handleGap(reason),
      });
      this._engine.setVolume(this.volume);
    } catch (error) {
      console.warn('[Player] AudioEngine unavailable', error);
      this._engine = null;
      this._audioMode = 'howler';
    }
  }
  /**
   * 只有开关打开且引擎存在时才尝试 Web Audio 路径，
   * 任何失败都会回落到 Howler（Web 构建 / 不支持的格式）。
   */
  _shouldUseEngine() {
    if (store.state.settings.gaplessPlayback === false) return false;
    if (!this._engine) return false;
    // 引擎可能还没创建 AudioContext，先把输出设备记下来，
    // 等第一次 _ensureContext 时一次性接好。
    this._engine.outputDevice = store.state.settings.outputDevice || 'default';
    return true;
  }
  /** 清空已排程的下一首（队列、播放模式或 seek 变化时必须调用） */
  _resetUpcoming() {
    this._prefetchGen++;
    this._prefetched = null;
    this._scheduledNextIndex = null;
    this._engine?.clearUpcoming();
  }
  /** 队列或播放模式改变后，立即按新的规则重新准备下一首。 */
  _refreshUpcoming() {
    this._resetUpcoming();
    return this._prefetchNextTrack();
  }
  get playPauseFadeDuration() {
    return store.state.settings.playPauseFade === true
      ? PLAY_PAUSE_FADE_DURATION
      : 0;
  }
  _configurePlayback() {
    if (this._engine)
      this._engine.fadeDuration = this.playPauseFadeDuration / 1000;
  }
  /** 手动切歌和预取共享同一下载/解码任务，避免点下一首时从头再来。 */
  _prepareTrack(id, track = null) {
    const quality = store.state.settings.musicQuality ?? 320000;
    const key = `${id}:${quality}`;
    if (this._preparingTrack?.key !== key)
      this._preparingTrack?.controller?.abort();
    if (
      this._prefetched?.trackID === id &&
      this._prefetched.quality === quality
    )
      return Promise.resolve(this._prefetched);
    const cached = this._preparedTracks.get(key);
    if (cached) {
      this._preparedTracks.delete(key);
      this._preparedTracks.set(key, cached);
      return Promise.resolve(cached);
    }
    if (this._preparingTrack?.key === key) return this._preparingTrack.promise;
    const controller =
      typeof AbortController === 'function' ? new AbortController() : null;
    const request = { trackID: id, key, controller, promise: null };
    request.promise = (async () => {
      const detail = track ?? (await getTrackDetail(id))?.songs?.[0];
      if (controller?.signal.aborted) throw new Error('OBSOLETE_PREPARATION');
      if (!detail) throw new Error('NO_TRACK_DETAIL');
      const meta = await this._getAudioSourceMeta(detail, {
        signal: controller?.signal,
      });
      if (controller?.signal.aborted) throw new Error('OBSOLETE_PREPARATION');
      if (!meta?.buffer) throw new Error('NO_AUDIO_SOURCE');
      const buffer = await this._engine.prepare(detail, meta.buffer);
      if (controller?.signal.aborted) throw new Error('OBSOLETE_PREPARATION');
      const prepared = {
        trackID: id,
        track: detail,
        buffer,
        label: meta.url || meta.from,
        quality,
      };
      const bytes = buffer.length * buffer.numberOfChannels * 4;
      if (bytes <= PREPARED_CACHE_BYTES) {
        this._preparedTracks.set(key, prepared);
        let total = 0;
        for (const item of this._preparedTracks.values())
          total += item.buffer.length * item.buffer.numberOfChannels * 4;
        while (total > PREPARED_CACHE_BYTES || this._preparedTracks.size > 3) {
          const oldest = this._preparedTracks.keys().next().value;
          const item = this._preparedTracks.get(oldest);
          total -= item.buffer.length * item.buffer.numberOfChannels * 4;
          this._preparedTracks.delete(oldest);
        }
      }
      return prepared;
    })().finally(() => {
      if (this._preparingTrack === request) this._preparingTrack = null;
    });
    this._preparingTrack = request;
    return request.promise;
  }
  _setIntervals() {
    // 同步播放进度
    setInterval(() => {
      // 加载过程中仍保持上次有效进度，不能被尚未就绪的后端归零。
      if (this._loadingTrack) return;
      if (this._audioMode === 'web-audio') this._engine?._onTick();
      const state = this._capturePlaybackState();
      this._progress = state.position;
      localStorage.setItem('playerPlaybackState', JSON.stringify(state));
      if (isCreateMpris) {
        ipcRenderer?.send('playerCurrentTrackTime', this._progress);
      }
    }, 1000);
  }
  _setPlaying(isPlaying) {
    this._playing = isPlaying;
    if (isCreateTray) {
      ipcRenderer?.send('updateTrayPlayState', this._playing);
    }
  }
  _getNextTrack() {
    const next = this._reversed ? this.current - 1 : this.current + 1;

    if (this._playNextList.length > 0) {
      let trackID = this._playNextList[0];
      return [trackID, INDEX_IN_PLAY_NEXT];
    }

    // 循环模式开启，则重新播放当前模式下的相对的下一首
    if (this.repeatMode === 'on') {
      if (this._reversed && this.current === 0) {
        // 倒序模式，当前歌曲是第一首，则重新播放列表最后一首
        return [this.list[this.list.length - 1], this.list.length - 1];
      } else if (this.list.length === this.current + 1) {
        // 正序模式，当前歌曲是最后一首，则重新播放第一首
        return [this.list[0], 0];
      }
    }

    // 返回 [trackID, index]
    return [this.list[next], next];
  }
  _getPrevTrack() {
    const next = this._reversed ? this.current + 1 : this.current - 1;

    // 循环模式开启，则重新播放当前模式下的相对的下一首
    if (this.repeatMode === 'on') {
      if (this._reversed && this.current === 0) {
        // 倒序模式，当前歌曲是最后一首，则重新播放列表第一首
        return [this.list[0], 0];
      } else if (this.list.length === this.current + 1) {
        // 正序模式，当前歌曲是第一首，则重新播放列表最后一首
        return [this.list[this.list.length - 1], this.list.length - 1];
      }
    }

    // 返回 [trackID, index]
    return [this.list[next], next];
  }
  async _shuffleTheList(firstTrackID = this.currentTrackID) {
    let list = this._list.filter(tid => tid !== firstTrackID);
    if (firstTrackID === 'first') list = this._list;
    this._shuffledList = shuffle(list);
    if (firstTrackID !== 'first') this._shuffledList.unshift(firstTrackID);
  }
  async _scrobble(track, time, completed = false) {
    console.debug(
      `[debug][Player.js] scrobble track 👉 ${track.name} by ${track.ar[0].name} 👉 time:${time} completed: ${completed}`
    );
    const trackDuration = ~~(track.dt / 1000);
    time = completed ? trackDuration : ~~time;

    // 一次播放只上报一次：歌曲自然播完时会先结算上一首，
    // 紧接着手动切歌又可能走到这里；没有真正播放过 (time < 1) 的歌曲也不上报。
    if (this._scrobbledTrackID === track.id || time < 1) return;
    this._scrobbledTrackID = track.id;

    scrobble({
      id: track.id,
      sourceid: this.playlistSource.id,
      time,
    }).catch(error => {
      console.debug('[debug][Player.js] scrobble failed', error);
    });
    if (
      store.state.lastfm.key !== undefined &&
      (time >= trackDuration / 2 || time >= 240)
    ) {
      const timestamp = ~~(new Date().getTime() / 1000) - time;
      trackScrobble({
        artist: track.ar[0].name,
        track: track.name,
        timestamp,
        album: track.al.name,
        trackNumber: track.no,
        duration: trackDuration,
      });
    }
  }
  _playAudioSource(source, autoplay = true, seek = 0) {
    // 从 Web Audio 降级回来时，先停掉引擎里还在播放的 source
    this._resetUpcoming();
    this._engine?.clearAllSources();
    this._audioMode = 'howler';
    this._currentSourceLabel = '';
    this._howler?.unload();
    this._howlerTrack = this.currentTrack;
    this._howler = new Howl({
      src: [source],
      html5: true,
      preload: true,
      volume: this.volume,
      format: ['mp3', 'flac'],
      onend: () => {
        this._nextTrackCallback();
      },
    });
    if (seek > 0) this._howler.seek(seek);
    this._howler.on('loaderror', (_, errCode) => {
      // https://developer.mozilla.org/en-US/docs/Web/API/MediaError/code
      // code 3: MEDIA_ERR_DECODE
      if (errCode === 3) {
        this._playNextTrack(this._isPersonalFM);
      } else if (errCode === 4) {
        // code 4: MEDIA_ERR_SRC_NOT_SUPPORTED
        store.dispatch('showToast', `无法播放: 不支持的音频格式`);
        this._playNextTrack(this._isPersonalFM);
      } else {
        const t = this.progress;
        this._replaceCurrentTrackAudio(this.currentTrack, false, false).then(
          replaced => {
            // 如果 replaced 为 false，代表当前的 track 已经不是这里想要替换的track
            // 此时则不修改当前的歌曲进度
            if (replaced) {
              this._howler?.seek(t);
              this.play();
            }
          }
        );
      }
    });
    if (!autoplay) this._setPlaying(false);
    if (autoplay) {
      this.play();
      if (this._currentTrack.name) {
        setTitle(this._currentTrack);
      }
      setTrayLikeState(store.state.liked.songs.includes(this.currentTrack.id));
    }
    this.setOutputDevice();
  }
  _getAudioSourceBlobURL(data) {
    // Create a new object URL.
    const source = URL.createObjectURL(new Blob([data]));

    // Clean up the previous object URLs since we've created a new one.
    // Revoke object URLs can release the memory taken by a Blob,
    // which occupied a large proportion of memory.
    for (const url in this.createdBlobRecords) {
      URL.revokeObjectURL(url);
    }

    // Then, we replace the createBlobRecords with new one with
    // our newly created object URL.
    this.createdBlobRecords = [source];

    return source;
  }
  _getAudioSourceFromCache(id) {
    return getTrackSource(id).then(t => {
      if (!t) return null;
      return this._getAudioSourceBlobURL(t.source);
    });
  }
  async _getNeteaseAudioURL(track) {
    if (isAccountLoggedIn()) {
      const result = await getMP3(track.id);
      const item = result?.data?.[0];
      if (!item || !item.url) return null;
      if (item.freeTrialInfo !== null) return null; // 跳过只能试听的歌曲
      return {
        url: item.url.replace(/^http:/, 'https:'),
        bitRate: item.br,
        from: 'netease',
      };
    }
    return {
      url: `https://music.163.com/song/media/outer/url?id=${track.id}`,
      bitRate: 128000,
      from: 'netease',
      cacheable: false,
    };
  }
  _getAudioSourceFromNetease(track) {
    return this._getNeteaseAudioURL(track).then(info => {
      if (!info) return null;
      if (
        info.cacheable !== false &&
        store.state.settings.automaticallyCacheSongs
      ) {
        cacheTrackSource(track, info.url, info.bitRate);
      }
      return info.url;
    });
  }
  /**
   * 解析 UnblockNeteaseMusic 音源。
   * bilibili 音源返回的是 base64 数据，直接给出解码后的 buffer。
   */
  async _resolveUnblockMusic(track) {
    console.debug(`[debug][Player.js] _getAudioSourceFromUnblockMusic`);

    if (
      process.env.IS_ELECTRON !== true ||
      store.state.settings.enableUnblockNeteaseMusic === false
    ) {
      return null;
    }

    /**
     *
     * @param {string=} searchMode
     * @returns {import("@unblockneteasemusic/rust-napi").SearchMode}
     */
    const determineSearchMode = searchMode => {
      /**
       * FastFirst = 0
       * OrderFirst = 1
       */
      switch (searchMode) {
        case 'fast-first':
          return 0;
        case 'order-first':
          return 1;
        default:
          return 0;
      }
    };

    const retrieveSongInfo = await ipcRenderer.invoke(
      'unblock-music',
      store.state.settings.unmSource,
      track,
      {
        enableFlac: store.state.settings.unmEnableFlac || null,
        proxyUri: store.state.settings.unmProxyUri || null,
        searchMode: determineSearchMode(store.state.settings.unmSearchMode),
        config: {
          'joox:cookie': store.state.settings.unmJooxCookie || null,
          'qq:cookie': store.state.settings.unmQQCookie || null,
          'ytdl:exe': store.state.settings.unmYtDlExe || null,
        },
      }
    );

    if (!retrieveSongInfo) return null;

    if (retrieveSongInfo.source === 'bilibili') {
      // 对于来自 bilibili 的音源，url 是音频数据的 base64 编码
      return {
        url: `data:application/octet-stream;base64,${retrieveSongInfo.url}`,
        buffer: base642Buffer(retrieveSongInfo.url),
        bitRate: 128000,
        from: 'unm:bilibili',
      };
    }

    return {
      url: retrieveSongInfo.url,
      bitRate: 128000,
      from: `unm:${retrieveSongInfo.source}`,
    };
  }
  async _getAudioSourceFromUnblockMusic(track) {
    const info = await this._resolveUnblockMusic(track);
    if (!info) return null;

    if (store.state.settings.automaticallyCacheSongs && info.url) {
      cacheTrackSource(track, info.url, info.bitRate, info.from);
    }

    if (info.buffer) {
      return this._getAudioSourceBlobURL(info.buffer);
    }
    return info.url;
  }
  _getAudioSource(track) {
    return this._getAudioSourceFromCache(String(track.id))
      .then(source => {
        return source ?? this._getAudioSourceFromNetease(track);
      })
      .then(source => {
        return source ?? this._getAudioSourceFromUnblockMusic(track);
      });
  }
  /**
   * 取音频字节，供 Web Audio 引擎解码。
   * 优先 Dexie 缓存，其次网易云直链，最后 Unblock。
   * @returns {Promise<{buffer: ArrayBuffer, url: string, from: string}|null>}
   */
  async _getAudioSourceMeta(track, { signal } = {}) {
    const cached = await getTrackSource(String(track.id));
    if (cached?.source) {
      return {
        buffer: cached.source,
        url: cached.url ?? '',
        from: cached.from ?? 'netease',
      };
    }

    let info = await this._getNeteaseAudioURL(track);
    if (!info) {
      info = await this._resolveUnblockMusic(track);
    }
    if (!info) return null;

    let buffer = info.buffer ?? null;
    if (!buffer && info.url) {
      buffer = await this._downloadAudioBuffer(info.url, { signal });
    }
    if (!buffer) return null;

    if (
      info.cacheable !== false &&
      store.state.settings.automaticallyCacheSongs &&
      info.url
    ) {
      // 复用刚下载的字节，不为缓存再请求一次完整音频。
      cacheTrackSource(track, info.url, info.bitRate, info.from, buffer)?.catch(
        error => console.warn('[Player] Failed to cache audio', track.id, error)
      );
    }

    return { buffer, url: info.url ?? '', from: info.from ?? 'netease' };
  }
  async _downloadAudioBuffer(url, { signal } = {}) {
    if (url.startsWith('data:')) {
      return base642Buffer(url.slice(url.indexOf(',') + 1));
    }
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      signal,
    });
    return response.data;
  }
  async _replaceCurrentTrack(
    id,
    autoplay = true,
    ifUnplayableThen = UNPLAYABLE_CONDITION.PLAY_NEXT_TRACK,
    { seek = 0 } = {}
  ) {
    // 必须在清空 upcoming 之前保存已准备/正在准备的目标曲。
    const prepared = this._shouldUseEngine() ? this._prepareTrack(id) : null;
    const loadGen = ++this._loadGen;
    this._loadingTrack = true;
    this._playRequested = autoplay;
    this._playbackToken++;
    if (autoplay && this._currentTrack.name) {
      this._scrobble(this.currentTrack, this.seek());
    }
    // 手动切歌必须清掉已经排程的下一首，否则它会插进来
    this._resetUpcoming();
    // 上一首已经结算过；这里清掉标记，允许重复播放同一首时再次上报
    this._scrobbledTrackID = null;
    try {
      let preparedTrack = null;
      if (prepared) {
        // 解码失败仍需保留原来的 Howler 降级通道。
        try {
          preparedTrack = await prepared;
        } catch (error) {
          if (loadGen !== this._loadGen) return false;
          preparedTrack = { error };
        }
      }
      if (loadGen !== this._loadGen) return false;
      const data = preparedTrack?.track
        ? { songs: [preparedTrack.track] }
        : await getTrackDetail(id);
      if (loadGen !== this._loadGen) return false;
      const track = data.songs[0];
      this._currentTrack = track;
      this._updateMediaSessionMetaData(track);
      return await this._replaceCurrentTrackAudio(
        track,
        this._playRequested,
        true,
        ifUnplayableThen,
        loadGen,
        preparedTrack,
        seek
      );
    } catch (error) {
      if (loadGen !== this._loadGen) return false;
      console.warn('[Player] Failed to load track', id, error);
      this._handleUnplayableTrack({ name: id }, ifUnplayableThen);
      return false;
    } finally {
      if (loadGen === this._loadGen) this._loadingTrack = false;
    }
  }
  /**
   * @returns 是否成功加载音频，并使用加载完成的音频替换了播放实例
   */
  async _replaceCurrentTrackAudio(
    track,
    autoplay,
    isCacheNextTrack,
    ifUnplayableThen = UNPLAYABLE_CONDITION.PLAY_NEXT_TRACK,
    loadGen = ++this._loadGen,
    preparedTrack = null,
    seek = 0
  ) {
    const isCurrent = () =>
      loadGen === this._loadGen && track.id === this.currentTrackID;
    if (!isCurrent()) return false;
    this._loadingTrack = true;
    this._playRequested = autoplay;
    try {
      if (this._shouldUseEngine()) {
        try {
          if (preparedTrack?.error) throw preparedTrack.error;
          const prepared =
            preparedTrack ?? (await this._prepareTrack(track.id, track));
          const buffer = prepared.buffer;
          if (!isCurrent()) return false;

          // 切到 Web Audio 之前先彻底关掉 Howler，避免两套输出叠加
          this._howler?.unload();
          this._howler = null;
          this._howlerTrack = null;
          this._audioMode = 'web-audio';
          this._currentSourceLabel = prepared.label;
          this._configurePlayback();
          const loaded = await this._engine.loadAndPlay(track, {
            buffer,
            autoplay: this._playRequested,
            seek,
          });
          if (!isCurrent() || !loaded) return false;
          // 用户可能在 loadAndPlay 等待输出设备时改变了播放意图。
          while (isCurrent() && this._playRequested !== this._engine.playing) {
            if (this._playRequested) {
              await this._engine.resume();
            } else {
              await this._engine.pause();
            }
          }
          if (!isCurrent()) return false;
          this._loadingTrack = false;
          this._progress = this._engine.position;
          // loadAndPlay 会清空已排程的下一首，预取记录同步失效
          this._prefetched = null;
          this._scheduledNextIndex = null;

          this._setPlaying(this._playRequested);
          if (this._playRequested) {
            // 播放时确保开启player.
            // 避免因"忘记设置"导致在播放时播放器不显示的Bug
            this._enabled = true;
            if (track.name) {
              setTitle(track);
            }
            setTrayLikeState(store.state.liked.songs.includes(track.id));
            this._playDiscordPresence(track, 0);
            this._updateNowPlaying();
          }
          if (isCacheNextTrack) this._prefetchNextTrack();
          return true;
        } catch (error) {
          // 旧请求的失败不能停止新请求已经启动的播放，也不能触发降级。
          if (!isCurrent()) return false;
          console.warn(
            '[Player] Web Audio 播放失败，回落到 Howler',
            track.name,
            error
          );
          this._engine?.clearAllSources();
          this._audioMode = 'howler';
        }
      }

      // ---- 以下是原有 Howler 路径，作为永久降级方案 ----
      const source = await this._getAudioSource(track);
      if (!isCurrent()) return false;
      this._loadingTrack = false;
      if (source) {
        this._progress = seek;
        this._playAudioSource(source, this._playRequested, seek);
        if (isCacheNextTrack) {
          this._cacheNextTrack();
        }
        return true;
      }
      this._handleUnplayableTrack(track, ifUnplayableThen);
      return false;
    } catch (error) {
      if (!isCurrent()) return false;
      console.warn('[Player] Failed to load audio source', track.id, error);
      this._handleUnplayableTrack(track, ifUnplayableThen);
      return false;
    } finally {
      if (loadGen === this._loadGen) this._loadingTrack = false;
    }
  }
  _handleUnplayableTrack(track, ifUnplayableThen) {
    store.dispatch('showToast', `无法播放 ${track.name}`);
    switch (ifUnplayableThen) {
      case UNPLAYABLE_CONDITION.PLAY_NEXT_TRACK:
        this._playNextTrack(this.isPersonalFM);
        break;
      case UNPLAYABLE_CONDITION.PLAY_PREV_TRACK:
        this.playPrevTrack();
        break;
      case null:
        break; // 冷启动恢复失败不能把原曲静默替换为下一首。
      default:
        store.dispatch(
          'showToast',
          `undefined Unplayable condition: ${ifUnplayableThen}`
        );
        break;
    }
  }
  /** 决定下一首要排程的曲目，以及队列下标如何推进 */
  _getUpcomingTrack() {
    if (this._isPersonalFM) {
      const trackID = this._personalFMNextTrack?.id;
      return trackID ? { trackID, index: null } : {};
    }
    if (this.repeatMode === 'one') {
      return {
        trackID: this.currentTrackID,
        index: INDEX_IN_REPEAT_ONE,
      };
    }
    const [trackID, index] = this._getNextTrack();
    return trackID === undefined ? {} : { trackID, index };
  }
  /**
   * 预取并排程下一首。解码是异步的，回来时用代际号
   * (_prefetchGen) 判断队列是否已经变化。
   */
  async _prefetchNextTrack() {
    if (this._audioMode !== 'web-audio' || !this._shouldUseEngine()) return;
    if (this._loadingTrack || !this._engine.ready) return;
    if (this._isPersonalFM && this._personalFMNextLoading) return;

    const { trackID, index } = this._getUpcomingTrack();
    if (!trackID) return;
    const quality = store.state.settings.musicQuality ?? 320000;
    if (
      this._prefetched?.trackID === trackID &&
      this._prefetched.quality === quality
    )
      return;

    const gen = ++this._prefetchGen;
    try {
      let track;
      let buffer;
      let label = this._currentSourceLabel;

      if (trackID === this.currentTrackID && this._engine.currentBuffer) {
        // 单曲循环：复用当前已解码的 AudioBuffer
        track = this._currentTrack;
        buffer = this._engine.currentBuffer;
      } else {
        const prepared = await this._prepareTrack(trackID);
        track = prepared.track;
        buffer = prepared.buffer;
        label = prepared.label;
        if (gen !== this._prefetchGen) return;
      }

      // 预取期间队列可能被修改，再核对一次
      const upcoming = this._getUpcomingTrack();
      if (
        gen !== this._prefetchGen ||
        upcoming.trackID !== trackID ||
        upcoming.index !== index ||
        this._loadingTrack ||
        this._audioMode !== 'web-audio' ||
        !this._shouldUseEngine()
      )
        return;

      this._prefetched = { trackID, buffer, track, label, quality };
      this._scheduledNextIndex = index;
      if (!this._engine.enqueue(track, buffer)) {
        // 引擎尚未就绪（当前曲还没排上），等它加载完成会再次调用
        this._prefetched = null;
        this._scheduledNextIndex = null;
      }
    } catch (error) {
      console.warn('[Player] 预取下一首失败', trackID, error);
    }
  }
  _prefetchOrCacheNextTrack() {
    if (this._audioMode === 'web-audio' && this._shouldUseEngine()) {
      this._prefetchNextTrack();
    } else {
      this._cacheNextTrack();
    }
  }
  /** 无缝边界：引擎已经切到预取的下一首，这里只做状态与 UI 同步 */
  _handleTrackStart(track) {
    const previous = this._currentTrack;
    const previousLabel = this._currentSourceLabel;
    const upcomingLabel = this._prefetched?.label ?? previousLabel;

    // 上一首自然播完，结算
    if (previous?.id) {
      this._scrobble(previous, 0, true);
    }
    // 新一轮播放，允许同一首歌（单曲循环）再次上报
    this._scrobbledTrackID = null;

    if (this._isPersonalFM) {
      this._personalFMTrack = track;
    } else if (this._scheduledNextIndex === INDEX_IN_PLAY_NEXT) {
      this._playNextList.shift();
    } else if (
      typeof this._scheduledNextIndex === 'number' &&
      this._scheduledNextIndex !== INDEX_IN_REPEAT_ONE
    ) {
      this.current = this._scheduledNextIndex;
    }
    this._scheduledNextIndex = null;
    this._prefetched = null;

    this._currentSourceLabel = upcomingLabel;
    this._currentTrack = track;
    this._updateMediaSessionMetaData(track);
    this._setPlaying(this._playRequested);
    setTitle(track);
    setTrayLikeState(store.state.liked.songs.includes(track.id));
    // 边界推进是引擎的 tick 触发的，不走 Vuex Proxy，需要手动落盘
    this.saveSelfToLocalStorage();
    this.sendSelfToIpcMain();
    this._playDiscordPresence(track, 0);
    this._updateNowPlaying();

    if (this._isPersonalFM) {
      // 拿到新的 FM 下一首之后再预取
      this._loadPersonalFMNextTrack();
    } else {
      this._prefetchNextTrack();
    }
  }
  _handleGap() {
    if (this._audioMode !== 'web-audio' || this._loadingTrack) return;
    // 预取没赶上 / 队列已到末尾：退回原有的切歌逻辑
    this._nextTrackCallback();
  }
  _cacheNextTrack() {
    let nextTrackID = this._isPersonalFM
      ? this._personalFMNextTrack?.id ?? 0
      : this._getNextTrack()[0];
    if (!nextTrackID) return;
    if (this._personalFMTrack.id == nextTrackID) return;
    getTrackDetail(nextTrackID).then(data => {
      let track = data.songs[0];
      this._getAudioSource(track);
    });
  }
  _updateNowPlaying() {
    if (store.state.lastfm.key === undefined) return;
    trackUpdateNowPlaying({
      artist: this.currentTrack.ar[0].name,
      track: this.currentTrack.name,
      album: this.currentTrack.al.name,
      trackNumber: this.currentTrack.no,
      duration: ~~(this.currentTrack.dt / 1000),
    });
  }
  _loadSelfFromLocalStorage() {
    const player = JSON.parse(localStorage.getItem('player'));
    if (!player) return;
    for (const [key, value] of Object.entries(player)) {
      if (excludeSaveKeys.includes(key) || key === '_playbackState') continue;
      this[key] = value;
    }
    const checkpoint = JSON.parse(localStorage.getItem('playerPlaybackState'));
    const saved = player._playbackState;
    const state =
      checkpoint?.trackID === this.currentTrackID
        ? checkpoint
        : saved?.trackID === this.currentTrackID
        ? saved
        : null;
    // 旧版本没有歌曲 ID 关联的进度，仅首次迁移时读取旧键。
    const position = state
      ? state.position
      : saved || checkpoint
      ? 0
      : localStorage.getItem('playerCurrentTrackTime') ?? player._progress;
    const seconds = Number(position);
    this._restorePosition = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    this._progress = this._restorePosition;
  }
  _initMediaSession() {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => {
        this.play();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        this.pause();
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        this.playPrevTrack();
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        this._playNextTrack(this.isPersonalFM);
      });
      navigator.mediaSession.setActionHandler('stop', () => {
        this.pause();
      });
      navigator.mediaSession.setActionHandler('seekto', event => {
        this.seek(event.seekTime);
        this._updateMediaSessionPositionState();
      });
      navigator.mediaSession.setActionHandler('seekbackward', event => {
        this.seek(this.seek() - (event.seekOffset || 10));
        this._updateMediaSessionPositionState();
      });
      navigator.mediaSession.setActionHandler('seekforward', event => {
        this.seek(this.seek() + (event.seekOffset || 10));
        this._updateMediaSessionPositionState();
      });
    }
  }
  _updateMediaSessionMetaData(track) {
    if ('mediaSession' in navigator === false) {
      return;
    }
    let artists = track.ar.map(a => a.name);
    const metadata = {
      title: track.name,
      artist: artists.join(','),
      album: track.al.name,
      artwork: [
        {
          src: track.al.picUrl + '?param=224y224',
          type: 'image/jpg',
          sizes: '224x224',
        },
        {
          src: track.al.picUrl + '?param=512y512',
          type: 'image/jpg',
          sizes: '512x512',
        },
      ],
      length: this.currentTrackDuration,
      trackId: this.current,
      url: '/trackid/' + track.id,
    };

    navigator.mediaSession.metadata = new window.MediaMetadata(metadata);
    if (isCreateMpris) {
      this._updateMprisState(track, metadata);
    }
  }
  // OSDLyrics 会检测 Mpris 状态并寻找对应歌词文件，所以要在更新 Mpris 状态之前保证歌词下载完成
  async _updateMprisState(track, metadata) {
    if (!store.state.settings.enableOsdlyricsSupport) {
      return ipcRenderer?.send('metadata', metadata);
    }

    let lyricContent = await getLyric(track.id);

    if (!lyricContent.lrc || !lyricContent.lrc.lyric) {
      return ipcRenderer?.send('metadata', metadata);
    }

    ipcRenderer.send('sendLyrics', {
      track,
      lyrics: lyricContent.lrc.lyric,
    });

    ipcRenderer.on('saveLyricFinished', () => {
      ipcRenderer?.send('metadata', metadata);
    });
  }
  _updateMediaSessionPositionState() {
    if ('mediaSession' in navigator === false) {
      return;
    }
    if ('setPositionState' in navigator.mediaSession) {
      navigator.mediaSession.setPositionState({
        duration: ~~(this.currentTrack.dt / 1000),
        playbackRate: 1.0,
        position: this.seek(),
      });
    }
  }
  _nextTrackCallback() {
    this._scrobble(this._currentTrack, 0, true);
    if (!this.isPersonalFM && this.repeatMode === 'one') {
      this._replaceCurrentTrack(this.currentTrackID);
    } else {
      this._playNextTrack(this.isPersonalFM);
    }
  }
  _loadPersonalFMNextTrack() {
    if (this._personalFMNextLoading) {
      return [false, undefined];
    }
    this._personalFMNextLoading = true;
    return personalFM()
      .then(result => {
        if (!result || !result.data) {
          this._personalFMNextTrack = undefined;
        } else {
          this._personalFMNextTrack = result.data[0];
        }
        this._personalFMNextLoading = false;
        if (this._personalFMNextTrack && this._isPersonalFM) {
          this._resetUpcoming();
          this._prefetchOrCacheNextTrack();
        }
        return [true, this._personalFMNextTrack];
      })
      .catch(() => {
        this._personalFMNextTrack = undefined;
        this._personalFMNextLoading = false;
        return [false, this._personalFMNextTrack];
      });
  }
  _playDiscordPresence(track, seekTime = 0) {
    if (
      process.env.IS_ELECTRON !== true ||
      store.state.settings.enableDiscordRichPresence === false
    ) {
      return null;
    }
    let copyTrack = { ...track };
    copyTrack.dt -= seekTime * 1000;
    ipcRenderer?.send('playDiscordPresence', copyTrack);
  }
  _pauseDiscordPresence(track) {
    if (
      process.env.IS_ELECTRON !== true ||
      store.state.settings.enableDiscordRichPresence === false
    ) {
      return null;
    }
    ipcRenderer?.send('pauseDiscordPresence', track);
  }
  _playNextTrack(isPersonal) {
    if (isPersonal) {
      this.playNextFMTrack();
    } else {
      this.playNextTrack();
    }
  }

  appendTrack(trackID) {
    this.list.append(trackID);
  }
  playNextTrack() {
    // TODO: 切换歌曲时增加加载中的状态
    const [trackID, index] = this._getNextTrack();
    if (trackID === undefined) {
      this._resetUpcoming();
      this._howler?.stop();
      this._engine?.clearAllSources();
      this._loadGen++;
      this._loadingTrack = false;
      this._playRequested = false;
      this._playbackToken++;
      this._setPlaying(false);
      return false;
    }
    let next = index;
    if (index === INDEX_IN_PLAY_NEXT) {
      this._playNextList.shift();
      next = this.current;
    }
    this.current = next;
    this._replaceCurrentTrack(trackID);
    return true;
  }
  async playNextFMTrack() {
    if (this._personalFMLoading) {
      return false;
    }

    this._isPersonalFM = true;
    if (!this._personalFMNextTrack) {
      this._personalFMLoading = true;
      let result = null;
      let retryCount = 5;
      for (; retryCount >= 0; retryCount--) {
        result = await personalFM().catch(() => null);
        if (!result) {
          this._personalFMLoading = false;
          store.dispatch('showToast', 'personal fm timeout');
          return false;
        }
        if (result.data?.length > 0) {
          break;
        } else if (retryCount > 0) {
          await delay(1000);
        }
      }
      this._personalFMLoading = false;

      if (retryCount < 0) {
        let content = '获取私人FM数据时重试次数过多，请手动切换下一首';
        store.dispatch('showToast', content);
        console.log(content);
        return false;
      }
      // 这里只能拿到一条数据
      this._personalFMTrack = result.data[0];
    } else {
      if (this._personalFMNextTrack.id === this._personalFMTrack.id) {
        return false;
      }
      this._personalFMTrack = this._personalFMNextTrack;
    }
    if (this._isPersonalFM) {
      this._replaceCurrentTrack(this._personalFMTrack.id);
    }
    this._loadPersonalFMNextTrack();
    return true;
  }
  playPrevTrack() {
    const [trackID, index] = this._getPrevTrack();
    if (trackID === undefined) return false;
    this.current = index;
    this._replaceCurrentTrack(
      trackID,
      true,
      UNPLAYABLE_CONDITION.PLAY_PREV_TRACK
    );
    return true;
  }
  _capturePlaybackState() {
    // 切歌下载期间元数据可能已经变化，但实际音源仍是上一首。
    const entry =
      this._audioMode === 'web-audio' ? this._engine?.current : null;
    const track = entry?.track ?? this._howlerTrack ?? this.currentTrack;
    const position = entry
      ? this._engine.position
      : this._howlerTrack &&
        this._howler &&
        (!this._howler.state || this._howler.state() === 'loaded')
      ? this._howler.seek()
      : track.id === this.currentTrackID
      ? this._progress
      : 0;
    return {
      trackID: track.id,
      position: Math.max(0, Number(position) || 0),
    };
  }
  saveSelfToLocalStorage() {
    // 同步音频边界，确保离开页面恰逢切曲时保存的是实际正在播放的曲目。
    if (this._audioMode === 'web-audio') this._engine?._onTick();
    const state = this._capturePlaybackState();
    let player = {};
    for (let [key, value] of Object.entries(this)) {
      if (excludeSaveKeys.includes(key)) continue;
      player[key] = value;
    }
    const track =
      this._audioMode === 'web-audio'
        ? this._engine?.current?.track
        : this._howlerTrack;
    if (track) player._currentTrack = track;
    // 用户点下一首时会先推进下标，再异步加载。退出于加载途中也必须对齐。
    const list = player._shuffle ? player._shuffledList : player._list;
    const indexKey = player._shuffle ? '_shuffledCurrent' : '_current';
    if (list[player[indexKey]] !== state.trackID) {
      const index = list.indexOf(state.trackID);
      if (index >= 0) player[indexKey] = index;
    }
    if (player._isPersonalFM) player._personalFMTrack = player._currentTrack;
    player._progress = state.position;
    player._playbackState = state;
    localStorage.setItem('player', JSON.stringify(player));
    localStorage.setItem('playerPlaybackState', JSON.stringify(state));
  }

  pause() {
    const token = ++this._playbackToken;
    this._playRequested = false;
    this._setPlaying(false);
    setTitle(null);
    this._pauseDiscordPresence(this._currentTrack);
    if (this._audioMode === 'web-audio' && this._engine?.ready) {
      this._configurePlayback();
      return this._engine.pause().catch(error => {
        if (token === this._playbackToken) {
          console.warn('[Player] Failed to pause audio', error);
        }
      });
    }

    const howler = this._howler;
    if (this.playPauseFadeDuration === 0) {
      howler?.pause();
      return;
    }
    howler?.once('fade', () => {
      if (token !== this._playbackToken || howler !== this._howler) return;
      howler.pause();
    });
    howler?.fade(howler.volume(), 0, PLAY_PAUSE_FADE_DURATION);
  }
  play() {
    const token = ++this._playbackToken;
    this._playRequested = true;
    // 加载结束会按照最新的播放意图启动，避免恢复正在被替换的旧曲。
    if (this._loadingTrack) return;
    if (this._audioMode === 'web-audio' && this._engine?.ready) {
      this._configurePlayback();
      return this._engine
        .resume()
        .then(resumed => {
          if (resumed === false || token !== this._playbackToken) return;
          // 播放时确保开启player.
          // 避免因"忘记设置"导致在播放时播放器不显示的Bug
          this._enabled = true;
          this._setPlaying(true);
          if (this._currentTrack.name) {
            setTitle(this._currentTrack);
          }
          this._playDiscordPresence(this._currentTrack, this.seek());
          this._updateNowPlaying();
        })
        .catch(error => {
          if (token !== this._playbackToken) return;
          this._playRequested = false;
          this._setPlaying(false);
          console.warn('[Player] Failed to resume audio', error);
        });
    }

    const howler = this._howler;
    if (!howler) {
      // 启动时离线/取源失败后，播放按钮应能重试原曲和已保存的位置。
      if (this._enabled && this.currentTrackID)
        return this._replaceCurrentTrack(this.currentTrackID, true, null, {
          seek: this._progress,
        });
      return;
    }
    const updatePlaying = () => {
      if (token !== this._playbackToken || howler !== this._howler) return;
      if (this.playPauseFadeDuration > 0) {
        howler.fade(howler.volume(), this.volume, this.playPauseFadeDuration);
      } else {
        howler.volume(this.volume);
      }

      // 播放时确保开启player.
      // 避免因"忘记设置"导致在播放时播放器不显示的Bug
      this._enabled = true;
      this._setPlaying(true);
      if (this._currentTrack.name) {
        setTitle(this._currentTrack);
      }
      this._playDiscordPresence(this._currentTrack, this.seek());
      this._updateNowPlaying();
    };
    if (howler.playing()) {
      updatePlaying();
    } else {
      howler.once('play', updatePlaying);
      howler.play();
    }
  }
  playOrPause() {
    if (this._playRequested) {
      this.pause();
    } else {
      this.play();
    }
  }
  seek(time = null, sendMpris = true) {
    if (isCreateMpris && sendMpris && time !== null) {
      ipcRenderer?.send('seeked', time);
    }
    if (time !== null) {
      if (this._audioMode === 'web-audio' && this._engine?.ready) {
        // seek 会让已排程的下一首失效，随后重新预取
        this._resetUpcoming();
        const loadGen = this._loadGen;
        this._engine
          .seek(time)
          .then(seeked => {
            if (seeked && loadGen === this._loadGen) this._prefetchNextTrack();
          })
          .catch(error => console.warn('[Player] Failed to seek audio', error));
      } else {
        this._howler?.seek(time);
      }
      this._progress = Math.max(0, Number(time) || 0);
      if (this._playing) {
        this._playDiscordPresence(this._currentTrack, time);
      }
    }
    if (this._audioMode === 'web-audio') {
      return this._engine?.position ?? 0;
    }
    return this._howler === null ? 0 : this._howler.seek();
  }
  mute() {
    if (this.volume === 0) {
      this.volume = this._volumeBeforeMuted;
    } else {
      this._volumeBeforeMuted = this.volume;
      this.volume = 0;
    }
  }
  setOutputDevice() {
    const deviceId = store.state.settings.outputDevice;
    if (this._audioMode === 'web-audio') {
      // 未就绪时 setOutputDevice 只记录设备，创建输出链时再生效
      this._engine?.setOutputDevice(deviceId);
      if (this._engine?.ready) return;
    }
    if (this._howler?._sounds.length <= 0 || !this._howler?._sounds[0]._node) {
      return;
    }
    this._howler?._sounds[0]._node.setSinkId(deviceId);
  }

  replacePlaylist(
    trackIDs,
    playlistSourceID,
    playlistSourceType,
    autoPlayTrackID = 'first'
  ) {
    this._isPersonalFM = false;
    this.list = trackIDs;
    this.current = 0;
    this._playlistSource = {
      type: playlistSourceType,
      id: playlistSourceID,
    };
    if (this.shuffle) this._shuffleTheList(autoPlayTrackID);
    if (autoPlayTrackID === 'first') {
      this._replaceCurrentTrack(this.list[0]);
    } else {
      this.current = this.list.indexOf(autoPlayTrackID);
      this._replaceCurrentTrack(autoPlayTrackID);
    }
  }
  playAlbumByID(id, trackID = 'first') {
    getAlbum(id).then(data => {
      let trackIDs = data.songs.map(t => t.id);
      this.replacePlaylist(trackIDs, id, 'album', trackID);
    });
  }
  playPlaylistByID(id, trackID = 'first', noCache = false) {
    console.debug(
      `[debug][Player.js] playPlaylistByID 👉 id:${id} trackID:${trackID} noCache:${noCache}`
    );
    getPlaylistDetail(id, noCache).then(data => {
      let trackIDs = data.playlist.trackIds.map(t => t.id);
      this.replacePlaylist(trackIDs, id, 'playlist', trackID);
    });
  }
  playArtistByID(id, trackID = 'first') {
    getArtist(id).then(data => {
      let trackIDs = data.hotSongs.map(t => t.id);
      this.replacePlaylist(trackIDs, id, 'artist', trackID);
    });
  }
  playTrackOnListByID(id, listName = 'default') {
    if (listName === 'default') {
      this._current = this._list.findIndex(t => t === id);
    }
    this._replaceCurrentTrack(id);
  }
  playIntelligenceListById(id, trackID = 'first', noCache = false) {
    getPlaylistDetail(id, noCache).then(data => {
      const randomId = Math.floor(
        Math.random() * (data.playlist.trackIds.length + 1)
      );
      const songId = data.playlist.trackIds[randomId].id;
      intelligencePlaylist({ id: songId, pid: id }).then(result => {
        let trackIDs = result.data.map(t => t.id);
        this.replacePlaylist(trackIDs, id, 'playlist', trackID);
      });
    });
  }
  addTrackToPlayNext(trackID, playNow = false) {
    this._playNextList.push(trackID);
    if (playNow) {
      this.playNextTrack();
    } else {
      this._refreshUpcoming();
    }
  }
  playPersonalFM() {
    this._isPersonalFM = true;
    if (this.currentTrackID !== this._personalFMTrack.id) {
      this._replaceCurrentTrack(this._personalFMTrack.id, true);
    } else {
      this.playOrPause();
    }
  }
  async moveToFMTrash() {
    this._isPersonalFM = true;
    let id = this._personalFMTrack.id;
    if (await this.playNextFMTrack()) {
      fmTrash(id);
    }
  }

  sendSelfToIpcMain() {
    if (process.env.IS_ELECTRON !== true) return false;
    let liked = store.state.liked.songs.includes(this.currentTrack.id);
    ipcRenderer?.send('player', {
      playing: this.playing,
      likedCurrentTrack: liked,
    });
    setTrayLikeState(liked);
  }

  switchRepeatMode() {
    if (this._repeatMode === 'on') {
      this.repeatMode = 'one';
    } else if (this._repeatMode === 'one') {
      this.repeatMode = 'off';
    } else {
      this.repeatMode = 'on';
    }
    if (isCreateMpris) {
      ipcRenderer?.send('switchRepeatMode', this.repeatMode);
    }
  }
  switchShuffle() {
    this.shuffle = !this.shuffle;
    if (isCreateMpris) {
      ipcRenderer?.send('switchShuffle', this.shuffle);
    }
  }
  switchReversed() {
    this.reversed = !this.reversed;
  }

  clearPlayNextList() {
    this._playNextList = [];
    this._refreshUpcoming();
  }
  removeTrackFromQueue(index) {
    this._playNextList.splice(index, 1);
    this._refreshUpcoming();
  }
}
