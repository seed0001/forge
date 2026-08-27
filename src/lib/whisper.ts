import { pipeline, env, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';

/**
 * Local speech-to-text with Transformers.js — runs entirely in this renderer,
 * WebGPU-accelerated where available, WASM otherwise. The model (~150 MB for
 * whisper-base.en) downloads from the HF CDN once and is cached by the browser;
 * after that it works offline.
 */

// We never ship model files in the bundle — always fetch + cache.
env.allowLocalModels = false;

export interface WhisperProgress {
  status: string;
  name?: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

const MODEL = 'Xenova/whisper-base.en';

let asrPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;
let ready = false;

export function isWhisperReady() {
  return ready;
}

export function loadWhisper(onProgress?: (p: WhisperProgress) => void): Promise<AutomaticSpeechRecognitionPipeline> {
  if (!asrPromise) {
    const device =
      typeof navigator !== 'undefined' && 'gpu' in navigator ? ('webgpu' as const) : ('wasm' as const);
    asrPromise = pipeline('automatic-speech-recognition', MODEL, {
      device,
      dtype: device === 'webgpu' ? 'fp16' : 'q8',
      progress_callback: onProgress as unknown as (p: unknown) => void,
    }).then((p) => {
      ready = true;
      return p as AutomaticSpeechRecognitionPipeline;
    });
  }
  return asrPromise;
}

/** `audio` must be mono Float32 at 16 kHz. Returns the recognised text. */
export async function transcribe(audio: Float32Array): Promise<string> {
  const asr = await loadWhisper();
  const out = await asr(audio, { language: 'en', task: 'transcribe', chunk_length_s: 30 });
  const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text;
  return text.trim();
}
