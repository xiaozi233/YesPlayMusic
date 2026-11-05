/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

// Launch through Node so Electron stdout and its exit status are reliable on
// Windows as well as Linux/macOS. The test window never becomes visible.
if (!process.versions.electron) {
  const { spawn } = require('child_process');
  const child = spawn(require('electron'), [__filename], {
    windowsHide: true,
    stdio: 'inherit',
  });
  child.on('error', error => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on('exit', code => {
    process.exitCode = code === null ? 1 : code;
  });
} else {
  const { app, BrowserWindow } = require('electron');
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  const timeout = setTimeout(() => {
    console.error('Native audio verification timed out');
    app.exit(1);
  }, 30000);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    try {
      await win.loadURL('about:blank');
      const source = fs.readFileSync(
        path.resolve(__dirname, '../src/utils/AudioEngine.js'),
        'utf8'
      );
      const mp3 = fs
        .readFileSync(path.resolve(__dirname, 'fixtures/gapless-tone.mp3'))
        .toString('base64');
      const result = await win.webContents.executeJavaScript(
        `(${verifyAudio.toString()})(${JSON.stringify(
          source
        )}, ${JSON.stringify(mp3)})`
      );
      console.log(JSON.stringify(result, null, 2));
      clearTimeout(timeout);
      app.exit(0);
    } catch (error) {
      console.error(error);
      clearTimeout(timeout);
      app.exit(1);
    }
  });
}

