import { useEffect, useRef } from "react";

// Client side of the inbox change feed (spec 18): keeps a fetch-stream open
// to /app/inbox-events and calls onChange for every `changed` frame.
// Reconnects with backoff; the caller keeps a slow poll as a fallback.

export interface InboxLiveFrame {
  type: "ready" | "changed" | "end" | "error";
  unread?: number;
}

export function useInboxLive(onFrame: (frame: InboxLiveFrame) => void): void {
  const handler = useRef(onFrame);
  handler.current = onFrame;

  useEffect(() => {
    let stopped = false;
    let attempt = 0;
    let controller: AbortController | null = null;

    const connect = async () => {
      while (!stopped) {
        controller = new AbortController();
        try {
          const res = await fetch("/app/inbox-events", {
            method: "POST",
            headers: { Accept: "text/event-stream" },
            signal: controller.signal,
          });
          if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
          attempt = 0;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx = buffer.indexOf("\n\n");
            while (idx !== -1) {
              const chunk = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              for (const line of chunk.split("\n")) {
                if (!line.startsWith("data:")) continue;
                try {
                  handler.current(JSON.parse(line.slice(5).trim()) as InboxLiveFrame);
                } catch {
                  /* ignore malformed frame */
                }
              }
              idx = buffer.indexOf("\n\n");
            }
          }
        } catch {
          if (stopped) return;
        }
        if (stopped) return;
        // Server ends the stream every ~10 min; errors back off up to 30s.
        attempt += 1;
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
        await new Promise((resolve) => setTimeout(resolve, attempt === 1 ? 250 : delay));
      }
    };
    void connect();

    return () => {
      stopped = true;
      controller?.abort();
    };
  }, []);
}

/** Tiny attention chime via WebAudio (no asset download). */
export function playChime(): void {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.26);
    osc.onended = () => ctx.close().catch(() => undefined);
  } catch {
    /* autoplay policy etc. */
  }
}
