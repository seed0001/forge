/**
 * Continuous mic capture with a simple energy-based voice-activity detector.
 * Emits one Float32Array per spoken utterance, resampled to 16 kHz mono for
 * Whisper. No push-to-talk, no worklet files, no extra dependencies — good
 * enough for a quiet room with a decent mic; a Silero-VAD swap can come later.
 */

export type VadState = 'calibrating' | 'listening' | 'speaking';

export interface VoiceCaptureHandlers {
  onState?: (s: VadState) => void;
  onLevel?: (rms01: number) => void;
  /** Fired when an utterance completes. `audio` is mono Float32 @ 16 kHz. */
  onUtterance: (audio: Float32Array) => void;
  onError?: (message: string) => void;
}

export interface VoiceCaptureOptions {
  /** Trailing silence that ends an utterance (ms). */
  silenceMs?: number;
  /** Voiced audio needed before we latch onto speech (ms). */
  startMs?: number;
  /** Hard cap on one utterance (s). */
  maxUtteranceS?: number;
  /** Multiplier over the measured noise floor to count as speech. */
  factor?: number;
  /** Absolute floor so a dead-silent room can't set the bar at ~0. */
  absMin?: number;
}

const TARGET_RATE = 16000;

function downsample(input: Float32Array, inRate: number, outRate = TARGET_RATE): Float32Array {
  if (inRate === outRate) return input;
  const ratio = inRate / outRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(end - start, 1);
  }
  return out;
}

export interface VoiceCaptureHandle {
  stop: () => void;
  /** Suppress capture (e.g. while the assistant is speaking) without tearing down the mic. */
  setMuted: (muted: boolean) => void;
}

export async function startVoiceCapture(
  handlers: VoiceCaptureHandlers,
  opts: VoiceCaptureOptions = {}
): Promise<VoiceCaptureHandle> {
  const silenceMs = opts.silenceMs ?? 850;
  const startMs = opts.startMs ?? 160;
  const maxUtteranceS = opts.maxUtteranceS ?? 40;
  const factor = opts.factor ?? 3.2;
  const absMin = opts.absMin ?? 0.008;

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    handlers.onError?.(`Microphone unavailable: ${String(e)}`);
    return { stop: () => {}, setMuted: () => {} };
  }

  const ctx = new AudioContext();
  // Electron can hand back a suspended context when there was no user gesture.
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  const inRate = ctx.sampleRate;
  const source = ctx.createMediaStreamSource(stream);
  const BUF = 2048;
  const processor = ctx.createScriptProcessor(BUF, 1, 1);
  const blockMs = (BUF / inRate) * 1000;

  const calib: number[] = [];
  let floor = 0;
  let calibrated = false;
  let muted = false;

  let latched = false;
  let voicedMs = 0;
  let silenceRun = 0;
  let startedAt = 0;
  const frames: Float32Array[] = [];

  handlers.onState?.('calibrating');

  processor.onaudioprocess = (e) => {
    if (muted) return;
    const data = e.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length) + 1e-9;

    if (!calibrated) {
      calib.push(rms);
      floor = median(calib);
      if (calib.length >= Math.ceil(500 / blockMs)) {
        calibrated = true;
        handlers.onState?.('listening');
      }
      return;
    }

    const thr = Math.max(absMin, floor * factor);
    handlers.onLevel?.(Math.min(rms / (thr * 3), 1));

    if (rms >= thr) {
      if (!latched) {
        voicedMs += blockMs;
        if (voicedMs >= startMs) {
          latched = true;
          startedAt = ctx.currentTime;
          frames.length = 0;
          handlers.onState?.('speaking');
        }
      }
      silenceRun = 0;
      if (latched) frames.push(new Float32Array(data));
    } else {
      voicedMs = 0;
      if (latched) {
        silenceRun += blockMs;
        frames.push(new Float32Array(data));
        if (silenceRun >= silenceMs) endUtterance();
      }
    }

    if (latched && ctx.currentTime - startedAt > maxUtteranceS) endUtterance();
  };

  function endUtterance() {
    latched = false;
    silenceRun = 0;
    voicedMs = 0;
    handlers.onState?.('listening');
    if (!frames.length) return;
    const total = frames.reduce((n, f) => n + f.length, 0);
    const merged = new Float32Array(total);
    let off = 0;
    for (const f of frames) {
      merged.set(f, off);
      off += f.length;
    }
    frames.length = 0;
    if (merged.length < inRate * 0.55) return; // < ~0.5s of audio — a blip, not speech
    // require some real loudness across the clip, not just a spike
    let e = 0;
    for (let i = 0; i < merged.length; i++) e += merged[i] * merged[i];
    if (Math.sqrt(e / merged.length) < absMin * 0.9) return;
    handlers.onUtterance(downsample(merged, inRate));
  }

  source.connect(processor);
  // ScriptProcessor only runs while connected to a destination; route it to a
  // muted gain node so nothing is actually played back.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  processor.connect(sink);
  sink.connect(ctx.destination);

  return {
    stop: () => {
      processor.disconnect();
      source.disconnect();
      sink.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
    setMuted: (m: boolean) => {
      muted = m;
      if (m) {
        latched = false;
        frames.length = 0;
        silenceRun = 0;
        voicedMs = 0;
      }
    },
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
