import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { type EntryContext } from "react-router";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";
import { hasShopifySignals } from "./lib/access.server";
import { hasWebCookie } from "./lib/team/web-session.server";

export const streamTimeout = 5000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext
) {
  addDocumentResponseHeaders(request, responseHeaders);
  // Standalone web surface (spec 18): these documents are never framed. The
  // Shopify helper only sets frame-ancestors when a `shop` param is present,
  // so web-session documents (and the /web/* auth pages) get an explicit deny.
  const pathname = new URL(request.url).pathname;
  const webAuthPage = pathname === "/web" || pathname.startsWith("/web/");
  if (webAuthPage || (hasWebCookie(request) && !hasShopifySignals(request))) {
    responseHeaders.set("Content-Security-Policy", "frame-ancestors 'none'");
    responseHeaders.set("X-Frame-Options", "DENY");
    responseHeaders.set("Cache-Control", "no-store");
    // Invite / reset / handoff URLs carry tokens — never leak them via Referer.
    if (webAuthPage) responseHeaders.set("Referrer-Policy", "no-referrer");
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
          console.error(error);
        },
      }
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}
