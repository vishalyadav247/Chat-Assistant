import { Link } from "react-router";
import type { WidgetSettingsData } from "../lib/settings/schemas";
import { ChatboxUploadButton } from "./ChatboxUploadButton";
import { TabPills } from "./ui/TabPills";

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

/** s-color-field values normalized to #rrggbb ("" when unparsable) so the
 *  schema regex never silently resets a stored color. */
const normalizeHex = (raw: string): string => {
  const v = raw.trim().replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(v) ? `#${v.toLowerCase()}` : "";
};

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

/** Compact setting row: muted label column + control (launcher section). */
function LauncherRow(props: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "96px minmax(0, 1fr)",
        alignItems: "center",
        gap: 12,
      }}
    >
      <s-text tone="neutral">{props.label}</s-text>
      <div style={{ minWidth: 0 }}>{props.children}</div>
    </div>
  );
}

const launcherGradient = (a: Appearance) =>
  a.colorMode === "solid"
    ? `linear-gradient(135deg, ${a.solid}, ${a.solid})`
    : `linear-gradient(135deg, ${a.gradient.start}, ${a.gradient.end})`;

const CHAT_ICON = (
  <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path d="M4 5h12v8H8l-3 3V5Z" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
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

  // Launcher previews honor the custom button background when set.
  const bg = launcher.bgColor || launcherGradient(appearance);
  const brandHex = appearance.colorMode === "solid" ? appearance.solid : appearance.gradient.start;
  const iconChipStyle = (selected: boolean): React.CSSProperties => ({
    width: 36,
    height: 36,
    borderRadius: 10,
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
        <s-stack gap="base">
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
            <div style={{ width: 130 }}>
              <s-color-field
                label="Custom color"
                value={appearance.solid}
                onInput={(e) => {
                  const solid = normalizeHex(e.currentTarget.value);
                  if (solid) setAppearance({ solid });
                }}
                onChange={(e) => {
                  const solid = normalizeHex(e.currentTarget.value);
                  if (solid) setAppearance({ solid });
                }}
              />
            </div>
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
              <div style={{ width: 130 }}>
                <s-color-field
                  label="Start color"
                  value={appearance.gradient.start}
                  onInput={(e) => {
                    const start = normalizeHex(e.currentTarget.value);
                    if (start) setAppearance({ gradient: { ...appearance.gradient, start } });
                  }}
                  onChange={(e) => {
                    const start = normalizeHex(e.currentTarget.value);
                    if (start) setAppearance({ gradient: { ...appearance.gradient, start } });
                  }}
                />
              </div>
              <div style={{ width: 130 }}>
                <s-color-field
                  label="End color"
                  value={appearance.gradient.end}
                  onInput={(e) => {
                    const end = normalizeHex(e.currentTarget.value);
                    if (end) setAppearance({ gradient: { ...appearance.gradient, end } });
                  }}
                  onChange={(e) => {
                    const end = normalizeHex(e.currentTarget.value);
                    if (end) setAppearance({ gradient: { ...appearance.gradient, end } });
                  }}
                />
              </div>
            </s-stack>
          </>
        )}
        </s-stack>
      </s-section>

      <s-section heading="Launcher">
        <s-stack gap="base">
        {/* Compact labeled rows (user request 2026-08-12): segmented style
            pills + inline controls — the live preview shows the result. */}
        <LauncherRow label="Style">
          <TabPills
            size="small"
            tabs={[
              { id: "icon", label: "Icon only" },
              { id: "label", label: "Label only" },
              { id: "icon_label", label: "Icon & label" },
            ]}
            active={launcher.style}
            onChange={(style) => setLauncher({ style })}
          />
        </LauncherRow>

        {/* Rows stay visible for every style (user request 2026-08-13): the
            style pills only change the storefront rendering, not the form. */}
        <LauncherRow label="Label">
          <div style={{ maxWidth: 280 }}>
            <s-text-field
              label="Launcher label"
              labelAccessibilityVisibility="exclusive"
              placeholder="Chat with us"
              value={launcher.label}
              maxLength={40}
              onInput={(e) => setLauncher({ label: e.currentTarget.value })}
            />
          </div>
        </LauncherRow>

        <LauncherRow label="Color">
          <div style={{ width: 120 }}>
            <s-color-field
              label="Label color"
              labelAccessibilityVisibility="exclusive"
              value={launcher.labelColor || "#ffffff"}
              onInput={(e) => setLauncher({ labelColor: normalizeHex(e.currentTarget.value) })}
              onChange={(e) => setLauncher({ labelColor: normalizeHex(e.currentTarget.value) })}
            />
          </div>
        </LauncherRow>

        <LauncherRow label="Background">
          {/* Toggle (user request 2026-08-13): brand color by default; turning
              it off enables the picker. Empty bgColor = brand (effective value
              the widget reads); customBgColor remembers the merchant's pick so
              toggling brand on and off again restores it instead of resetting
              the picker to the brand hex (user request 2026-08-17). */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <s-switch
              label="Use brand color"
              checked={!launcher.bgColor}
              onChange={(e) =>
                setLauncher({
                  bgColor: e.currentTarget.checked ? "" : launcher.customBgColor || brandHex,
                })
              }
            />
            <div style={{ width: 120 }}>
              {/* Always visible; editable only with the brand toggle off. A
                  disabled field fires no change events, so the value it
                  displays never writes back into bgColor. */}
              <s-color-field
                label="Button background color"
                labelAccessibilityVisibility="exclusive"
                disabled={!launcher.bgColor}
                value={launcher.bgColor || launcher.customBgColor || brandHex}
                onInput={(e) => {
                  const bgColor = normalizeHex(e.currentTarget.value);
                  if (bgColor) setLauncher({ bgColor, customBgColor: bgColor });
                }}
                onChange={(e) => {
                  const bgColor = normalizeHex(e.currentTarget.value);
                  if (bgColor) setLauncher({ bgColor, customBgColor: bgColor });
                }}
              />
            </div>
          </div>
        </LauncherRow>

        <LauncherRow label="Icon">
          <s-stack gap="small-300">
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              aria-label="Chat icon"
              aria-pressed={launcher.icon === "chat"}
              style={iconChipStyle(launcher.icon === "chat")}
              onClick={() => setLauncher({ icon: "chat" })}
            >
              <span
                style={{
                  width: 26,
                  height: 26,
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
            {/* The uploaded icon stays as a selectable chip even when the
                default is active (user request 2026-08-17) — picking the
                default no longer discards the upload; only the ✕ does. */}
            {launcher.customIconUrl ? (
              <span style={{ position: "relative", display: "inline-flex" }}>
                <button
                  type="button"
                  aria-label="Uploaded icon"
                  aria-pressed={launcher.icon === "custom"}
                  style={iconChipStyle(launcher.icon === "custom")}
                  onClick={() => setLauncher({ icon: "custom" })}
                >
                  <img
                    src={launcher.customIconUrl}
                    alt=""
                    style={{ width: 26, height: 26, borderRadius: 6, objectFit: "cover" }}
                  />
                </button>
                <button
                  type="button"
                  aria-label="Remove uploaded icon"
                  title="Remove uploaded icon"
                  onClick={() =>
                    setLauncher({
                      customIconUrl: null,
                      icon: launcher.icon === "custom" ? "chat" : launcher.icon,
                    })
                  }
                  style={{
                    position: "absolute",
                    top: -6,
                    right: -6,
                    width: 16,
                    height: 16,
                    borderRadius: "50%",
                    border: "1px solid #dcdce1",
                    background: "#fff",
                    color: "#141417",
                    fontSize: 10,
                    lineHeight: 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    padding: 0,
                    boxShadow: "0 1px 2px rgba(0,0,0,.12)",
                  }}
                >
                  ✕
                </button>
              </span>
            ) : null}
            <ChatboxUploadButton
              intent="upload-icon"
              label="Upload icon"
              accept="image/png,image/svg+xml"
              onUploaded={(url) => setLauncher({ icon: "custom", customIconUrl: url })}
            />
          </div>
          <s-text tone="neutral">SVG or PNG · square, at least 64×64 px</s-text>
          </s-stack>
        </LauncherRow>

        <LauncherRow label="Position">
          <div style={{ width: 160 }}>
            <s-select
              label="Launcher position"
              labelAccessibilityVisibility="exclusive"
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
          </div>
        </LauncherRow>
        </s-stack>
      </s-section>

      <s-section>
        <s-stack gap="base">
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
        </s-stack>
      </s-section>
    </s-stack>
  );
}
