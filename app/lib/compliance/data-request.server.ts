import db from "../../db.server";
import { requireShopId } from "../tenancy.server";

// customers/data_request export workflow (spec 17).
//
// Design decision: exports are COMPUTED ON DOWNLOAD — no artifact is ever
// written to disk and `DataRequest.exportPath` stays null. Rationale:
//  - a stored export file is a second copy of customer PII that would itself
//    need retention + redaction handling (customers/redact and shop/redact
//    would have to chase filesystem artifacts as well as rows);
//  - computing fresh at download time means the export always reflects the
//    current database — a redaction that ran after the request can never leak
//    already-deleted transcripts through a stale artifact;
//  - there is nothing extra to purge on uninstall (less residual PII).
// The webhook row is the durable record; the JSON payload exists only for the
// lifetime of the download response.

/** Sentinel written by the customers/redact job over erased request emails. */
const REDACTED_EMAIL = "[redacted]";

export interface DataRequestExport {
  dataRequestId: string;
  customer: { email: string };
  contacts: Array<{
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    type: string;
    channel: string;
    location: string | null;
    marketingOptIn: boolean;
    shopifyCustomerId: string | null;
    createdAt: string;
  }>;
  conversations: Array<{
    id: string;
    mode: string;
    status: string;
    outcome: string | null;
    channel: string;
    handover: boolean;
    surveyRating: number | null;
    startedAt: string;
    endedAt: string | null;
    lastMessageAt: string;
    messages: Array<{
      role: string;
      author: string;
      content: string;
      createdAt: string;
    }>;
    unresolvedQuestions: Array<{ question: string; reason: string; createdAt: string }>;
  }>;
  generatedAt: string;
}

/**
 * Gather everything ChatConvert stores about the request's customer email:
 * contact rows, their conversations with full message transcripts (this
 * includes handover form submissions, which land as messages + contact
 * fields), survey ratings, and unresolved-question copies of their turns.
 * Marks the request "ready" (export compiled); download flips it to
 * "completed". Every query is shop-scoped.
 */
export async function buildDataRequestExport(
  shopId: string,
  dataRequestId: string,
): Promise<DataRequestExport> {
  requireShopId(shopId);
  const request = await db.dataRequest.findFirst({ where: { id: dataRequestId, shopId } });
  if (!request) throw new Error("data_request_not_found");

  // A scrubbed request (customers/redact ran after the data request) or an
  // empty payload email matches no contacts — the export is an empty shell,
  // which is the correct answer post-redaction.
  const email = request.customerEmail;
  const contacts =
    email && email !== REDACTED_EMAIL
      ? await db.contact.findMany({
          where: { shopId, email },
          orderBy: { createdAt: "asc" },
        })
      : [];
  const contactIds = contacts.map((c) => c.id);

  const conversations =
    contactIds.length > 0
      ? await db.conversation.findMany({
          where: { shopId, contactId: { in: contactIds } },
          orderBy: { startedAt: "asc" },
        })
      : [];
  const convoIds = conversations.map((c) => c.id);

  const [messages, unresolved] =
    convoIds.length > 0
      ? await Promise.all([
          db.message.findMany({
            where: { shopId, conversationId: { in: convoIds } },
            orderBy: { createdAt: "asc" },
          }),
          db.unresolvedQuestion.findMany({
            where: { shopId, conversationId: { in: convoIds } },
            orderBy: { createdAt: "asc" },
          }),
        ])
      : [[], []];

  const exportData: DataRequestExport = {
    dataRequestId: request.id,
    customer: { email },
    contacts: contacts.map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      type: c.type,
      channel: c.channel,
      location: c.location,
      marketingOptIn: c.marketingOptIn,
      shopifyCustomerId: c.shopifyCustomerId,
      createdAt: c.createdAt.toISOString(),
    })),
    conversations: conversations.map((convo) => ({
      id: convo.id,
      mode: convo.mode,
      status: convo.status,
      outcome: convo.outcome,
      channel: convo.channel,
      handover: convo.handover,
      surveyRating: convo.rating,
      startedAt: convo.startedAt.toISOString(),
      endedAt: convo.endedAt?.toISOString() ?? null,
      lastMessageAt: convo.lastMessageAt.toISOString(),
      messages: messages
        .filter((m) => m.conversationId === convo.id)
        .map((m) => ({
          role: m.role,
          author: m.author,
          content: m.content,
          createdAt: m.createdAt.toISOString(),
        })),
      unresolvedQuestions: unresolved
        .filter((q) => q.conversationId === convo.id)
        .map((q) => ({ question: q.question, reason: q.reason, createdAt: q.createdAt.toISOString() })),
    })),
    generatedAt: new Date().toISOString(),
  };

  if (request.status === "pending") {
    // exportPath deliberately stays null — compute-on-download (see header).
    await db.dataRequest.updateMany({
      where: { id: dataRequestId, shopId },
      data: { status: "ready" },
    });
  }

  return exportData;
}

/**
 * Compile the export fresh and mark the request fulfilled. Returns the JSON
 * string for the client to save as a file (embedded-admin Blob download).
 */
export async function downloadDataRequest(
  shopId: string,
  dataRequestId: string,
): Promise<{ json: string; filename: string }> {
  requireShopId(shopId);
  const exportData = await buildDataRequestExport(shopId, dataRequestId);
  await db.dataRequest.updateMany({
    where: { id: dataRequestId, shopId },
    data: { status: "completed", completedAt: new Date() },
  });
  return {
    json: JSON.stringify(exportData, null, 2),
    filename: `chatconvert-data-request-${dataRequestId}.json`,
  };
}

/** Canonical overdue rule: past the 30-day dueAt and not yet fulfilled. */
export function isDataRequestOverdue(
  request: { dueAt: Date; status: string },
  now: Date = new Date(),
): boolean {
  return request.status !== "completed" && request.dueAt.getTime() < now.getTime();
}

export interface PendingDataRequest {
  id: string;
  customerEmail: string;
  status: string;
  requestedAt: Date;
  dueAt: Date;
  isOverdue: boolean;
}

/** Unfulfilled requests for a shop, flagged when past the 30-day SLA. */
export async function pendingDataRequests(shopId: string): Promise<PendingDataRequest[]> {
  requireShopId(shopId);
  const rows = await db.dataRequest.findMany({
    where: { shopId, status: { not: "completed" } },
    orderBy: { dueAt: "asc" },
    select: { id: true, customerEmail: true, status: true, requestedAt: true, dueAt: true },
  });
  const now = new Date();
  return rows.map((row) => ({ ...row, isOverdue: isDataRequestOverdue(row, now) }));
}
