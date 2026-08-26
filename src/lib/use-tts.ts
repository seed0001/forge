import { useCallback, useRef, useState } from 'react';
import { forge } from './forge-api';
import type { TtsProvider } from '../../electron/ipc-channels';

/**
 * Strips the markdown noise ChatView renders (code fences, links, emphasis
 * markers, heading hashes...) so the TTS engine reads prose, not syntax.
 */
function stripForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .trim();
}

/**
 * Opt-in TTS playback: one message speaks at a time, starting a new one
 * stops whatever was playing. `speak` is keyed by an arbitrary caller-chosen
 * id (the chat message index) so ChatView can show per-bubble state.
 */
export function useTts(provider: TtsProvider, voice: string) {
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [synthesizingId, setSynthesizingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  const cleanup = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    cleanup();
    setSpeakingId(null);
    setSynthesizingId(null);
  }, [cleanup]);

  const speak = useCallback(
    async (text: string, id: string) => {
      stop();
      setError(null);
      const clean = stripForSpeech(text);
      if (!clean) return;

      setSynthesizingId(id);
      const result = await forge.tts.synthesize(clean, provider, voice);
      setSynthesizingId((cur) => (cur === id ? null : cur));

      if (result.error || !result.audio) {
        setError(result.error || 'Speech synthesis failed.');
        return;
      }

      const bytes = Uint8Array.from(atob(result.audio), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
      urlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        cleanup();
        setSpeakingId((cur) => (cur === id ? null : cur));
      };
      audio.onerror = () => {
        cleanup();
        setSpeakingId((cur) => (cur === id ? null : cur));
        setError('Playback failed.');
      };

      setSpeakingId(id);
      try {
        await audio.play();
      } catch (err) {
        cleanup();
        setSpeakingId((cur) => (cur === id ? null : cur));
        setError(`Playback failed: ${String(err)}`);
      }
    },
    [provider, voice, stop, cleanup]
  );

  return { speak, stop, speakingId, synthesizingId, error, clearError: () => setError(null) };
}
