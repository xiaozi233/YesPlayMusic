# Gapless audio fixture

`gapless-tone.mp3` is a synthetic stereo tone at 48 kHz, lasting exactly one
second (48000 content samples), with 30 ms of intentional silence at each end.
It contains Xing/LAME encoder delay and padding metadata. No copyrighted audio
is used.

Generated with FFmpeg and libmp3lame:

```sh
ffmpeg -f lavfi -i 'aevalsrc=if(between(t\,0.03\,0.97)\,0.4*sin(2*PI*997*t)\,0):s=48000:d=1' -ac 2 -c:a libmp3lame -q:a 2 gapless-tone.mp3
```

The Electron test verifies that Chromium's decoder returns the original content
length and that the engine does not apply a second, waveform-based crop. The WAV
fixtures are generated in memory and compared sample by sample after decoding
and scheduling through the actual engine.
