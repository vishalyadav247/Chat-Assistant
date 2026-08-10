import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { sseResponse } from "../lib/sse.server";

// Streaming probe — the day-one go/no-go gate for SSE through the Shopify app
// proxy (storefront: GET /apps/chatconvert/ping). If the 5 chunks arrive all at
// once instead of ~500ms apart, the proxy/tunnel buffers and the fallback
// transport in spec 01 (signed-token direct streaming) must be used.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);

  async function* probeFrames() {
    for (let i = 1; i <= 5; i++) {
      yield { type: "ping", n: i, at: new Date().toISOString() };
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    yield { type: "done" };
  }

  return sseResponse(probeFrames(), request.signal);
};
