import type { ActionFunctionArgs, HeadersFunction } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { requireShopAccess } from "../lib/access.server";
import { readWebSession } from "../lib/team/web-session.server";
import { sseResponse } from "../lib/sse.server";
import { logError } from "../lib/log.server";

// Inbox change feed (spec 18 live upgrade for spec 10's 7s poll). POST +
// fetch-stream SSE — POST so the App Bridge-patched fetch carries the session
// token in the admin; the web surface sends its cookie. Emits a `changed`
// frame whenever the shop's inbox signature moves; the client revalidates.

const TICK_MS = 3000;
const MAX_MS = 10 * 60 * 1000; // client reconnects after this

async function signature(shopId: string): Promise<string> {
  const [latest, unread] = await Promise.all([
    db.conversation.findFirst({
      where: { shopId, isTest: false },
      orderBy: { lastMessageAt: "desc" },
      select: { id: true, lastMessageAt: true },
    }),
    // Mirrors the inbox list / rail badge: test-console chats never count.
    db.conversation.count({
      where: { shopId, isTest: false, unread: true, status: "open", blocked: false },
    }),
  ]);
  return `${latest?.id ?? ""}:${latest?.lastMessageAt.getTime() ?? 0}:${unread}`;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shopId, surface } = await requireShopAccess(request, { permission: "inbox" });
  const signal = request.signal;

  async function* frames() {
    let last = await signature(shopId);
    const unread = Number(last.split(":").pop() ?? 0);
    yield { type: "ready" as const, unread };
    const started = Date.now();
    let tick = 0;
    while (!signal.aborted && Date.now() - started < MAX_MS) {
      await new Promise((resolve) => setTimeout(resolve, TICK_MS));
      if (signal.aborted) break;
      // Web surface: a revoked cookie / removed member must not keep the feed
      // alive for the rest of the window — re-check every ~15s.
      if (surface === "web" && ++tick % 5 === 0 && !(await readWebSession(request))) break;
      let next: string;
      try {
        next = await signature(shopId);
      } catch (error) {
        logError("inbox_events_tick_error", error);
        continue;
      }
      if (next !== last) {
        last = next;
        yield { type: "changed" as const, unread: Number(next.split(":").pop() ?? 0) };
      }
    }
    yield { type: "end" as const };
  }

  return sseResponse(frames(), signal);
};

export const loader = async () => new Response("Method Not Allowed", { status: 405 });

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
