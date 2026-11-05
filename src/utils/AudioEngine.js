/**
 * 无缝播放引擎
 *
 * 设计要点（为什么这样做）：
 * 1. 全应用只维护一个 AudioContext，切歌时只 stop 旧的 BufferSource，
 *    不重建解码器 / 输出管线，否则每次切换都会插入静音。
 * 2. 播放时间的唯一真源是 ctx.currentTime。下一首用绝对时刻
 *    `source.start(当前曲结束时刻)` 预约，Chromium 会在采样级接上。
 * 3. 默认设备直接连接 AudioContext.destination，只有一个输出时钟，
 *    不经过 MediaStream 的实时流缓冲与追赶机制。
 * 4. Chromium 91 的指定输出设备需要 <audio>.setSinkId() 桥接。
 *    暂停时释放桥，恢复时新建，避免旧实时流积压后被加速消费。
 *
 * 该文件不感知曲目数据来源，只负责解码与排程。
 */

const LOOKAHEAD = 0.01; // 仅为首次启动/手动切歌预留 10ms；自然衔接仍精确排程
const TICK_INTERVAL = 50; // 边界推进轮询间隔（ms）

const delay = ms =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

function createEngineError(code, track, cause) {
  const error = new Error(code);
  error.code = code;
  error.track = track;
  error.cause = cause;
  return error;
}

function isAudioBuffer(data) {
  return (
    data != null &&
    typeof data === 'object' &&
    typeof data.duration === 'number' &&
    typeof data.length === 'number' &&
    typeof data.getChannelData === 'function'
  );
}

export default class AudioEngine {
  /**
   * @param {Object} options
   * @param {(track: Object) => void} [options.onTrackStart]
   * @param {(reason: string) => void} [options.onGap]
   */
  constructor({ onTrackStart, onGap } = {}) {
    this.onTrackStart = onTrackStart;
    this.onGap = onGap;

    this.ctx = null;
    this.gain = null;
    this.streamDestination = null;
    this.sink = null;
    this._outputReady = Promise.resolve();
    this._outputToken = 0;
    this._directOutput = false;

    this.current = null; // { track, buffer, source, startAt, offset }
    this.upcoming = null; // { track, buffer, source, startAt }
    this.cursor = 0; // 已排程内容的结束时刻（ctx 时间轴）

    this.volume = 1;
    this.fadeDuration = 0; // 可选的暂停/继续淡变（秒），默认直接暂停/继续
    this.playing = false;
    this.outputDevice = 'default';

    this._gen = 0; // 代际号：异步解码回来时用于丢弃过期请求
    this._pauseToken = 0;
    this._gapReported = false;
    this._shouldBePlaying = false;
    this._gestureBound = false;
    this._gestureUnlock = null;
    this._tickTimer = setInterval(() => this._onTick(), TICK_INTERVAL);
  }

  get ready() {
    return this.ctx !== null && this.current !== null;
  }

  get currentBuffer() {
    return this.current?.buffer ?? null;
  }

  /** 暂停时返回保存的 offset，输出设备和 context 的时钟仍持续运行。 */
  get position() {
    if (!this.current || !this.ctx) return 0;
    if (!this.current.source) return this.current.offset;
    const elapsed = this.ctx.currentTime - this.current.startAt;
    const position = this.current.offset + Math.max(0, elapsed);
    return Math.min(this.current.buffer.duration, Math.max(0, position));
  }

  get duration() {
    return this.current?.buffer?.duration ?? 0;
  }

