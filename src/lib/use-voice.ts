import { useCallback, useEffect, useRef, useState } from 'react';
import { forge } from './forge-api';

export type VoiceState = 'idle' | 'listening' | 'transcribing';

/**
 * Push-to-talk capture. Audio is recorded in the renderer and handed to the
 * main process for transcription; the transcript is returned rather than sent,
 * so the user always sees what was heard before it goes anywhere.
 */
export function useVoice(onTranscript: (text: string) => void) {
  const [state, setState] = useState<VoiceState>('idle');
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  const teardown = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    setLevel(0);
  }, []);

  useEffect(() => teardown, [teardown]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Drive a live input level so the composer reacts while you speak.
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
        setLevel(Math.min(peak / 70, 1));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();

      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType: mime });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);

      recorder.onstop = async () => {
        teardown();
        const blob = new Blob(chunksRef.current, { type: mime });
        if (blob.size < 1200) {
          setState('idle');
          return;
        }
        setState('transcribing');
        const result = await forge.voice.transcribe(await blob.arrayBuffer(), mime);
        setState('idle');
        if (result.error) setError(result.error);
        else if (result.text) onTranscript(result.text);
      };

      recorder.start();
      recorderRef.current = recorder;
      setState('listening');
    } catch (err) {
      teardown();
      setState('idle');
      setError(`Microphone unavailable: ${String(err)}`);
    }
  }, [onTranscript, teardown]);

  const stop = useCallback(() => {
    recorderRef.current?.state === 'recording' && recorderRef.current.stop();
    recorderRef.current = null;
  }, []);

  const toggle = useCallback(() => {
    if (state === 'listening') stop();
    else if (state === 'idle') start();
  }, [state, start, stop]);

  return { state, level, error, toggle, clearError: () => setError(null) };
}
