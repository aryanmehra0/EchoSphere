"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Drives the agent's waveform from live audio.
 *
 * PERFORMANCE NOTE — this is the reason the hook exists at all.
 *
 * The obvious implementation calls `setState` inside the rAF loop, which asks
 * React to reconcile the whole subtree sixty times a second, forever, while an
 * operator is trying to read a transcript next to it. On a projector-driving
 * laptop that is a visible frame cost for an element that is pure decoration.
 *
 * Instead the loop writes `style.height` straight onto the bar nodes. The
 * animation is outside React entirely; React only ever renders the bars once.
 * This is the standard trade for high-frequency visual-only state, and the
 * component tree keeps its purity everywhere it actually matters.
 *
 * ── PHASE 2 INTEGRATION ─────────────────────────────────────────────────────
 * Pass the agent's `IRemoteAudioTrack.getMediaStreamTrack()` as `track` inside
 * the Agora `user-published` handler. Until then, `active` alone drives a
 * synthesised envelope so the visualiser is truthful about agent state without
 * pretending to have audio it does not have.
 * ────────────────────────────────────────────────────────────────────────────
 */

interface Options {
  /** Live audio from the Agora remote track. Null in Phase 1. */
  track?: MediaStreamTrack | null;
  /** Whether the agent is currently producing sound. */
  active: boolean;
  /** Number of bars in the visualiser. */
  bars: number;
  /** Bar height range in pixels. */
  min?: number;
  max?: number;
}

export function useVoiceEnvelope({
  track,
  active,
  bars,
  min = 3,
  max = 26,
}: Options) {
  const nodes = useRef<(HTMLElement | null)[]>([]);
  const raf = useRef<number | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const source = useRef<MediaStreamAudioSourceNode | null>(null);

  /** Callback ref factory — bars register themselves by index. */
  const registerBar = useCallback(
    (index: number) => (el: HTMLElement | null) => {
      nodes.current[index] = el;
    },
    [],
  );

  useEffect(() => {
    let disposed = false;

    /* --- Real analyser, when a track is available ------------------------ */
    if (track) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;

      audioCtx.current = new Ctor();
      analyser.current = audioCtx.current.createAnalyser();
      // 64 bins is plenty for an 8-bar readout and keeps the FFT cheap.
      analyser.current.fftSize = 64;
      // Smoothing prevents the strobing that raw bin data produces on speech.
      analyser.current.smoothingTimeConstant = 0.75;

      source.current = audioCtx.current.createMediaStreamSource(
        new MediaStream([track]),
      );
      source.current.connect(analyser.current);
    }

    const spectrum = analyser.current
      ? new Uint8Array(analyser.current.frequencyBinCount)
      : null;

    const started = performance.now();

    const frame = (t: number) => {
      if (disposed) return;

      for (let i = 0; i < bars; i++) {
        const el = nodes.current[i];
        if (!el) continue;

        let level: number;

        if (!active) {
          // Idle: a shallow, slow breath so the component reads as present
          // rather than broken. Never flat — a flat visualiser looks crashed.
          level = 0.08 + 0.04 * Math.sin((t - started) / 700 + i * 0.6);
        } else if (analyser.current && spectrum) {
          analyser.current.getByteFrequencyData(
            spectrum as unknown as Uint8Array<ArrayBuffer>,
          );
          // Spread the bars across the low half of the spectrum, where speech
          // energy actually lives; the top bins are near-silent on voice.
          const bin = Math.floor((i / bars) * (spectrum.length * 0.6)) + 1;
          level = spectrum[bin] / 255;
        } else {
          // Synthesised speech envelope: three detuned sines beat against one
          // another to produce the irregular syllabic rhythm of real speech.
          const p = (t - started) / 1000;
          const a = Math.sin(p * 7.1 + i * 0.9);
          const b = Math.sin(p * 11.3 + i * 1.7);
          const c = Math.sin(p * 3.3 + i * 0.4);
          level = 0.28 + 0.26 * a * b + 0.18 * c;
        }

        const clamped = Math.max(0, Math.min(1, level));
        el.style.height = `${min + clamped * (max - min)}px`;
      }

      raf.current = requestAnimationFrame(frame);
    };

    raf.current = requestAnimationFrame(frame);

    return () => {
      disposed = true;
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      source.current?.disconnect();
      analyser.current?.disconnect();
      // AudioContext.close() is async and rejects if already closed; a live
      // incident must never surface an unhandled rejection from a visualiser.
      audioCtx.current?.close().catch(() => {});
      source.current = null;
      analyser.current = null;
      audioCtx.current = null;
    };
  }, [track, active, bars, min, max]);

  return { registerBar };
}
