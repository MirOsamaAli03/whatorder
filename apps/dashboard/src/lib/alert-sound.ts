'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The audible new-order alert (plan §2.8).
 *
 * Browsers block audio until the user has interacted with the page. A kitchen
 * display that simply calls `play()` on a new order therefore has *no* audible
 * alert at all — and says nothing about it, which is the worst possible outcome
 * for a feature whose entire job is that nothing goes unnoticed.
 *
 * So sound is explicitly armed by a button press, and `blocked` is surfaced so
 * the screen can show that it is running silent.
 *
 * The tone is synthesised with WebAudio rather than loaded from a file: no
 * asset to ship, no request that can fail, and the oscillator is audible over
 * a kitchen.
 */
export function useAlertSound() {
  const [enabled, setEnabled] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const contextRef = useRef<AudioContext | null>(null);

  const enable = useCallback(async () => {
    try {
      const AudioContextClass =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

      if (!AudioContextClass) {
        setBlocked(true);
        return;
      }

      const context = contextRef.current ?? new AudioContextClass();
      contextRef.current = context;

      // Created inside a user gesture, so this is the moment the browser will
      // allow it to start.
      await context.resume();

      setEnabled(context.state === 'running');
      setBlocked(context.state !== 'running');
    } catch {
      setBlocked(true);
    }
  }, []);

  /**
   * Mutes the chime without tearing the audio context down.
   *
   * Kept suspended rather than closed, because a browser only lets a context
   * start inside a user gesture — closing it would mean the next "Sound on"
   * had to win that permission all over again, and on some browsers it would
   * not. A kitchen that mutes during a quiet hour must be able to unmute with
   * one tap.
   */
  const disable = useCallback(() => {
    setEnabled(false);
    void contextRef.current?.suspend().catch(() => {
      // Already suspended, or closed by the browser. Either way it is silent.
    });
  }, []);

  const play = useCallback(() => {
    const context = contextRef.current;
    if (!context || context.state !== 'running') return;

    // Two short rising beeps: distinctive enough to notice, short enough not to
    // become something staff want to disable.
    const now = context.currentTime;
    for (const [index, frequency] of [880, 1174].entries()) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;

      const start = now + index * 0.18;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);

      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.18);
    }
  }, []);

  useEffect(() => {
    return () => {
      void contextRef.current?.close();
      contextRef.current = null;
    };
  }, []);

  return { enabled, blocked, enable, disable, play };
}
