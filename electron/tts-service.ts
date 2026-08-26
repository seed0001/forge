/**
 * Text-to-speech, kept in the main process the same way transcribe.ts keeps
 * speech-to-text there — so a local server URL or spawned process never has
 * to be reachable from (or trusted by) renderer code.
 *
 * Three providers, chosen per-request by the caller:
 *  - edge: Microsoft Edge's free neural "Read Aloud" voices, via the
 *    msedge-tts npm package (a pure-Node reimplementation of the protocol —
 *    no API key, no external binary).
 *  - sapi: Windows' built-in offline voices, via a spawned PowerShell
 *    SpeechSynthesizer. Windows-only; reports "unavailable" elsewhere.
 *  - xtts: a self-hosted XTTS/Coqui server for custom cloned voices, POSTed
 *    to following the daswer123/xtts-api-server convention. Optional — most
 *    installs won't have one running, which surfaces as a clear connection
 *    error rather than a crash.
 */
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { app } from 'electron';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TtsProvider, TtsVoice } from './ipc-channels';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface TtsResult {
  audio: Buffer | null;
  mimeType: string;
  error?: string;
}

/** Where the Operator drops reference .wav clips for XTTS voice cloning. */
const voicesDir = path.join(app.isPackaged ? app.getPath('userData') : path.join(__dirname, '..'), 'voices');

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c) => chunks.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function synthesizeEdgeOnce(text: string, voice: string): Promise<Buffer> {
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(voice || 'en-US-AndrewNeural', OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text);
    return await streamToBuffer(audioStream);
  } finally {
    tts.close();
  }
}

/**
 * Microsoft's Read Aloud endpoint occasionally drops the WebSocket before
 * sending its closing "turn.end" message — a transient connection hiccup on
 * their end, not something a request can avoid. msedge-tts correctly reports
 * that as a truncation error rather than silently returning partial audio; a
 * fresh connection on retry almost always succeeds, so retry a couple of
 * times before giving up.
 */
async function synthesizeEdge(text: string, voice: string): Promise<TtsResult> {
  const attempts = 3;
  for (let i = 1; i <= attempts; i++) {
    try {
      const audio = await synthesizeEdgeOnce(text, voice);
      return { audio, mimeType: 'audio/mpeg' };
    } catch (err) {
      if (i === attempts) {
        return { audio: null, mimeType: 'audio/mpeg', error: `Edge TTS failed after ${attempts} attempts: ${String(err)}` };
      }
    }
  }
  // Unreachable — the loop above always returns.
  return { audio: null, mimeType: 'audio/mpeg', error: 'Edge TTS failed.' };
}

async function listEdgeVoices(): Promise<TtsVoice[]> {
  const tts = new MsEdgeTTS();
  try {
    const voices = await tts.getVoices();
    return voices
      .map((v) => ({ id: v.ShortName, label: `${v.FriendlyName || v.Name} (${v.Locale})` }))
      .sort((a, b) => a.label.localeCompare(b.label));
  } finally {
    tts.close();
  }
}

