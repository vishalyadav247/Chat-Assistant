import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { ShopSettingsData, TeamMemberData } from "../lib/settings/schemas";
import { BrowseModalShell } from "./BrowseProductsModal";
import { ConfirmDeleteModal } from "./ui/ConfirmDeleteModal";

// Settings → General tab (spec 16): store info + logo, theme + embed status,
// inbox auto-resolution, team roster (invite/role/remove — powers inbox
// assignment; login access itself is managed by Shopify staff accounts).

type Inbox = ShopSettingsData["inbox"];
type Theme = ShopSettingsData["theme"];

export interface TeamMemberRow {
  name: string;
  email: string;
  since: string;
}

const EMPTY_INVITE = { name: "", email: "", role: "agent" as "agent" | "admin" };

export function SettingsGeneral(props: {
  name: string;
  placeholderName: string;
  logoUrl: string | null;
  theme: Theme;
  inbox: Inbox;
  embedStatus: "unknown" | "on" | "off";
  shopDomain: string;
  apiKey?: string;
  owner: TeamMemberRow;
  members: TeamMemberData[];
  reviewUrl: string | null;
  onNameChange: (name: string) => void;
  onThemeChange: (theme: Theme) => void;
  onInboxChange: (inbox: Inbox) => void;
}) {
  const shopify = useAppBridge();
  const uploadFetcher = useFetcher<{ ok: boolean; error?: string; logoUrl?: string }>();
  const fileRef = useRef<HTMLInputElement>(null);
  const [teamQuery, setTeamQuery] = useState("");

  // ── Team roster (self-contained fetcher, like the logo upload) ────────────
  const teamFetcher = useFetcher<{ ok: boolean; intent?: string; error?: string }>();
  const teamBusy = teamFetcher.state !== "idle";
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invite, setInvite] = useState(EMPTY_INVITE);
  const [removeTarget, setRemoveTarget] = useState<TeamMemberData | null>(null);
  const processedTeam = useRef<unknown>(null);
  useEffect(() => {
    if (teamFetcher.state !== "idle" || !teamFetcher.data) return;
    if (processedTeam.current === teamFetcher.data) return;
    processedTeam.current = teamFetcher.data;
    const result = teamFetcher.data;
    if (!result.intent?.startsWith("team-")) return;
    if (result.ok) {
      shopify.toast.show(
        result.intent === "team-invite"
          ? "Member added"
          : result.intent === "team-remove"
            ? "Member removed"
            : "Role updated",
      );
      setInviteOpen(false);
      setInvite(EMPTY_INVITE);
      setRemoveTarget(null);
    } else if (result.error) {
      shopify.toast.show(result.error, { isError: true });
    }
  }, [teamFetcher.state, teamFetcher.data, shopify]);

  const submitTeam = (intent: string, payload: Record<string, unknown>) =>
    teamFetcher.submit({ intent, payload: JSON.stringify(payload) }, { method: "post" });

  const inviteValid = invite.name.trim().length > 0 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(invite.email.trim());

  const uploading = uploadFetcher.state !== "idle";

  useEffect(() => {
    if (uploadFetcher.state === "idle" && uploadFetcher.data) {
      if (uploadFetcher.data.ok) {
        shopify.toast.show("Logo updated");
      } else if (uploadFetcher.data.error) {
        shopify.toast.show(uploadFetcher.data.error, { isError: true });
      }
    }
  }, [uploadFetcher.state, uploadFetcher.data, shopify]);

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.set("intent", "upload-logo");
    fd.set("logo", file);
    uploadFetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
    event.currentTarget.value = "";
  };

  const displayName = props.name || props.placeholderName;
  const initials =
    displayName
      .split(/\s+/)
      .map((word) => word[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "S";

  const query = teamQuery.trim().toLowerCase();
  const matches = (name: string, email: string) =>
    !query || name.toLowerCase().includes(query) || email.toLowerCase().includes(query);
  const ownerVisible = matches(props.owner.name, props.owner.email);
  const visibleMembers = props.members.filter((m) => matches(m.name, m.email));

  const embedBadge =
    props.embedStatus === "on"
      ? { tone: "success" as const, label: "On" }
      : props.embedStatus === "off"
        ? { tone: "critical" as const, label: "Off" }
        : { tone: "neutral" as const, label: "Unknown" };

  return (
    <s-stack gap="base">
      <s-section heading="Store information">
        <s-paragraph>Name and logo will be shown in conversations with customers</s-paragraph>
        <s-stack direction="inline" gap="large-200" alignItems="start">
          <s-box minInlineSize="260px">
            <s-text-field
              label="Name"
              value={props.name}
              placeholder={props.placeholderName}
              onInput={(e) => props.onNameChange(e.currentTarget.value)}
            />
          </s-box>
          <s-stack gap="small">
            <s-text>Logo</s-text>
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-avatar
                size="large"
                initials={initials}
                src={props.logoUrl ?? undefined}
                alt="Store logo"
              />
              <s-button
                icon="upload"
                disabled={uploading}
                onClick={() => fileRef.current?.click()}
              >
                {uploading ? "Uploading…" : "Upload logo"}
              </s-button>
            </s-stack>
          </s-stack>
        </s-stack>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          style={{ display: "none" }}
          aria-label="Upload store logo"
          onChange={onFile}
        />
      </s-section>

      <s-section heading="Theme">
        <s-select
          label="Storefront theme"
          value={props.theme}
          details="Helps the widget talk to your theme's cart (count bubble + drawer). Auto-detect works for most stores — pick your theme family only if the cart drawer doesn't open after an add to cart."
          onChange={(e) => props.onThemeChange(e.currentTarget.value as Theme)}
        >
          <s-option value="auto">Auto-detect (recommended)</s-option>
          <s-option value="dawn">Dawn</s-option>
          <s-option value="refresh">Refresh</s-option>
          <s-option value="craft">Craft</s-option>
          <s-option value="custom">Custom</s-option>
        </s-select>
        <s-divider />
        <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-text>App is embedded to your theme</s-text>
            <s-badge tone={embedBadge.tone}>{embedBadge.label}</s-badge>
          </s-stack>
          <s-button
            onClick={() =>
              window.open(
                `https://${props.shopDomain}/admin/themes/current/editor?context=apps${props.apiKey ? `&activateAppId=${props.apiKey}/chat-widget` : ""}`,
                "_blank",
              )
            }
          >
            Turn on
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Inbox">
        <s-switch
          label="Automatic resolution"
          details="Auto resolve conversations since the last message was sent by your team"
          checked={props.inbox.autoResolve}
          onChange={(e) => props.onInboxChange({ ...props.inbox, autoResolve: e.currentTarget.checked })}
        />
        {props.inbox.autoResolve ? (
          <s-stack direction="inline" gap="base" alignItems="end">
            <s-box minInlineSize="150px">
              <s-number-field
                label="Auto resolve after"
                min={1}
                value={String(props.inbox.after)}
                onChange={(e) => {
                  const after = Math.max(1, Math.floor(Number(e.currentTarget.value) || 1));
                  props.onInboxChange({ ...props.inbox, after });
                }}
              />
            </s-box>
            <s-box minInlineSize="150px">
              <s-select
                label="Unit"
                labelAccessibilityVisibility="exclusive"
                value={props.inbox.unit}
                onChange={(e) =>
                  props.onInboxChange({ ...props.inbox, unit: e.currentTarget.value as Inbox["unit"] })
                }
              >
                <s-option value="minute">Minute</s-option>
                <s-option value="hour">Hour</s-option>
                <s-option value="day">Day</s-option>
              </s-select>
            </s-box>
          </s-stack>
        ) : null}
      </s-section>

      <s-section heading="Team members">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
          <s-paragraph>Invite and manage your team members</s-paragraph>
          <s-button icon="person-add" variant="primary" onClick={() => setInviteOpen(true)}>
            Invite member
          </s-button>
        </s-stack>
        <s-banner tone="info">
          Members appear here for inbox assignment and reporting. To let them open ChatConvert,
          also give them staff access in your Shopify admin (Settings → Users and permissions).
        </s-banner>
        <s-search-field
          label="Search team members"
          labelAccessibilityVisibility="exclusive"
          placeholder="Search team member by name or email"
          value={teamQuery}
          onInput={(e) => setTeamQuery(e.currentTarget.value)}
        />
        <s-table variant="auto">
          <s-table-header-row>
            <s-table-header>Name</s-table-header>
            <s-table-header>Email</s-table-header>
            <s-table-header>Member since</s-table-header>
            <s-table-header>Role</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header> </s-table-header>
          </s-table-header-row>
          <s-table-body>
            {ownerVisible ? (
              <s-table-row>
                <s-table-cell>
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-avatar size="small" initials={initials} alt={props.owner.name} />
                    <s-text>{props.owner.name}</s-text>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>{props.owner.email}</s-table-cell>
                <s-table-cell>{props.owner.since}</s-table-cell>
                <s-table-cell>Owner</s-table-cell>
                <s-table-cell>
                  <s-badge tone="success">Active</s-badge>
                </s-table-cell>
                <s-table-cell> </s-table-cell>
              </s-table-row>
            ) : null}
            {visibleMembers.map((member) => (
              <s-table-row key={member.id}>
                <s-table-cell>
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-avatar
                      size="small"
                      initials={member.name
                        .split(/\s+/)
                        .map((w) => w[0])
                        .filter(Boolean)
                        .slice(0, 2)
                        .join("")
                        .toUpperCase()}
                      alt={member.name}
                    />
                    <s-text>{member.name}</s-text>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>{member.email}</s-table-cell>
                <s-table-cell>{member.since || "—"}</s-table-cell>
                <s-table-cell>
                  <s-select
                    label={`Role for ${member.name}`}
                    labelAccessibilityVisibility="exclusive"
                    value={member.role}
                    disabled={teamBusy}
                    onChange={(e) =>
                      submitTeam("team-role", { id: member.id, role: e.currentTarget.value })
                    }
                  >
                    <s-option value="admin">Admin</s-option>
                    <s-option value="agent">Agent</s-option>
                  </s-select>
                </s-table-cell>
                <s-table-cell>
                  <s-badge tone="success">Active</s-badge>
                </s-table-cell>
                <s-table-cell>
                  <s-button
                    variant="tertiary"
                    tone="critical"
                    icon="delete"
                    accessibilityLabel={`Remove ${member.name}`}
                    disabled={teamBusy}
                    onClick={() => setRemoveTarget(member)}
                  />
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        {!ownerVisible && visibleMembers.length === 0 ? (
          <s-text tone="neutral">No team members match your search.</s-text>
        ) : null}
      </s-section>

      {/* ── Leave a review (manual fallback for merchants the review modal
             can't reach: mobile, mid-cooldown, past the annual cap) ────────── */}
      {props.reviewUrl ? (
        <s-section heading="Enjoying ChatConvert?">
          <s-paragraph>
            Reviews help other merchants find us.{" "}
            {/* target="_blank" is required — the App Store refuses to load inside the admin iframe. */}
            <s-link href={props.reviewUrl} target="_blank">
              Leave a review on the Shopify App Store
            </s-link>
          </s-paragraph>
        </s-section>
      ) : null}

      {/* ── Invite member modal ──────────────────────────────────────────── */}
      <BrowseModalShell
        open={inviteOpen}
        title="Invite member"
        onClose={() => setInviteOpen(false)}
        footer={
          <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
            <s-button onClick={() => setInviteOpen(false)}>Cancel</s-button>
            <s-button
              variant="primary"
              disabled={!inviteValid || teamBusy}
              loading={teamBusy}
              onClick={() =>
                submitTeam("team-invite", {
                  name: invite.name.trim(),
                  email: invite.email.trim(),
                  role: invite.role,
                })
              }
            >
              Add member
            </s-button>
          </span>
        }
      >
        <s-stack gap="base">
          <s-text-field
            label="Name"
            value={invite.name}
            maxLength={100}
            onInput={(e) => setInvite({ ...invite, name: e.currentTarget.value })}
          />
          <s-email-field
            label="Email"
            value={invite.email}
            onInput={(e) => setInvite({ ...invite, email: e.currentTarget.value })}
          />
          <s-select
            label="Role"
            value={invite.role}
            onChange={(e) =>
              setInvite({ ...invite, role: e.currentTarget.value === "admin" ? "admin" : "agent" })
            }
          >
            <s-option value="agent">Agent — handles assigned conversations</s-option>
            <s-option value="admin">Admin — full app access</s-option>
          </s-select>
          <s-banner tone="info">
            To let this person open ChatConvert, also add them as staff in your Shopify admin:
            Settings → Users and permissions → Add staff.
          </s-banner>
        </s-stack>
      </BrowseModalShell>

      <ConfirmDeleteModal
        open={removeTarget !== null}
        title={`Remove ${removeTarget?.name ?? "this member"}?`}
        body="Their assigned conversations move back to Unassigned. This can't be undone."
        confirmLabel="Remove"
        loading={teamBusy}
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => removeTarget && submitTeam("team-remove", { id: removeTarget.id })}
      />
    </s-stack>
  );
}
