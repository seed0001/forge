import { useEffect, useRef, useState } from 'react';
import { Orb } from './Orb';
import { staticMood } from '../lib/mood';
import { startVoiceCapture, type VoiceCaptureHandle } from '../lib/voice-capture';
import { loadWhisper, transcribe, type WhisperProgress } from '../lib/whisper';
import { classify, armFollowUp, endConversation, newEngageState } from '../lib/voice-engage';
import type { DisplayInfo } from '../../electron/overlay-preload';

/**
 * The roaming desktop Orb. Lives in a full-screen transparent click-through
 * window; this component positions a small Orb sprite in screen space and
 * decides where it drifts. The window is interactive only while the cursor is
 * actually over the sprite — everywhere else, clicks fall through to the
 * desktop.
 *
 * Position is written straight to the sprite's transform in the rAF loop, never
 * through React state, so movement stays at display refresh rate without
 * re-rendering the WebGL Orb every frame.
 */

const SIZE = 132;

interface OverlayBridge {
  setInteractive: (v: boolean) => void;
  contextMenu: () => void;
  openForge: () => void;
  getDisplay: () => Promise<DisplayInfo>;
  onDisplayChanged: (cb: (info: DisplayInfo) => void) => () => void;
  onPausedChanged: (cb: (p: boolean) => void) => () => void;
  ask: (text: string) => void;
  stopAgent: () => void;
  onSpeak: (cb: (clip: { b64: string; mime: string }) => void) => () => void;
  onAgentActivity: (cb: (evt: { detail?: string; status?: string }) => void) => () => void;
  onAgentStatus: (cb: (running: boolean) => void) => () => void;
  onAgentReply: (cb: (text: string) => void) => () => void;
}
const bridge: OverlayBridge | undefined = (window as unknown as { overlayApi?: OverlayBridge }).overlayApi;

