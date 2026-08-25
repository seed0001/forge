/**
 * Speech-to-text against any OpenAI-compatible /audio/transcriptions endpoint
 * (OpenAI, Groq, a local server). Kept in the main process so the API key never
 * reaches renderer code.
 */
export interface TranscribeResult {
  text: string;
  error?: string;
}

export async function transcribe(audio: ArrayBuffer, mimeType: string): Promise<TranscribeResult> {
  const key = process.env.TRANSCRIBE_API_KEY;
  const base = (process.env.TRANSCRIBE_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
  const model = process.env.TRANSCRIBE_MODEL || 'whisper-large-v3';

  if (!key) {
    return {
      text: '',
      error: 'No TRANSCRIBE_API_KEY set. Add one to forge/.env and restart to use voice.',
    };
  }

  const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mimeType }), `speech.${ext}`);
  form.append('model', model);
  form.append('response_format', 'json');

  try {
    const res = await fetch(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    if (!res.ok) {
      const detail = await res.text();
      return { text: '', error: `Transcription failed (${res.status}): ${detail.slice(0, 300)}` };
    }
    const data = (await res.json()) as { text?: string };
    return { text: (data.text ?? '').trim() };
  } catch (err) {
    return { text: '', error: `Transcription request failed: ${String(err)}` };
  }
}
