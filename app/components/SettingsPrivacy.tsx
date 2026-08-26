import type { ShopSettingsData } from "../lib/settings/schemas";

// Settings → Privacy & Data Requests tab (spec 16; workflows in 17):
// data-request list with export download, retention select, redaction info.

type RetentionDays = ShopSettingsData["retentionDays"];

export interface DataRequestRow {
  id: string;
  date: string;
  email: string;
  status: string;
  dueAt: string;
  isOverdue: boolean;
}

const STATUS_TONE: Record<string, "caution" | "info" | "success"> = {
  pending: "caution",
  ready: "info",
  completed: "success",
};

const RETENTION_OPTIONS: Array<{ value: RetentionDays; label: string }> = [
  { value: 0, label: "Keep forever" },
  { value: 90, label: "90 days" },
  { value: 60, label: "60 days" },
  { value: 30, label: "30 days" },
  { value: 7, label: "7 days" },
];

export function SettingsPrivacy(props: {
  retentionDays: RetentionDays;
  dataRequests: DataRequestRow[];
  downloadingId: string | null;
  onRetentionChange: (value: RetentionDays) => void;
  onDownload: (id: string) => void;
}) {
  return (
    <s-stack gap="base">
      <s-section heading="Customer data requests">
        <s-paragraph>
          When a customer asks for the data your store holds about them, Shopify sends a request
          here. ChatConvert compiles the chat data it stores (conversations and messages tied to
          that customer&apos;s email) so you can hand it over. Download the export below to fulfil
          the request — Shopify requires this within 30 days.
        </s-paragraph>
        {props.dataRequests.length === 0 ? (
          <s-text tone="neutral">No customer data requests yet.</s-text>
        ) : (
          <s-stack gap="small">
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header>Date</s-table-header>
                <s-table-header>Customer</s-table-header>
                <s-table-header>Status</s-table-header>
                <s-table-header>Due</s-table-header>
                <s-table-header>Export</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {props.dataRequests.map((request) => (
                  <s-table-row key={request.id}>
                    <s-table-cell>{request.date}</s-table-cell>
                    <s-table-cell>{request.email}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone={STATUS_TONE[request.status] ?? "info"}>
                        {request.status}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      {request.isOverdue ? (
                        <s-stack direction="inline" gap="small-300">
                          <s-text>{request.dueAt}</s-text>
                          <s-badge tone="critical">Overdue</s-badge>
                        </s-stack>
                      ) : (
                        request.dueAt
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      <s-button
                        icon="export"
                        loading={props.downloadingId === request.id || undefined}
                        disabled={props.downloadingId !== null || undefined}
                        onClick={() => props.onDownload(request.id)}
                      >
                        Download
                      </s-button>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </s-stack>
        )}
      </s-section>

      <s-section heading="Data retention">
        <s-paragraph>
          Choose how long ChatConvert keeps raw chat transcripts. Older conversations (and their
          messages) are deleted automatically each day. This is independent of Shopify&apos;s
          deletion webhooks, which always run regardless of this setting.
        </s-paragraph>
        <s-select
          label="Keep transcripts for"
          value={String(props.retentionDays)}
          onInput={(e) => props.onRetentionChange(Number(e.currentTarget.value) as RetentionDays)}
        >
          {RETENTION_OPTIONS.map((option) => (
            <s-option key={option.value} value={String(option.value)}>
              {option.label}
            </s-option>
          ))}
        </s-select>
      </s-section>

      {/* This wording is read verbatim by Shopify's data-protection reviewer and
          must match what the app actually stores (App Store requirement 1.1.4 —
          factual information only). Update it whenever the Contact or Message
          model changes, or whenever a sub-processor is added or removed. */}
      <s-section heading="What ChatConvert stores">
        <s-paragraph>
          From a shopper: the chat transcript, and any contact details they choose to give —
          name, email address and phone number. ChatConvert also records the pages a shopper
          browsed during the chat, a coarse location derived from their connection, and, once a
          shopper is matched to a customer in your store, that Shopify customer ID.
        </s-paragraph>
        <s-paragraph>
          Chat content is sent to OpenAI to generate replies. Notification and invitation emails
          are sent through Resend. If you enable order tracking, order lookups are sent to
          17TRACK. No shopper data is sold or used to train models.
        </s-paragraph>
      </s-section>

      <s-section heading="How redaction works">
        <s-paragraph>
          ChatConvert honours Shopify&apos;s deletion webhooks automatically. A customer-redact
          request deletes that customer&apos;s contact record, conversations and messages.
        </s-paragraph>
        <s-paragraph>
          When you uninstall, ChatConvert keeps your data for 7 days so that reinstalling within
          that window restores everything; after 7 days it is erased. Shopify&apos;s shop-redact
          request (usually ~48h after uninstall) erases it immediately instead. Either way, only
          an anonymous record that the erasure happened is kept.
        </s-paragraph>
        <s-paragraph>
          The retention setting above applies while the app is installed: transcripts older than
          the window you choose are deleted on a rolling basis.
        </s-paragraph>
      </s-section>
    </s-stack>
  );
}