/** Where the Orb likes to sit: just above the clock, bottom-right. */
function homeFor(d: DisplayInfo) {
  return { x: d.workArea.width - SIZE - 96, y: d.workArea.height - SIZE + 16 };
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

type OrbPhase = 'boot' | 'idle' | 'listening' | 'thinking' | 'speaking';

const MOOD_FOR: Record<OrbPhase, ReturnType<typeof staticMood>> = {
  boot: staticMood('thinking', 0.35, 0.6),
  idle: staticMood('idle'),
  listening: staticMood('reading', 0.7, 1.35),
  thinking: staticMood('deep', 0.8, 1.2),
  speaking: staticMood('editing', 0.75, 1.15),
};

export function OverlayApp() {
  const [cursor, setCursor] = useState<'none' | 'grab' | 'grabbing'>('none');
  const [phase, setPhase] = useState<OrbPhase>('boot');
  const [caption, setCaption] = useState('');
  const [bootPct, setBootPct] = useState(0);
  const captureRef = useRef<VoiceCaptureHandle | null>(null);
  const captionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agentRunningRef = useRef(false);
  const speakingRef = useRef(false);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const engageRef = useRef(newEngageState());

  const showCaption = (text: string, holdMs = 3500) => {
    setCaption(text);
    if (captionTimer.current) clearTimeout(captionTimer.current);
    captionTimer.current = setTimeout(() => setCaption(''), holdMs);
  };

  const stopPlayback = () => {
    const el = audioElRef.current;
    if (el && !el.paused) {
      el.pause();
      el.currentTime = 0;
    }
    speakingRef.current = false;
    captureRef.current?.setMuted(false);
    setPhase((cur) => (cur === 'speaking' ? 'idle' : cur));
  };

  const spriteRef = useRef<HTMLDivElement>(null);
  const posRef = useRef({ x: 40, y: 40 });
  const homeRef = useRef({ x: 40, y: 40 });
  const displayRef = useRef<DisplayInfo | null>(null);
  const draggingRef = useRef(false);
  const grabOffset = useRef({ x: 0, y: 0 });
  const pausedRef = useRef(false);
  const interactiveRef = useRef(false);
  const wanderRef = useRef({ target: null as { x: number; y: number } | null, nextAt: performance.now() + 14000 });

  const paint = () => {
    const el = spriteRef.current;
    if (el) el.style.transform = `translate3d(${posRef.current.x}px, ${posRef.current.y}px, 0)`;
  };

  const setInteractive = (v: boolean) => {
    if (interactiveRef.current === v) return;
    interactiveRef.current = v;
    bridge?.setInteractive(v);
    if (!draggingRef.current) setCursor(v ? 'grab' : 'none');
  };

  // ── display + paused wiring ──────────────────────────────────────────
  useEffect(() => {
    if (!bridge) return;
    bridge.getDisplay().then((d) => {
      displayRef.current = d;
      const h = homeFor(d);
      posRef.current = { ...h };
      homeRef.current = { ...h };
      paint();
    });
    const off1 = bridge.onDisplayChanged((d) => {
      displayRef.current = d;
      homeRef.current = homeFor(d);
    });
    const off2 = bridge.onPausedChanged((p) => (pausedRef.current = p));
    return () => {
      off1();
      off2();
    };
  }, []);

  // ── voice: load Whisper, then listen continuously ────────────────────
  useEffect(() => {
    let stopped = false;
    (async () => {
      try {
        await loadWhisper((p: WhisperProgress) => {
          if (p.status === 'progress' && p.total) setBootPct(Math.round(((p.loaded ?? 0) / p.total) * 100));
        });
        if (stopped) return;
        setPhase('idle');
        showCaption('listening', 2500);

        captureRef.current = await startVoiceCapture({
          onState: (s) => {
            if (stopped || speakingRef.current) return;
            if (s === 'speaking' && !agentRunningRef.current) setPhase('listening');
            else if (s === 'listening' && !agentRunningRef.current) {
              setPhase((cur) => (cur === 'listening' ? 'idle' : cur));
            }
          },
          onUtterance: async (audio) => {
            if (stopped || speakingRef.current) return;
            let text: string;
            try {
              text = await transcribe(audio);
            } catch {
              return;
            }
            if (stopped || !text) return;

            const engaged = Date.now() < engageRef.current.followUpUntil;
            const c = classify(text, engageRef.current, { hasPendingReply: agentRunningRef.current });

            if (c.kind === 'noise' || c.kind === 'ignore') {
              // heard something, not for us — a faint acknowledgement only
              if (c.kind === 'ignore') showCaption(text, 1400);
              return;
            }
            if (c.kind === 'stop-speaking') {
              stopPlayback();
              bridge?.stopAgent();
              showCaption('(stopped)', 1500);
              return;
            }
            if (c.kind === 'cancel') {
              bridge?.stopAgent();
              showCaption('(cancelled)', 1500);
              return;
            }
            if (c.kind === 'stop-listening') {
              endConversation(engageRef.current);
              stopPlayback();
              bridge?.stopAgent();
              showCaption('going quiet', 1800);
              setPhase('idle');
              return;
            }
            // wake with nothing after it → just acknowledge and open the window
            if (c.kind === 'wake' && !c.text) {
              armFollowUp(engageRef.current, 12);
              setPhase('listening');
              showCaption('yeah?', 2500);
              return;
            }
            // wake (with a request) or follow-up → send it to the agent
            void engaged;
            showCaption(`“${c.text}”`, 4000);
            setPhase('thinking');
            bridge?.ask(c.text);
          },
          onError: (m) => showCaption(m, 6000),
        });
      } catch (e) {
        if (!stopped) showCaption(`voice unavailable: ${String(e).slice(0, 80)}`, 8000);
      }
    })();
    return () => {
      stopped = true;
      captureRef.current?.stop();
      if (captionTimer.current) clearTimeout(captionTimer.current);
    };
  }, []);

  // ── agent conversation: status, activity narration, spoken replies ────
  useEffect(() => {
    if (!bridge) return;

    const offStatus = bridge.onAgentStatus((running) => {
      agentRunningRef.current = running;
      // Keep the mic live while it's thinking so "stop" / "never mind" land;
      // only mute while it's actually speaking (echo).
      if (running) setPhase('thinking');
      else if (!speakingRef.current) setPhase('idle');
    });

    const offActivity = bridge.onAgentActivity((evt) => {
      if (evt?.detail) showCaption(evt.detail, 6000);
    });

    const offReply = bridge.onAgentReply((text) => {
      const flat = text.replace(/```[\s\S]*?```/g, ' … ').replace(/\s+/g, ' ').trim();
      showCaption(flat.length > 160 ? flat.slice(0, 158) + '…' : flat, 10000);
    });

    const offSpeak = bridge.onSpeak(({ b64, mime }) => {
      try {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        const el = audioElRef.current ?? new Audio();
        audioElRef.current = el;
        el.src = url;
        speakingRef.current = true;
        captureRef.current?.setMuted(true);
        setPhase('speaking');
        el.onended = el.onerror = () => {
          URL.revokeObjectURL(url);
          speakingRef.current = false;
          captureRef.current?.setMuted(false);
          // Conversation stays open for a bit after it speaks — talk freely.
          armFollowUp(engageRef.current, 24);
          if (!agentRunningRef.current) setPhase('idle');
        };
        void el.play();
      } catch {
        speakingRef.current = false;
      }
    });

    return () => {
      offStatus();
      offActivity();
      offReply();
      offSpeak();
    };
  }, []);

  // ── hover detection via forwarded mousemove (works while click-through) ─
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (draggingRef.current) return;
      const p = posRef.current;
      const pad = 8;
      const inside =
        e.clientX >= p.x - pad && e.clientX <= p.x + SIZE + pad &&
        e.clientY >= p.y - pad && e.clientY <= p.y + SIZE + pad;
      setInteractive(inside);
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, []);

  // ── roaming / bob loop ──────────────────────────────────────────────
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (draggingRef.current) {
        paint();
        return;
      }
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      const d = displayRef.current;
      const t = now / 1000;
      const bob = { x: Math.sin(t * 0.6) * 5, y: Math.sin(t * 0.9) * 7 };

      const w = wanderRef.current;
      if (!pausedRef.current && !w.target && now > w.nextAt && d) {
        const dx = (Math.random() - 0.5) * Math.min(d.workArea.width * 0.5, 520);
        const dy = -(Math.random() * Math.min(d.workArea.height * 0.4, 320));
        w.target = {
          x: clamp(homeRef.current.x + dx, 8, d.workArea.width - SIZE - 8),
          y: clamp(homeRef.current.y + dy, 8, d.workArea.height - SIZE - 8),
        };
      }

      const anchor = w.target ?? homeRef.current;
      const goal = { x: anchor.x + bob.x, y: anchor.y + bob.y };
      const k = Math.min((w.target ? 1.7 : 2.6) * dt, 1);
      posRef.current = {
        x: posRef.current.x + (goal.x - posRef.current.x) * k,
        y: posRef.current.y + (goal.y - posRef.current.y) * k,
      };

      if (w.target) {
        const d2 = (posRef.current.x - w.target.x) ** 2 + (posRef.current.y - w.target.y) ** 2;
        if (d2 < 16) {
          w.target = null;
          w.nextAt = now + 9000 + Math.random() * 22000;
        }
      }
      paint();
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── drag ────────────────────────────────────────────────────────────
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    draggingRef.current = true;
    setCursor('grabbing');
    wanderRef.current = { target: null, nextAt: performance.now() + 16000 };
    grabOffset.current = { x: e.clientX - posRef.current.x, y: e.clientY - posRef.current.y };
    try {
      (e.target as Element).setPointerCapture(e.pointerId);
    } catch {
      /* no-op */
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    const b = displayRef.current?.bounds;
    const nx = e.clientX - grabOffset.current.x;
    const ny = e.clientY - grabOffset.current.y;
    posRef.current = {
      x: b ? clamp(nx, -SIZE * 0.4, b.width - SIZE * 0.6) : nx,
      y: b ? clamp(ny, -SIZE * 0.4, b.height - SIZE * 0.6) : ny,
    };
    paint();
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    homeRef.current = { ...posRef.current }; // it settles where you dropped it
    setCursor(interactiveRef.current ? 'grab' : 'none');
    try {
      (e.target as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  const captionText = phase === 'boot' ? `waking up${bootPct ? ` ${bootPct}%` : '…'}` : caption;

  return (
    <div
      ref={spriteRef}
      className="orb-sprite"
      style={{
        width: SIZE,
        height: SIZE,
        cursor: cursor === 'none' ? 'default' : cursor,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => bridge?.openForge()}
      onContextMenu={(e) => {
        e.preventDefault();
        bridge?.contextMenu();
      }}
    >
      <Orb mood={MOOD_FOR[phase]} transparent />
      {captionText && <div className="orb-caption">{captionText}</div>}
    </div>
  );
}