function runPowerShell(script: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    let stdout = '';
    let stderr = '';
    ps.stdout.on('data', (d) => (stdout += d.toString()));
    ps.stderr.on('data', (d) => (stderr += d.toString()));
    ps.on('error', reject);
    ps.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

async function synthesizeSapi(text: string, voice: string): Promise<TtsResult> {
  if (process.platform !== 'win32') {
    return { audio: null, mimeType: 'audio/wav', error: 'Windows SAPI is only available on Windows.' };
  }

  const tmp = os.tmpdir();
  const id = randomUUID();
  const textFile = path.join(tmp, `forge-tts-${id}.txt`);
  const wavFile = path.join(tmp, `forge-tts-${id}.wav`);

  // The chat text is written to a file and read back inside PowerShell rather
  // than being interpolated into the -Command string, so arbitrary chat
  // content (quotes, $vars, backticks, ;) can never be interpreted as script.
  await fsp.writeFile(textFile, text, 'utf8');

  const voiceSelect = voice
    ? `try { $s.SelectVoice(${JSON.stringify(voice)}) } catch {}`
    : '';
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    voiceSelect,
    `$text = Get-Content -Raw -Encoding UTF8 -Path ${JSON.stringify(textFile)}`,
    `$s.SetOutputToWaveFile(${JSON.stringify(wavFile)})`,
    '$s.Speak($text)',
    '$s.Dispose()',
  ]
    .filter(Boolean)
    .join('; ');

  try {
    const { stderr, code } = await runPowerShell(script);
    if (code !== 0 || !fs.existsSync(wavFile)) {
      return { audio: null, mimeType: 'audio/wav', error: `SAPI synthesis failed: ${stderr.trim() || `exit ${code}`}` };
    }
    const audio = await fsp.readFile(wavFile);
    return { audio, mimeType: 'audio/wav' };
  } catch (err) {
    return { audio: null, mimeType: 'audio/wav', error: `SAPI synthesis failed: ${String(err)}` };
  } finally {
    await fsp.rm(textFile, { force: true });
    await fsp.rm(wavFile, { force: true });
  }
}

async function listSapiVoices(): Promise<TtsVoice[]> {
  if (process.platform !== 'win32') return [];
  const script =
    'Add-Type -AssemblyName System.Speech; ' +
    '(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ' +
    'ForEach-Object { $_.VoiceInfo.Name }';
  const { stdout } = await runPowerShell(script);
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((name) => ({ id: name, label: name }));
}

async function synthesizeXtts(text: string, voice: string): Promise<TtsResult> {
  const base = (process.env.TTS_XTTS_SERVER_URL || 'http://localhost:8020').replace(/\/$/, '');
  const form = new URLSearchParams();
  form.set('text', text);
  form.set('language', 'en');
  if (voice) form.set('speaker_wav', path.join(voicesDir, voice));

  try {
    const res = await fetch(`${base}/tts_to_audio/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { audio: null, mimeType: 'audio/wav', error: `XTTS server error (${res.status}): ${detail.slice(0, 300)}` };
    }
    const audio = Buffer.from(await res.arrayBuffer());
    return { audio, mimeType: 'audio/wav' };
  } catch (err) {
    return { audio: null, mimeType: 'audio/wav', error: `XTTS server not reachable at ${base}: ${String(err)}` };
  }
}

async function listXttsVoices(): Promise<TtsVoice[]> {
  try {
    await fsp.mkdir(voicesDir, { recursive: true });
    const files = await fsp.readdir(voicesDir);
    return files
      .filter((f) => f.toLowerCase().endsWith('.wav'))
      .map((f) => ({ id: f, label: f.replace(/\.wav$/i, '') }));
  } catch {
    return [];
  }
}

export async function synthesizeSpeech(text: string, provider: TtsProvider, voice: string): Promise<TtsResult> {
  const trimmed = text.trim();
  if (!trimmed) return { audio: null, mimeType: 'audio/mpeg', error: 'Nothing to speak.' };
  // A very long reply makes for an oddly long synthesis wait — cap it, same
  // spirit as the other tools' output limits.
  const capped = trimmed.length > 4000 ? trimmed.slice(0, 4000) : trimmed;

  switch (provider) {
    case 'edge':
      return synthesizeEdge(capped, voice);
    case 'sapi':
      return synthesizeSapi(capped, voice);
    case 'xtts':
      return synthesizeXtts(capped, voice);
    default:
      return { audio: null, mimeType: 'audio/mpeg', error: `Unknown TTS provider: ${provider}` };
  }
}

export async function listVoices(provider: TtsProvider): Promise<TtsVoice[]> {
  try {
    switch (provider) {
      case 'edge':
        return await listEdgeVoices();
      case 'sapi':
        return await listSapiVoices();
      case 'xtts':
        return await listXttsVoices();
      default:
        return [];
    }
  } catch {
    return [];
  }
}
