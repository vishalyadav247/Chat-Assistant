import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "../lib/ui/surface";
import { useIsMobile } from "../lib/ui/use-mobile";
import type { ShopSettingsData } from "../lib/settings/schemas";
import {
  dateFormatOptions,
  timeFormatOptions,
  formatDateTime,
  SAMPLE_INSTANT,
  type DateFormat,
  type TimeFormat,
} from "../lib/format/datetime";
import type { MemberRow } from "../lib/team/team.server";
import type { TeamIntentResult } from "../lib/team/team-intents.server";
import { BrowseModalShell } from "./BrowseProductsModal";
import { ConfirmDeleteModal } from "./ui/ConfirmDeleteModal";
import { OpenInWebButton } from "./web/OpenInWebButton";

// Settings → General tab (spec 16): store info + logo, theme + embed status,
// inbox auto-resolution, team (spec 18: invite → email/copy-link → member sets
// a password and signs into the standalone web app; roles gate pages there).

type Inbox = ShopSettingsData["inbox"];
type Theme = ShopSettingsData["theme"];

export interface TeamMemberRow {
  name: string;
  email: string;
  since: string;
}

export interface TeamSectionData {
  members: MemberRow[];
  seatsUsed: number;
  /** null = unlimited. */
  seatQuota: number | null;
  emailConfigured: boolean;
  surface: "admin" | "web";
  /** The signed-in member on the web surface (can't edit themselves). */
  selfId: string | null;
}

const EMPTY_INVITE = { name: "", email: "", role: "agent" as "agent" | "admin" };

