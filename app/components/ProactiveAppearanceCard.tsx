import { useState } from "react";
import type { CampaignSettingsData } from "../lib/settings/schemas";
import type { CampaignDraft } from "./ProactiveCampaignEditor";
import { RADIUS, SPACE } from "./ui/tokens";

// Proactive-chat editor → Appearance card (spec 12). Bubble colors are stored
// per campaign, not inherited from the chatbox theme, so a shop can run a white
// welcome bubble and a near-black cart nudge side by side. Swatch values are
// read off the design reference (.claude/resources/proactive_chat/*.png).

type Field = keyof CampaignSettingsData["appearance"];

const BACKGROUND_PRESETS = [
  "#ffffff",
  "#2b2b30",
  "#10233f",
  "#113a35",
  "#3b1a5c",
  "#6b0f24",
  "#cfeafc",
  "#fbe7c0",
  "#e6ddfc",
  "#fbcfd8",
];

const INK_PRESETS = ["#ffffff", "#1a1a1f"];

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
        borderRadius: RADIUS.chip + 1,
        border: "none",
        cursor: "pointer",
        background: props.background,
        boxShadow: props.selected
          ? "0 0 0 2px #fff, 0 0 0 4px #6d3bf5"
          : "inset 0 0 0 1px rgba(0,0,0,.14)",
      }}
    />
  );
}

/** Preset row + a custom-hex escape hatch (the design's gradient pencil chip). */
function ColorRow(props: {
  label: string;
  details?: string;
  presets: string[];
  value: string;
  onChange: (hex: string) => void;
}) {
  const [customOpen, setCustomOpen] = useState(false);
  const isPreset = props.presets.some((p) => p.toLowerCase() === props.value.toLowerCase());
  return (
    <s-stack gap="small-300">
      <s-text>{props.label}</s-text>
      {props.details ? <s-text tone="neutral">{props.details}</s-text> : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: SPACE.sm, alignItems: "center" }}>
        {props.presets.map((hex) => (
          <Swatch
            key={hex}
            background={hex}
            selected={!customOpen && props.value.toLowerCase() === hex.toLowerCase()}
            label={`${props.label} ${hex}`}
            onSelect={() => {
              setCustomOpen(false);
              props.onChange(hex);
            }}
          />
        ))}
        <button
          type="button"
          aria-label={`Custom ${props.label.toLowerCase()}`}
          aria-pressed={customOpen || !isPreset}
          onClick={() => setCustomOpen((v) => !v)}
          style={{
            width: 30,
            height: 30,
            borderRadius: RADIUS.chip + 1,
            border: "none",
            cursor: "pointer",
            color: "#fff",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: "linear-gradient(135deg,#c084fc,#ec4899)",
            boxShadow:
              customOpen || !isPreset ? "0 0 0 2px #fff, 0 0 0 4px #6d3bf5" : "inset 0 0 0 1px rgba(0,0,0,.14)",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M13.4 2.6a2 2 0 0 1 2.8 2.8l-8 8-3.6.8.8-3.6 8-8Z" />
          </svg>
        </button>
      </div>
      {customOpen || !isPreset ? (
        <s-color-field
          label={`${props.label} (custom)`}
          value={props.value}
          onInput={(e) => {
            const hex = normalizeHex(e.currentTarget.value);
            if (hex) props.onChange(hex);
          }}
        />
      ) : null}
    </s-stack>
  );
}

export function ProactiveAppearanceCard(props: {
  draft: CampaignDraft;
  setDraft: (updater: (d: CampaignDraft) => CampaignDraft) => void;
}) {
  const appearance = props.draft.settings.appearance;
  const set = (field: Field) => (hex: string) =>
    props.setDraft((d) => ({
      ...d,
      settings: { ...d.settings, appearance: { ...d.settings.appearance, [field]: hex } },
    }));

  // Text-only bubbles have no buttons to color — the design hides those rows.
  const hasButtons = props.draft.settings.message.kind !== "text";

  return (
    <s-section heading="Appearance">
      <s-stack gap="base">
        <ColorRow
          label="Background color"
          details="Background color of the message bubble shown to visitors."
          presets={BACKGROUND_PRESETS}
          value={appearance.background}
          onChange={set("background")}
        />
        <ColorRow
          label="Text color"
          details="Text color of the message shown to visitors."
          presets={INK_PRESETS}
          value={appearance.textColor}
          onChange={set("textColor")}
        />
        {hasButtons ? (
          <>
            <ColorRow
              label="Button background color"
              presets={INK_PRESETS}
              value={appearance.buttonBackground}
              onChange={set("buttonBackground")}
            />
            <ColorRow
              label="Button label color"
              presets={INK_PRESETS}
              value={appearance.buttonLabelColor}
              onChange={set("buttonLabelColor")}
            />
          </>
        ) : null}
      </s-stack>
    </s-section>
  );
}
