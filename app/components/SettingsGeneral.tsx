import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { ShopSettingsData } from "../lib/settings/schemas";

// Settings → General tab (spec 16): store info + logo, theme + embed status,
// inbox auto-resolution, team member table (v1 single-user).

type Inbox = ShopSettingsData["inbox"];
type Theme = ShopSettingsData["theme"];

export interface TeamMemberRow {
  name: string;
  email: string;
  since: string;
}

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
  onNameChange: (name: string) => void;
  onThemeChange: (theme: Theme) => void;
  onInboxChange: (inbox: Inbox) => void;
}) {
  const shopify = useAppBridge();
  const uploadFetcher = useFetcher<{ ok: boolean; error?: string; logoUrl?: string }>();
  const fileRef = useRef<HTMLInputElement>(null);
  const [teamQuery, setTeamQuery] = useState("");

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
  const members = [props.owner].filter(
    (m) => !query || m.name.toLowerCase().includes(query) || m.email.toLowerCase().includes(query),
  );

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

      <s-section heading="Team member">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
          <s-paragraph>Invite and manage your team members</s-paragraph>
          <s-button disabled={true} icon="person-add">
            Invite member
            <s-tooltip>Team invites are coming soon</s-tooltip>
          </s-button>
        </s-stack>
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
          </s-table-header-row>
          <s-table-body>
            {members.map((member) => (
              <s-table-row key={member.email}>
                <s-table-cell>
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-avatar size="small" initials={initials} alt={member.name} />
                    <s-text>{member.name}</s-text>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>{member.email}</s-table-cell>
                <s-table-cell>{member.since}</s-table-cell>
                <s-table-cell>Admin</s-table-cell>
                <s-table-cell>
                  <s-badge tone="success">Active</s-badge>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        {members.length === 0 ? <s-text tone="neutral">No team members match your search.</s-text> : null}
      </s-section>
    </s-stack>
  );
}
