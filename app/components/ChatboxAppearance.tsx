import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { WidgetSettingsData } from "../lib/settings/schemas";
import { ChatboxUploadButton } from "./ChatboxUploadButton";

// Chatbox → Appearance tab (spec 06): brand colors (solid/gradient presets +
// custom hex), launcher style/icon/position, remove-branding toggle.
// Widget-branded controls (swatches, launcher cards) keep custom styling per
// the polaris-admin-ui skill — the rest is standard Polaris.

type Appearance = WidgetSettingsData["appearance"];
type Launcher = Appearance["launcher"];

// Preset swatches from the design prototype (chatbox.html).
const SOLID_PRESETS = ["#6d3bf5", "#10b981", "#b91c1c", "#1e293b", "#0ea5e9", "#db2777"];
const GRADIENT_PRESETS: Array<{ start: string; end: string }> = [
  { start: "#7c3aed", end: "#6d3bf5" },
  { start: "#3b82f6", end: "#2563eb" },
  { start: "#10b981", end: "#059669" },
  { start: "#f97316", end: "#ea580c" },
  { start: "#ff99cc", end: "#ad8aff" },
  { start: "#3f3f46", end: "#18181b" },
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Hex input with a live color chip; commits only valid #rrggbb values. */
function HexField(props: { label: string; value: string; onCommit: (hex: string) => void }) {
  const [text, setText] = useState(props.value);
  useEffect(() => setText(props.value), [props.value]);
  const invalid = !HEX_RE.test(text);

  return (
    <s-stack direction="inline" gap="small" alignItems="end">
      <s-box minInlineSize="130px">
        <s-text-field
          label={props.label}
          value={text}
          error={invalid ? "Use #rrggbb format" : undefined}
          onInput={(e) => {
            const next = e.currentTarget.value;
            setText(next);
            if (HEX_RE.test(next)) props.onCommit(next);
          }}
        />
      </s-box>
      <div
        aria-hidden="true"
        style={{
          width: 28,
          height: 28,
          borderRadius: 7,
          background: invalid ? "#e9e9ec" : text,
          boxShadow: "inset 0 0 0 1px rgba(20,20,25,.12)",
          marginBottom: 4,
        }}
      />
    </s-stack>
  );
}

function Swatch(props: { background: string; selected: boolean; label: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      aria-pressed={props.selected}
      onClick={props.onSelect}
      style={{
        width: 30,
        height: 30,
        borderRadius: 9,
        border: "none",
        cursor: "pointer",
        background: props.background,
        boxShadow: props.selected
          ? "0 0 0 2px #fff, 0 0 0 4px #6d3bf5"
          : "inset 0 0 0 1px rgba(0,0,0,.06)",
      }}
    />
  );
}

const launcherGradient = (a: Appearance) =>
  a.colorMode === "solid"
    ? `linear-gradient(135deg, ${a.solid}, ${a.solid})`
    : `linear-gradient(135deg, ${a.gradient.start}, ${a.gradient.end})`;

function LauncherCard(props: {
  selected: boolean;
  label: string;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      onClick={props.onSelect}
      style={{
        border: props.selected ? "1.5px solid #141417" : "1.5px solid #dcdce1",
        borderRadius: 11,
        height: 62,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        cursor: "pointer",
        background: props.selected ? "#fff" : "#fbfbfc",
        flex: 1,
        fontFamily: "inherit",
      }}
    >
      {props.children}
      <span style={{ fontSize: 11, color: "#6b6b73" }}>{props.label}</span>
    </button>
  );
}

const CHAT_ICON = (
  <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path d="M4 5h12v8H8l-3 3V5Z" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
  </svg>
);
const HELP_ICON = (
  <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <circle cx="10" cy="10" r="7.5" stroke="#fff" strokeWidth="1.4" />
    <path
      d="M8 8a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6 1V11.5M10 14h.01"
      stroke="#fff"
      strokeWidth="1.4"
      strokeLinecap="round"
    />
  </svg>
);

export function ChatboxAppearance(props: {
  value: WidgetSettingsData;
  removeBrandingAllowed: boolean;
  onChange: (next: WidgetSettingsData) => void;
}) {
  const { value, onChange } = props;
  const appearance = value.appearance;
  const launcher = appearance.launcher;

  const setAppearance = (next: Partial<Appearance>) =>
    onChange({ ...value, appearance: { ...appearance, ...next } });
  const setLauncher = (next: Partial<Launcher>) =>
    setAppearance({ launcher: { ...launcher, ...next } });

  const bg = launcherGradient(appearance);
  const iconChipStyle = (selected: boolean): React.CSSProperties => ({
    width: 44,
    height: 44,
    borderRadius: 11,
    border: selected ? "1.5px solid #141417" : "1.5px solid #dcdce1",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    background: "#fff",
    padding: 0,
  });

  return (
    <s-stack gap="base">
      <s-section heading="Brand colors">
        <s-stack direction="inline" gap="small">
          <s-button
            variant={appearance.colorMode === "solid" ? "primary" : "tertiary"}
            onClick={() => setAppearance({ colorMode: "solid" })}
          >
            Solid
          </s-button>
          <s-button
            variant={appearance.colorMode === "gradient" ? "primary" : "tertiary"}
            onClick={() => setAppearance({ colorMode: "gradient" })}
          >
            Gradient
          </s-button>
        </s-stack>

        {appearance.colorMode === "solid" ? (
          <>
            <s-stack direction="inline" gap="small">
              {SOLID_PRESETS.map((hex) => (
                <Swatch
                  key={hex}
                  background={hex}
                  selected={appearance.solid.toLowerCase() === hex}
                  label={`Solid color ${hex}`}
                  onSelect={() => setAppearance({ solid: hex })}
                />
              ))}
            </s-stack>
            <HexField
              label="Custom color"
              value={appearance.solid}
              onCommit={(solid) => setAppearance({ solid })}
            />
          </>
        ) : (
          <>
            <s-stack direction="inline" gap="small">
              {GRADIENT_PRESETS.map((preset) => (
                <Swatch
                  key={preset.start}
                  background={`linear-gradient(135deg, ${preset.start}, ${preset.end})`}
                  selected={
                    appearance.gradient.start.toLowerCase() === preset.start &&
                    appearance.gradient.end.toLowerCase() === preset.end
                  }
                  label={`Gradient ${preset.start} to ${preset.end}`}
                  onSelect={() => setAppearance({ gradient: { ...preset } })}
                />
              ))}
            </s-stack>
            <s-stack direction="inline" gap="base">
              <HexField
                label="Start color"
                value={appearance.gradient.start}
                onCommit={(start) => setAppearance({ gradient: { ...appearance.gradient, start } })}
              />
              <HexField
                label="End color"
                value={appearance.gradient.end}
                onCommit={(end) => setAppearance({ gradient: { ...appearance.gradient, end } })}
              />
            </s-stack>
          </>
        )}
      </s-section>

      <s-section heading="Chatbox button">
        <s-stack gap="small">
          <s-text type="strong">Launcher</s-text>
          <s-stack direction="inline" gap="small">
            <LauncherCard
              selected={launcher.style === "icon"}
              label="Icon only"
              onSelect={() => setLauncher({ style: "icon" })}
            >
              <span
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: "50%",
                  background: bg,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {CHAT_ICON}
              </span>
            </LauncherCard>
            <LauncherCard
              selected={launcher.style === "label"}
              label="Label only"
              onSelect={() => setLauncher({ style: "label" })}
            >
              <span
                style={{
                  background: bg,
                  color: "#fff",
                  borderRadius: 20,
                  padding: "5px 10px",
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                {launcher.label || "Chat with us"}
              </span>
            </LauncherCard>
            <LauncherCard
              selected={launcher.style === "icon_label"}
              label="Icon & label"
              onSelect={() => setLauncher({ style: "icon_label" })}
            >
              <span
                style={{
                  background: bg,
                  color: "#fff",
                  borderRadius: 20,
                  padding: "5px 10px",
                  fontSize: 11,
                  fontWeight: 600,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                }}
              >
                {CHAT_ICON}
                {launcher.label || "Chat with us"}
              </span>
            </LauncherCard>
          </s-stack>
        </s-stack>

        {launcher.style !== "icon" ? (
          <s-text-field
            label="Launcher label"
            value={launcher.label}
            maxLength={40}
            onInput={(e) => setLauncher({ label: e.currentTarget.value })}
          />
        ) : null}

        <s-stack gap="small">
          <s-text type="strong">Launcher icon</s-text>
          <s-stack direction="inline" gap="small" alignItems="center">
            <button
              type="button"
              aria-label="Chat icon"
              aria-pressed={launcher.icon === "chat"}
              style={iconChipStyle(launcher.icon === "chat")}
              onClick={() => setLauncher({ icon: "chat" })}
            >
              <span
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: "50%",
                  background: bg,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {CHAT_ICON}
              </span>
            </button>
            <button
              type="button"
              aria-label="Help icon"
              aria-pressed={launcher.icon === "help"}
              style={iconChipStyle(launcher.icon === "help")}
              onClick={() => setLauncher({ icon: "help" })}
            >
              <span
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: "50%",
                  background: bg,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {HELP_ICON}
              </span>
            </button>
            {launcher.icon === "custom" && launcher.customIconUrl ? (
              <span style={iconChipStyle(true)} aria-label="Custom icon selected">
                <img
                  src={launcher.customIconUrl}
                  alt="Custom launcher icon"
                  style={{ width: 30, height: 30, borderRadius: 6, objectFit: "cover" }}
                />
              </span>
            ) : null}
            <ChatboxUploadButton
              intent="upload-icon"
              label="Upload icon"
              onUploaded={(url) => setLauncher({ icon: "custom", customIconUrl: url })}
            />
          </s-stack>
        </s-stack>

        <s-box maxInlineSize="220px">
          <s-select
            label="Launcher position"
            value={launcher.position}
            onChange={(e) =>
              setLauncher({ position: e.currentTarget.value as Launcher["position"] })
            }
          >
            <s-option value="bottom_right">Bottom right</s-option>
            <s-option value="bottom_left">Bottom left</s-option>
            <s-option value="top_right">Top right</s-option>
            <s-option value="top_left">Top left</s-option>
          </s-select>
        </s-box>
      </s-section>

      <s-section>
        <s-switch
          label={'Remove "Powered by ChatConvert"'}
          details="Hide the small ChatConvert credit at the bottom of the chat panel."
          checked={appearance.removeBranding}
          disabled={!props.removeBrandingAllowed}
          onChange={(e) => setAppearance({ removeBranding: e.currentTarget.checked })}
        />
        {!props.removeBrandingAllowed ? (
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-badge tone="info">Basic+</s-badge>
            <s-text tone="neutral">
              Available on the Basic plan and above — <Link to="/app/plan-usage">upgrade</Link>
            </s-text>
          </s-stack>
        ) : null}
      </s-section>
    </s-stack>
  );
}
