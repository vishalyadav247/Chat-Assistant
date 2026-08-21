import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { type EntryContext } from "react-router";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";
import { hasShopifySignals } from "./lib/access.server";
import { hasWebCookie } from "./lib/team/web-session.server";
import { startQueueOnBoot } from "./lib/jobs/queue.server";
import { logError } from "./lib/log.server";

export const streamTimeout = 5000;

// Module scope runs once per server process. Bring pg-boss up here so the cron
// schedules exist from boot rather than from the first request that happens to
// enqueue something — see startQueueOnBoot() for why that matters.
startQueueOnBoot();

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext
) {
  addDocumentResponseHeaders(request, responseHeaders);

  // Never let a document be sniffed into another content type.
  responseHeaders.set("X-Content-Type-Options", "nosniff");

  // Standalone web surface (spec 18) and the operator console (spec 19): these
  // documents are never framed. The Shopify helper only sets frame-ancestors
  // when a `shop` param is present, so they get an explicit deny.
  //
  // /platform MUST be in this condition, not just /web: addDocumentResponseHeaders
  // runs first and unconditionally sets `frame-ancestors https://<shop>` whenever
  // ?shop= is present, which would otherwise let anyone frame the cross-tenant
  // operator console by appending a shop param to the URL.
  const pathname = new URL(request.url).pathname;
  const webAuthPage = pathname === "/web" || pathname.startsWith("/web/");
  const platformPage = pathname === "/platform" || pathname.startsWith("/platform/");
  if (webAuthPage || platformPage || (hasWebCookie(request) && !hasShopifySignals(request))) {
    responseHeaders.set("Content-Security-Policy", "frame-ancestors 'none'");
    responseHeaders.set("X-Frame-Options", "DENY");
    responseHeaders.set("Cache-Control", "no-store");
    // Invite / reset / handoff URLs carry tokens — never leak them via Referer.
    if (webAuthPage || platformPage) responseHeaders.set("Referrer-Policy", "no-referrer");
  } else if (pathname === "/app" || pathname.startsWith("/app/")) {
    // Embedded admin documents render shopper PII (inbox transcripts, contacts).
    // Keep them out of shared/proxy caches and browser back-forward cache.
    responseHeaders.set("Cache-Control", "no-store");
  }
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? '')
    ? "onAllReady"
    : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter
        context={reactRouterContext}
        url={request.url}
      />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            })
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          // Render-time crash (spec 21). No shop context here — the request is
          // already failing and `authenticate` may never have run.
          logError("ssr_render_error", error);
        },
      }
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}