  _ensureContext() {
    if (this.ctx) return this.ctx;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      throw createEngineError('NO_AUDIO_CONTEXT');
    }
    try {
      this.ctx = new AudioContextClass({ latencyHint: 'interactive' });
    } catch (error) {
      // 老版本浏览器不接受 options 参数
      this.ctx = new AudioContextClass();
    }
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(this.ctx.destination);
    this._directOutput = true;
    this._bindGestureUnlock();
    return this.ctx;
  }

  /**
   * Chromium 的自动播放策略会让「非用户手势」里创建的 AudioContext 停在
   * suspended。用户点歌 → 异步取数据 → 创建 context 时手势已经过期。
   * 这里监听用户交互补一次 resume，避免“界面在播放但没有声音”。
   */
  _bindGestureUnlock() {
    if (this._gestureBound) return;
    this._gestureBound = true;
    const unlock = () => {
      if (this._shouldBePlaying && this.ctx?.state === 'suspended') {
        this.resume().catch(error => {
          console.warn('[AudioEngine] Failed to unlock audio', error);
        });
      }
    };
    this._gestureUnlock = unlock;
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);
  }

  async _ensureSinkPlaying() {
    // 指定设备的桥只在真正恢复播放时创建，不在暂停期间积累静音。
    if (this.outputDevice !== 'default' && !this.sink)
      this.setOutputDevice(this.outputDevice);
    await this._outputReady;
    const sink = this.sink;
    if (!sink || !sink.paused) return;
    try {
      await sink.play();
    } catch (error) {
      if (sink !== this.sink) return;
      // MediaStream 播放被拒绝时退回直连输出，至少保证有声音
      console.warn(
        '[AudioEngine] MediaStream sink failed, fallback to destination',
        error
      );
      this._releaseOutputBridge();
    }
  }

  _releaseOutputBridge() {
    this._outputToken++;
    const sink = this.sink;
    const destination = this.streamDestination;
    this.sink = null;
    this.streamDestination = null;
    if (sink) {
      sink.pause();
      sink.srcObject = null;
    }
    if (destination) {
      if (!this._directOutput) this.gain.disconnect(destination);
      destination.stream.getTracks().forEach(track => track.stop());
    }
    if (this.ctx && !this._directOutput) {
      this.gain.connect(this.ctx.destination);
      this._directOutput = true;
    }
  }

  /**
   * 解码音频数据。ArrayBuffer 会被 decodeAudioData detach，
   * 所以先 slice(0) 复制，保证调用方手里的数据还能复用。
   * @param {Object} track
   * @param {AudioBuffer|ArrayBuffer|ArrayBufferView} data
   * @returns {Promise<AudioBuffer>}
   */
  async prepare(track, data) {
    if (isAudioBuffer(data)) return data;
    if (!data) throw createEngineError('NO_DATA', track);
    this._ensureContext();

    let arrayBuffer = data;
    if (!(data instanceof ArrayBuffer)) {
      if (ArrayBuffer.isView(data)) {
        arrayBuffer = data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength
        );
      } else if (data.buffer instanceof ArrayBuffer) {
        arrayBuffer = data.buffer;
      } else {
        throw createEngineError('FETCH_FAILED', track);
      }
    }
    const copy = arrayBuffer.slice(0);

    let decoded;
    try {
      decoded = await new Promise((resolve, reject) => {
        this.ctx.decodeAudioData(copy, resolve, reject);
      });
    } catch (error) {
      throw createEngineError('DECODE_FAILED', track, error);
    }
    // 数字静音也可能是音乐内容。保留解码器给出的有效样本，不能按波形猜测填充。
    return decoded;
  }

  /**
   * 立即播放一首（会清空当前与已排程的下一首）。
   * @param {Object} track
   * @param {{ buffer?: AudioBuffer, seek?: number, autoplay?: boolean }} options
   */
  async loadAndPlay(track, { buffer, seek = 0, autoplay = true } = {}) {
    this._ensureContext();
    this.clearAllSources();
    const gen = this._gen;

    const audioBuffer = buffer ?? (await this.prepare(track));
    if (gen !== this._gen) return false; // 期间用户又切歌了

    const offset = Math.max(
      0,
      Math.min(seek, Math.max(0, audioBuffer.duration - 0.01))
    );
    this.current = {
      track,
      buffer: audioBuffer,
      source: null,
      startAt: this.ctx.currentTime,
      offset,
    };
    this.cursor = this.current.startAt + (audioBuffer.duration - offset);
    this._gapReported = false;
    this._shouldBePlaying = autoplay;

    if (autoplay) {
      await this.resume();
    } else {
      // 冷启动恢复只保存位置，不启动音源，不挂起仍被输出桥消费的时钟。
      const now = this.ctx.currentTime;
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setValueAtTime(0, now);
      this.playing = false;
    }
    return gen === this._gen;
  }

  /**
   * 把下一首排到当前曲结束的精确时刻。
   * 暂停时仅保留 buffer，恢复时根据保存的位置重新排程。
   */
  enqueue(track, buffer) {
    if (!this.ctx || !this.current || !buffer) return false;
    if (this.upcoming) this.clearUpcoming();

    const startAt = this.cursor;
    this.upcoming = { track, buffer, source: null, startAt, offset: 0 };
    if (this.current.source) this._startSource(this.upcoming, startAt);
    this.cursor = startAt + buffer.duration;
    this._gapReported = false;
    return true;
  }

  clearUpcoming() {
    if (this.upcoming) {
      this._stopSource(this.upcoming);
      this.upcoming = null;
    }
    this.cursor = this.current
      ? this.current.startAt +
        (this.current.buffer.duration - this.current.offset)
      : 0;
  }

  clearAllSources() {
    this._gen++;
    this._pauseToken++;
    this._shouldBePlaying = false;
    this.playing = false;
    this.clearUpcoming();
    if (this.current) {
      this._stopSource(this.current);
      this.current = null;
    }
    this.cursor = 0;
    this._gapReported = false;
  }

  async pause() {
    if (!this.ctx) return false;
    const token = ++this._pauseToken;
    const gen = this._gen;
    this._shouldBePlaying = false;
    const now = this.ctx.currentTime;
    const gain = this.gain.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    const duration = this.playing ? this.fadeDuration : 0;
    if (duration > 0) gain.linearRampToValueAtTime(0, now + duration);
    else gain.setValueAtTime(0, now);

    if (duration > 0) await delay(duration * 1000);
    if (token !== this._pauseToken || gen !== this._gen) return false;
    // 淡出期间可能跨过曲目边界，先同步实际正在播放的曲目再保存位置。
    this._promoteUpcoming();
    if (token !== this._pauseToken || gen !== this._gen) return false;
    if (this.current) {
      const position = this.position;
      this._stopSource(this.current);
      this.current.offset = position;
    }
    this._stopSource(this.upcoming);
    this.playing = false;
    this._releaseOutputBridge();
    return true;
  }

  async resume() {
    if (!this.ctx || !this.current) return false;
    const token = ++this._pauseToken;
    const gen = this._gen;
    this._shouldBePlaying = true;
    await this._ensureSinkPlaying();
    if (token !== this._pauseToken || gen !== this._gen) return false;
    await this.ctx.resume();
    if (token !== this._pauseToken || gen !== this._gen) return false;
    const now = this.ctx.currentTime;
    if (!this.current.source) {
      this._startSource(this.current, now + LOOKAHEAD);
      this.cursor =
        this.current.startAt +
        this.current.buffer.duration -
        this.current.offset;
      if (this.upcoming) {
        this._startSource(this.upcoming, this.cursor);
        this.cursor += this.upcoming.buffer.duration;
      }
    }
    const gain = this.gain.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    if (this.fadeDuration > 0) {
      gain.linearRampToValueAtTime(this.volume, now + this.fadeDuration);
    } else {
      gain.setValueAtTime(this.volume, now);
    }
    this.playing = true;
    return true;
  }

  setVolume(volume) {
    this.volume = volume;
    if (!this.gain) return;
    if (!this.playing || !this._shouldBePlaying) return;
    const now = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(volume, now);
  }

  /** 重排当前曲。暂停状态会被保留。 */
  async seek(seconds) {
    if (!this.current) return false;
    const { track, buffer } = this.current;
    const shouldPlay = this._shouldBePlaying;
    return this.loadAndPlay(track, {
      buffer,
      seek: seconds,
      autoplay: shouldPlay,
    });
  }

  setOutputDevice(deviceId) {
    this.outputDevice = deviceId || 'default';
    if (!this.ctx) return Promise.resolve();
    this._releaseOutputBridge();
    // 默认设备保持直连。暂停时只记录选择，桥在 resume 时才创建。
    if (this.outputDevice === 'default' || !this._shouldBePlaying) {
      this._outputReady = Promise.resolve();
      return this._outputReady;
    }
    const token = this._outputToken;
    this._outputReady = this._createOutputBridge(this.outputDevice, token);
    return this._outputReady;
  }

  async _createOutputBridge(deviceId, token) {
    if (typeof this.ctx.createMediaStreamDestination !== 'function') return;
    const sink = new Audio();
    if (typeof sink.setSinkId !== 'function') return;
    const destination = this.ctx.createMediaStreamDestination();
    sink.srcObject = destination.stream;
    sink.autoplay = false;
    sink.playbackRate = 1;
    this.sink = sink;
    this.streamDestination = destination;
    try {
      await sink.setSinkId(deviceId);
      if (token !== this._outputToken || sink !== this.sink) return;
      if (this._shouldBePlaying) await sink.play();
      if (token !== this._outputToken || sink !== this.sink) return;
      this.gain.disconnect(this.ctx.destination);
      this._directOutput = false;
      this.gain.connect(destination);
    } catch (error) {
      if (token !== this._outputToken || sink !== this.sink) return;
      console.warn(
        '[AudioEngine] setSinkId failed, using default output',
        error
      );
      this._releaseOutputBridge();
    }
  }

  _startSource(entry, startAt) {
    const source = this.ctx.createBufferSource();
    source.buffer = entry.buffer;
    source.playbackRate.value = 1;
    source.connect(this.gain);
    source.start(startAt, entry.offset);
    entry.source = source;
    entry.startAt = startAt;
  }

  _stopSource(entry) {
    if (!entry?.source) return;
    try {
      entry.source.stop();
      entry.source.disconnect();
    } catch (error) {
      // 已结束的 source 也应释放引用。
    }
    entry.source = null;
  }

  _promoteUpcoming() {
    if (
      this.upcoming?.source &&
      this.ctx.currentTime >= this.upcoming.startAt
    ) {
      const promoted = this.upcoming;
      this._stopSource(this.current);
      this.upcoming = null;
      this.current = promoted;
      this._gapReported = false;
      this.onTrackStart?.(promoted.track);
      return true;
    }
    return false;
  }

  _onTick() {
    if (!this.ctx || this.ctx.state !== 'running' || !this.playing) return;
    const now = this.ctx.currentTime;

    if (this._promoteUpcoming()) return;

    // 当前曲已结束且没有排程下一首 —— 交给 Player 决定是否走旧路径
    if (
      this.current &&
      !this.upcoming &&
      this._shouldBePlaying &&
      now >= this.cursor &&
      !this._gapReported
    ) {
      this._gapReported = true;
      this.playing = false;
      this.onGap?.('no-upcoming');
    }
  }

  dispose() {
    clearInterval(this._tickTimer);
    this.clearAllSources();
    if (this._gestureUnlock) {
      document.removeEventListener('pointerdown', this._gestureUnlock, true);
      document.removeEventListener('keydown', this._gestureUnlock, true);
      this._gestureUnlock = null;
      this._gestureBound = false;
    }
    this._releaseOutputBridge();
    if (this.ctx && typeof this.ctx.close === 'function') {
      this.ctx.close().catch(() => {});
    }
    this.ctx = null;
    this.gain = null;
    this.streamDestination = null;
  }
}
