import { logError } from "./log.server";
// SSE response helper: wraps an async iterable of JSON-serializable frames in
// text/event-stream framing with periodic heartbeat comments.

const HEARTBEAT_MS = 15_000;

export function sseResponse<T>(frames: AsyncIterable<T>, signal?: AbortSignal): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          clearInterval(heartbeat);
        }
      }, HEARTBEAT_MS);

      const abort = () => {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      signal?.addEventListener("abort", abort);

      try {
        for await (const frame of frames) {
          if (signal?.aborted) break;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        }
      } catch (error) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "error", message: "stream_failed" })}\n\n`),
        );
        logError("sse_stream_error", error);
      } finally {
        clearInterval(heartbeat);
        signal?.removeEventListener("abort", abort);
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
