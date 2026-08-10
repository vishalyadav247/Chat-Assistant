/* ChatConvert widget transport (spec 05, transport from spec 01).
 * POST + fetch-stream SSE parsing against the app proxy. No secrets, no LLM
 * calls — proxy endpoints only. Attached to window.ChatConvertTransport.
 *
 * Fallback seam (spec 01): if the proxy buffers SSE, a direct app-domain
 * streaming implementation can be installed as window.__ccDirectStream with
 * the same signature as streamChat — flag-gated, not implemented in v1.
 */
(function () {
  "use strict";

  /** Parse an SSE fetch-stream body, calling onFrame per JSON data frame. */
  function readSse(res, onFrame) {
    if (!res.ok || !res.body) return Promise.reject(new Error("bad response: " + res.status));
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";
    function pump() {
      return reader.read().then(function (result) {
        if (result.done) return undefined;
        buffer += decoder.decode(result.value, { stream: true });
        var parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        parts.forEach(function (part) {
          var line = part.split("\n").find(function (l) { return l.indexOf("data: ") === 0; });
          if (line) {
            try {
              onFrame(JSON.parse(line.slice(6)));
            } catch (e) {
              /* ignore malformed frame */
            }
          }
        });
        return pump();
      });
    }
    return pump();
  }

  /**
   * Stream one chat turn.
   * handlers: {onToken, onMessage, onCards, onHandover, onDone, onError}.
   * Returns a promise resolving when the stream ends.
   */
  function streamChat(base, payload, handlers) {
    // Fallback transport seam (spec 01) — direct-domain streaming, flag-gated.
    if (typeof window.__ccDirectStream === "function") {
      return window.__ccDirectStream(base, payload, handlers);
    }
    return fetch(base + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return readSse(res, function (frame) {
          if (frame.type === "token" && handlers.onToken) handlers.onToken(frame.text);
          else if (frame.type === "message" && handlers.onMessage) handlers.onMessage(frame.text);
          else if (frame.type === "cards" && handlers.onCards) handlers.onCards(frame.cards);
          else if (frame.type === "handover" && handlers.onHandover) handlers.onHandover(frame.data);
          else if (frame.type === "done" && handlers.onDone) handlers.onDone(frame);
          else if (frame.type === "error" && handlers.onError) handlers.onError(new Error("stream_failed"));
        });
      })
      .catch(function (err) {
        if (handlers.onError) handlers.onError(err);
        throw err;
      });
  }

  /** GET helper for JSON proxy endpoints (messages polling). */
  function getJson(url) {
    return fetch(url, { headers: { Accept: "application/json" } }).then(function (res) {
      if (!res.ok) throw new Error("bad response: " + res.status);
      return res.json();
    });
  }

  /** POST helper for JSON proxy endpoints (prechat, survey). */
  function postJson(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (res) {
      if (!res.ok) throw new Error("bad response: " + res.status);
      return res.json();
    });
  }

  window.ChatConvertTransport = {
    readSse: readSse,
    streamChat: streamChat,
    getJson: getJson,
    postJson: postJson,
  };
})();