async function verifyAudio(source, mp3) {
  const AudioEngine = new Function(
    source.replace('export default class AudioEngine', 'class AudioEngine') +
      '; return AudioEngine;'
  )();
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const results = [];
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  // This fixture has exactly 48000 content samples, including intentional
  // silence. Chromium reads its Xing/LAME delay/padding metadata itself.
  const mp3Context = new OfflineAudioContext(2, 48000, 48000);
  const mp3Engine = new AudioEngine();
  mp3Engine.ctx = mp3Context;
  const mp3Bytes = Uint8Array.from(atob(mp3), char =>
    char.charCodeAt(0)
  ).buffer;
  const mp3Buffer = await mp3Engine.prepare({ id: 'tagged-mp3' }, mp3Bytes);
  assert(
    mp3Buffer.length === 48000,
    `Tagged MP3 changed length: ${mp3Buffer.length}`
  );
  clearInterval(mp3Engine._tickTimer);
  results.push({ taggedMp3ContentSamples: mp3Buffer.length, expected: 48000 });

  for (const sampleRate of [44100, 48000]) {
    const length = 4096;
    const expected = [
      new Float32Array(length * 2),
      new Float32Array(length * 2),
    ];
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < length * 2; i++) {
        expected[c][i] =
          i < 1000 || i >= length * 2 - 1000
            ? 0
            : Math.round(
                16000 *
                  Math.sin(
                    (2 * Math.PI * (997 + c * 103) * (i + 0.25)) / sampleRate
                  )
              ) / 32768;
      }
    }
    const wav = start => {
      const bytes = new ArrayBuffer(44 + length * 8);
      const view = new DataView(bytes);
      const ascii = (offset, text) => {
        for (let i = 0; i < text.length; i++)
          view.setUint8(offset + i, text.charCodeAt(i));
      };
      ascii(0, 'RIFF');
      view.setUint32(4, bytes.byteLength - 8, true);
      ascii(8, 'WAVE');
      ascii(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 3, true);
      view.setUint16(22, 2, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 8, true);
      view.setUint16(32, 8, true);
      view.setUint16(34, 32, true);
      ascii(36, 'data');
      view.setUint32(40, length * 8, true);
      for (let i = 0; i < length; i++)
        for (let c = 0; c < 2; c++)
          view.setFloat32(44 + i * 8 + c * 4, expected[c][start + i], true);
      return bytes;
    };
    const context = new OfflineAudioContext(
      2,
      Math.round(sampleRate * 0.12) + length * 2 + 128,
      sampleRate
    );
    const engine = new AudioEngine();
    engine.ctx = context;
    engine.gain = context.createGain();
    engine.gain.connect(context.destination);
    // Offline contexts have their own render lifecycle; retain actual engine
    // decoding and BufferSource scheduling without calling real-time resume.
    context.resume = async () => {};
    const first = await engine.prepare({ id: 1 }, wav(0));
    const second = await engine.prepare({ id: 2 }, wav(length));
    assert(
      first.length === length && second.length === length,
      'PCM length changed'
    );
    await engine.loadAndPlay({ id: 1 }, { buffer: first });
    engine.enqueue({ id: 2 }, second);
    const errorSamples =
      (engine.upcoming.startAt - (engine.current.startAt + first.duration)) *
      sampleRate;
    const start = Math.round(engine.current.startAt * sampleRate);
    const output = await context.startRendering();
    let maxError = 0;
    for (let c = 0; c < 2; c++) {
      const actual = output.getChannelData(c);
      for (let i = 0; i < length * 2; i++)
        maxError = Math.max(
          maxError,
          Math.abs(actual[start + i] - expected[c][i])
        );
    }
    assert(
      Math.abs(errorSamples) < 1e-7,
      'Track boundary has a scheduling gap'
    );
    assert(maxError < 1e-6, `Rendered samples differ: ${maxError}`);
    clearInterval(engine._tickTimer);
    results.push({
      sampleRate,
      schedulingErrorSamples: errorSamples,
      maxSampleError: maxError,
      preservedSilenceSamples: 2000,
    });
  }

  const engine = new AudioEngine();
  engine._ensureContext();
  const context = engine.ctx;
  const first = context.createBuffer(
    2,
    context.sampleRate * 10,
    context.sampleRate
  );
  const second = context.createBuffer(
    2,
    context.sampleRate,
    context.sampleRate
  );
  for (let c = 0; c < 2; c++) {
    const samples = first.getChannelData(c);
    for (let i = 0; i < samples.length; i++)
      samples[i] = 0.4 * Math.sin((2 * Math.PI * 997 * i) / context.sampleRate);
  }
  assert(
    engine.sink === null && engine.streamDestination === null,
    'Default output must bypass MediaStream and HTMLAudioElement'
  );
  // Test-only recording tap. The engine itself uses the AudioContext's single
  // hardware clock; suppress the speaker branch without muting the recording.
  const recording = context.createMediaStreamDestination();
  const silent = context.createGain();
  silent.gain.value = 0;
  engine.gain.disconnect(context.destination);
  engine.gain.connect(silent);
  silent.connect(context.destination);
  engine.gain.connect(recording);
  const chunks = [];
  const recorder = new MediaRecorder(recording.stream);
  recorder.ondataavailable = event => chunks.push(event.data);
  const recorded = new Promise(resolve => {
    recorder.onstop = async () => {
      resolve(await new Blob(chunks).arrayBuffer());
    };
  });
  try {
    assert(
      await engine.loadAndPlay({ id: 1 }, { buffer: first }),
      'Live load failed'
    );
    engine.enqueue({ id: 2 }, second);
    engine.fadeDuration = 0.2;
    const pausing = engine.pause();
    await engine.resume();
    assert((await pausing) === false, 'Cancelled pause was applied');
    assert(context.state === 'running' && engine.playing, 'Live resume failed');
    engine.fadeDuration = 0;
    recorder.start();
    await delay(500);
    const clockStart = context.getOutputTimestamp();
    await engine.pause();
    const pausedClock = context.currentTime;
    const pausedAt = engine.position;
    await delay(750);
    assert(
      context.currentTime > pausedClock + 0.5 && engine.position === pausedAt,
      'Pause must freeze the position while the output clock keeps running'
    );
    assert(
      engine.upcoming?.buffer === second &&
        engine.current.source === null &&
        engine.upcoming.source === null,
      'Pause must retain buffers without running sources'
    );
    await engine.resume();
    assert(
      Math.abs(
        engine.upcoming.startAt -
          (engine.current.startAt + first.duration - pausedAt)
      ) < 1e-7,
      'Resume must reschedule the next track after the remaining duration'
    );
    for (let i = 0; i < 3; i++) {
      await delay(500);
      await engine.pause();
      const position = engine.position;
      await delay(400);
      assert(engine.position === position, 'Paused position drifted');
      await engine.resume();
      assert(
        engine.current.source.playbackRate.value === 1 && engine.sink === null,
        'Resume changed playbackRate'
      );
    }
    await delay(500);
    recorder.stop();
    const clockEnd = context.getOutputTimestamp();
    const hardwareClockRatio =
      ((clockEnd.contextTime - clockStart.contextTime) * 1000) /
      (clockEnd.performanceTime - clockStart.performanceTime);
    assert(
      hardwareClockRatio > 0.98 && hardwareClockRatio < 1.02,
      `Audio output clock rate drifted: ${hardwareClockRatio}`
    );
    const captured = await context.decodeAudioData(await recorded);
    const samples = captured.getChannelData(0);
    const frequencies = [];
    for (let start = 0; start + 2048 < samples.length; start += 2048) {
      const energies = new Float64Array(8);
      const crossings = [];
      for (let i = start + 1; i < start + 2048; i++) {
        energies[Math.floor((i - start) / 256)] += samples[i] ** 2;
        if (samples[i - 1] < 0 && samples[i] >= 0)
          crossings.push(i - samples[i] / (samples[i] - samples[i - 1]));
      }
      // Ignore silence and pause/resume edges; inspect sustained output.
      // Opus rings around abrupt silence edges. Require a sustained tone in
      // every 256-sample section so that noise crossings in silence cannot
      // masquerade as a playback speed change.
      if (energies.some(energy => energy / 256 < 0.04) || crossings.length < 20)
        continue;
      const frequency =
        ((crossings.length - 1) * captured.sampleRate) /
        (crossings[crossings.length - 1] - crossings[0]);
      frequencies.push(frequency);
    }
    assert(
      frequencies.length > 30,
      'No sustained tone captured in output stream'
    );
    const minFrequency = Math.min(...frequencies);
    const maxFrequency = Math.max(...frequencies);
    assert(
      minFrequency > 992 && maxFrequency < 1002,
      `Resume changed the output stream tone: ${minFrequency}..${maxFrequency} Hz`
    );
    await engine.pause();
    await engine.seek(0.4);
    assert(
      context.state === 'running' &&
        engine.position === 0.4 &&
        engine.current.source === null,
      'Paused seek changed playback state'
    );
    await engine.resume();
    assert(context.state === 'running', 'Seek prevented resume');
    results.push({
      realtime:
        'pause/resume race, stable position, running output clock, rescheduling and paused seek passed',
      output: 'AudioContext.destination (no MediaStream sink)',
      streamToneHz: { min: minFrequency, max: maxFrequency, expected: 997 },
      analyzedBlocks: frequencies.length,
      hardwareClockRatio,
    });
  } finally {
    if (recorder.state !== 'inactive') recorder.stop();
    silent.disconnect();
    engine.dispose();
  }

  // Exercise the actual legacy Chromium bridge lifecycle using the system
  // default device as the test target. Only the device ID is substituted;
  // the HTMLAudioElement, MediaStream, playback and track teardown are real.
  const BrowserAudio = window.Audio;
  window.Audio = function () {
    const sink = new BrowserAudio();
    const setSinkId = sink.setSinkId.bind(sink);
    sink.setSinkId = id => setSinkId(id === 'test-output' ? '' : id);
    return sink;
  };
  const custom = new AudioEngine();
  custom.setVolume(0);
  try {
    await custom.setOutputDevice('test-output');
    custom._ensureContext();
    const buffer = custom.ctx.createBuffer(
      2,
      custom.ctx.sampleRate * 2,
      custom.ctx.sampleRate
    );
    await custom.loadAndPlay({ id: 'bridge' }, { buffer });
    assert(custom.sink !== null, 'Real custom output bridge did not start');
    for (let i = 0; i < 3; i++) {
      const sink = custom.sink;
      const stream = custom.streamDestination.stream;
      await custom.pause();
      assert(
        sink.paused && sink.srcObject === null,
        'Old sink retained queued audio'
      );
      assert(
        stream.getTracks().every(track => track.readyState === 'ended'),
        'Old output stream was not stopped'
      );
      await delay(80);
      await custom.resume();
      assert(
        custom.sink !== sink && custom.sink.playbackRate === 1,
        'Resume reused the old live consumer'
      );
    }
    await custom.setOutputDevice('default');
    assert(
      custom.sink === null && custom._directOutput,
      'Default device did not restore direct output'
    );
    results.push({
      customOutput:
        '3 real pause/resume cycles discarded old streams and consumers; returned to direct output',
    });
  } finally {
    custom.dispose();
    window.Audio = BrowserAudio;
  }
  return {
    chromium: process.versions.chrome,
    electron: process.versions.electron,
    results,
  };
}