export function SettingsGeneral(props: {
  name: string;
  /** Global date/time display format (spec 16 delta 2026-08-19). */
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
  timeZone: string;
  onDateFormatChange: (value: DateFormat) => void;
  onTimeFormatChange: (value: TimeFormat) => void;
  onOpenAvailability: () => void;
  placeholderName: string;
  logoUrl: string | null;
  theme: Theme;
  inbox: Inbox;
  embedStatus: "unknown" | "on" | "off";
  shopDomain: string;
  apiKey?: string;
  owner: TeamMemberRow;
  team: TeamSectionData;
  reviewUrl: string | null;
  onNameChange: (name: string) => void;
  onThemeChange: (theme: Theme) => void;
  onInboxChange: (inbox: Inbox) => void;
}) {
  const shopify = useAppBridge();
  const uploadFetcher = useFetcher<{ ok: boolean; intent?: string; error?: string; logoUrl?: string }>();
  const fileRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();
  const [teamQuery, setTeamQuery] = useState("");

  // ── Team roster (self-contained fetcher, like the logo upload) ────────────
  const teamFetcher = useFetcher<TeamIntentResult>();
  const teamBusy = teamFetcher.state !== "idle";
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invite, setInvite] = useState(EMPTY_INVITE);
  const [removeTarget, setRemoveTarget] = useState<MemberRow | null>(null);
  // Copy-link reveal after invite / resend / reset-link (always offered; the
  // email may or may not have gone out depending on EMAIL_PROVIDER).
  const [linkReveal, setLinkReveal] = useState<{ title: string; link: string; emailDelivered: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const processedTeam = useRef<unknown>(null);
  useEffect(() => {
    if (teamFetcher.state !== "idle" || !teamFetcher.data) return;
    if (processedTeam.current === teamFetcher.data) return;
    processedTeam.current = teamFetcher.data;
    const result = teamFetcher.data;
    if (!result.intent?.startsWith("team-")) return;
    if (result.ok) {
      const messages: Record<string, string> = {
        "team-invite": "Invitation created",
        "team-resend": "Invitation re-sent",
        "team-reset-link": "Password reset link created",
        "team-remove": "Member removed",
        "team-role": "Role updated",
        "team-status": "Member updated",
      };
      shopify.toast.show(messages[result.intent] ?? "Saved");
      setInviteOpen(false);
      setInvite(EMPTY_INVITE);
      setRemoveTarget(null);
      if (result.link) {
        setCopied(false);
        setLinkReveal({
          title: result.intent === "team-reset-link" ? "Password reset link" : "Invitation link",
          link: result.link,
          emailDelivered: Boolean(result.emailDelivered),
        });
      }
    } else if (result.error) {
      shopify.toast.show(result.error, { isError: true });
    }
  }, [teamFetcher.state, teamFetcher.data, shopify]);

  const copyLink = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      shopify.toast.show("Link copied");
    } catch {
      shopify.toast.show("Couldn't copy — select the link and copy it manually", { isError: true });
    }
  };

  const submitTeam = (intent: string, payload: Record<string, unknown>) =>
    teamFetcher.submit({ intent, payload: JSON.stringify(payload) }, { method: "post" });

  const inviteValid = invite.name.trim().length > 0 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(invite.email.trim());

  // Upload and ✕ share the fetcher but must not share UI state — otherwise
  // removing flips the Upload button into "Uploading…".
  const inFlightIntent =
    uploadFetcher.state !== "idle" ? uploadFetcher.formData?.get("intent") : null;
  const uploading = inFlightIntent === "upload-logo";
  const removing = inFlightIntent === "remove-logo";

  useEffect(() => {
    if (uploadFetcher.state === "idle" && uploadFetcher.data) {
      if (uploadFetcher.data.ok) {
        shopify.toast.show(uploadFetcher.data.intent === "remove-logo" ? "Logo removed" : "Logo updated");
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
  const visibleMembers = props.team.members.filter((m) => matches(m.name, m.email));
  const seatsLeft = props.team.seatQuota === null ? Infinity : Math.max(0, props.team.seatQuota - props.team.seatsUsed);
  const memberInitials = (name: string) =>
    name
      .split(/\s+/)
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase();
  const statusBadge = (m: MemberRow) =>
    m.status === "active" ? (
      <s-badge tone="success">Active</s-badge>
    ) : m.status === "disabled" ? (
      <s-badge tone="critical">Disabled</s-badge>
    ) : (
      <s-badge tone="warning">Invited</s-badge>
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
        <s-stack gap="base">
          <s-box maxInlineSize="360px">
            <s-text-field
              label="Name"
              maxLength={100}
              value={props.name}
              placeholder={props.placeholderName}
              onInput={(e) => props.onNameChange(e.currentTarget.value)}
            />
          </s-box>
          {/* Logo below the name (user request 2026-08-17); ✕ removes it
              (immediate, like the upload — own fetcher, not the save bar). */}
          <s-stack gap="small">
            <s-text>Logo</s-text>
            <s-stack direction="inline" gap="base" alignItems="center">
              <div style={{ position: "relative" }}>
                {/* Same box + placeholder as the chatbox header logo (user
                    request 2026-08-17) — no initials avatar here. */}
                <s-thumbnail size="large" src={props.logoUrl ?? undefined} alt="Store logo" />
                {props.logoUrl ? (
                  <button
                    type="button"
                    aria-label="Remove logo"
                    title="Remove logo"
                    disabled={removing || uploading}
                    onClick={() => {
                      const fd = new FormData();
                      fd.set("intent", "remove-logo");
                      uploadFetcher.submit(fd, { method: "post" });
                    }}
                    style={{
                      position: "absolute",
                      top: -6,
                      right: -6,
                      width: 18,
                      height: 18,
                      padding: 0,
                      borderRadius: "50%",
                      border: "1px solid var(--s-color-border, #d4d4d8)",
                      background: "var(--s-color-bg, #fff)",
                      boxShadow: "0 1px 2px rgba(20,20,25,.18)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: "pointer",
                      fontSize: 10,
                      lineHeight: 1,
                      color: "var(--s-color-text-secondary, #5a5a63)",
                    }}
                  >
                    ✕
                  </button>
                ) : null}
              </div>
              <s-stack gap="small-200">
                <s-button
                  icon="upload"
                  disabled={uploading || removing}
                  onClick={() => fileRef.current?.click()}
                >
                  {uploading ? "Uploading…" : props.logoUrl ? "Change logo" : "Upload logo"}
                </s-button>
                {/* Same file guidance as the chatbox logo/icon uploads. */}
                <s-text tone="neutral">SVG, PNG or JPG · square, up to 2MB</s-text>
              </s-stack>
            </s-stack>
          </s-stack>
        </s-stack>
        {/* ── Date & time format (global; merchants worldwide) ─────────── */}
        <s-stack gap="small-200">
          <s-text type="strong">Date &amp; time format</s-text>
          <s-text tone="neutral">
            Used everywhere in ChatConvert — inbox, contacts, analytics, exports. Times are shown in your store
            time zone ({props.timeZone}) —{" "}
            <s-link onClick={props.onOpenAvailability}>change it in Chat availability</s-link>.
          </s-text>
          <s-grid gridTemplateColumns={isMobile ? "minmax(0,1fr)" : "minmax(0,1fr) minmax(0,1fr)"} gap="base">
            <s-select
              label="Date format"
              value={props.dateFormat}
              onChange={(e) => props.onDateFormatChange(e.currentTarget.value as DateFormat)}
            >
              {dateFormatOptions(SAMPLE_INSTANT, props.timeZone).map((o) => (
                <s-option key={o.value} value={o.value}>
                  {o.label}
                </s-option>
              ))}
            </s-select>
            <s-select
              label="Time format"
              value={props.timeFormat}
              onChange={(e) => props.onTimeFormatChange(e.currentTarget.value as TimeFormat)}
            >
              {timeFormatOptions(SAMPLE_INSTANT, props.timeZone).map((o) => (
                <s-option key={o.value} value={o.value}>
                  {o.label}
                </s-option>
              ))}
            </s-select>
          </s-grid>
          <s-text tone="neutral">
            Example:{" "}
            {formatDateTime(SAMPLE_INSTANT, { dateFormat: props.dateFormat, timeFormat: props.timeFormat, timeZone: props.timeZone })}
          </s-text>
        </s-stack>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
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
          <s-paragraph>
            Invite teammates to review and reply to conversations in the ChatConvert web app —
            no Shopify staff account needed.
          </s-paragraph>
          <s-stack direction="inline" gap="small" alignItems="center">
            <OpenInWebButton />
            <s-button
              icon="person-add"
              variant="primary"
              disabled={seatsLeft === 0}
              onClick={() => setInviteOpen(true)}
            >
              Invite member
            </s-button>
          </s-stack>
        </s-stack>
        <s-text tone="neutral">
          {props.team.seatQuota === null
            ? `${props.team.seatsUsed} team member${props.team.seatsUsed === 1 ? "" : "s"}`
            : `${props.team.seatsUsed} of ${props.team.seatQuota} team seat${props.team.seatQuota === 1 ? "" : "s"} used${seatsLeft === 0 ? " — upgrade your plan to invite more." : ""}`}
        </s-text>
        {!props.team.emailConfigured ? (
          <s-banner tone="info">
            Invitation emails aren&apos;t configured on this server yet — after inviting someone, copy the
            invitation link and send it to them yourself.
          </s-banner>
        ) : null}
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
            {visibleMembers.map((member) => {
              const isSelf = props.team.selfId === member.id;
              return (
                <s-table-row key={member.id}>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small" alignItems="center">
                      <s-avatar size="small" initials={memberInitials(member.name)} alt={member.name} />
                      <s-text>
                        {member.name}
                        {isSelf ? " (you)" : ""}
                      </s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{member.email}</s-table-cell>
                  <s-table-cell>{member.since || "—"}</s-table-cell>
                  <s-table-cell>
                    <s-select
                      label={`Role for ${member.name}`}
                      labelAccessibilityVisibility="exclusive"
                      value={member.role}
                      disabled={teamBusy || isSelf}
                      onChange={(e) =>
                        submitTeam("team-role", { id: member.id, role: e.currentTarget.value })
                      }
                    >
                      <s-option value="admin">Admin</s-option>
                      <s-option value="agent">Agent</s-option>
                    </s-select>
                  </s-table-cell>
                  <s-table-cell>{statusBadge(member)}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200" alignItems="center">
                      {member.status === "invited" ? (
                        <s-button
                          variant="tertiary"
                          icon="email"
                          accessibilityLabel={`Resend invitation to ${member.name}`}
                          disabled={teamBusy}
                          onClick={() => submitTeam("team-resend", { id: member.id })}
                        >
                          Resend invite
                        </s-button>
                      ) : null}
                      {member.status === "active" && !isSelf ? (
                        <s-button
                          variant="tertiary"
                          icon="key"
                          accessibilityLabel={`Password reset link for ${member.name}`}
                          disabled={teamBusy}
                          onClick={() => submitTeam("team-reset-link", { id: member.id })}
                        >
                          Reset link
                        </s-button>
                      ) : null}
                      {member.status !== "invited" && !isSelf ? (
                        <s-button
                          variant="tertiary"
                          accessibilityLabel={`${member.status === "disabled" ? "Enable" : "Disable"} ${member.name}`}
                          disabled={teamBusy}
                          onClick={() =>
                            submitTeam("team-status", {
                              id: member.id,
                              status: member.status === "disabled" ? "active" : "disabled",
                            })
                          }
                        >
                          {member.status === "disabled" ? "Enable" : "Disable"}
                        </s-button>
                      ) : null}
                      {!isSelf ? (
                        <s-button
                          variant="tertiary"
                          tone="critical"
                          icon="delete"
                          accessibilityLabel={`Remove ${member.name}`}
                          disabled={teamBusy}
                          onClick={() => setRemoveTarget(member)}
                        />
                      ) : null}
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              );
            })}
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
              Send invitation
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
            They&apos;ll get a link to set their password and sign in to the ChatConvert web app.
            Agents see Inbox and Contacts; Admins see everything except billing.
          </s-banner>
        </s-stack>
      </BrowseModalShell>

      {/* ── Invite / reset link reveal ──────────────────────────────────── */}
      <BrowseModalShell
        open={linkReveal !== null}
        title={linkReveal?.title ?? "Link"}
        onClose={() => setLinkReveal(null)}
        footer={
          <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
            <s-button onClick={() => setLinkReveal(null)}>Done</s-button>
            <s-button variant="primary" icon="clipboard" onClick={() => linkReveal && copyLink(linkReveal.link)}>
              {copied ? "Copied" : "Copy link"}
            </s-button>
          </span>
        }
      >
        <s-stack gap="base">
          <s-paragraph>
            {linkReveal?.emailDelivered
              ? "We emailed this link. You can also share it directly:"
              : "Share this link with them directly (email delivery isn't configured on this server):"}
          </s-paragraph>
          <div
            style={{
              padding: 10,
              borderRadius: 8,
              background: "#f6f6f7",
              border: "1px solid #e3e3e3",
              fontSize: 12.5,
              wordBreak: "break-all",
              userSelect: "all",
            }}
          >
            {linkReveal?.link}
          </div>
          <s-text tone="neutral">
            {linkReveal?.title === "Password reset link" ? "Valid for 1 hour." : "Valid for 7 days."}
          </s-text>
        </s-stack>
      </BrowseModalShell>

      <ConfirmDeleteModal
        open={removeTarget !== null}
        title={`Remove ${removeTarget?.name ?? "this member"}?`}
        body="They lose access to the web app immediately and their assigned conversations move back to Unassigned. This can't be undone."
        confirmLabel="Remove"
        loading={teamBusy}
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => removeTarget && submitTeam("team-remove", { id: removeTarget.id })}
      />
    </s-stack>
  );
}
