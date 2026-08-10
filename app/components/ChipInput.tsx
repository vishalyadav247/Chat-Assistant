import { useState } from "react";

// Chip input (08 trigger questions, 09 synonyms, 16 survey keywords):
// Enter adds a chip, ✕ removes. Values deduplicated case-insensitively.

export function ChipInput(props: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  maxLength?: number;
  label?: string;
}) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const value = draft.trim().slice(0, props.maxLength ?? 100);
    if (!value) return;
    if (props.values.some((v) => v.toLowerCase() === value.toLowerCase())) {
      setDraft("");
      return;
    }
    props.onChange([...props.values, value]);
    setDraft("");
  };

  return (
    <s-stack gap="small">
      {props.label ? <s-text>{props.label}</s-text> : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {props.values.map((value) => (
          <span
            key={value}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 8px",
              borderRadius: 12,
              background: "var(--s-color-bg-fill-secondary, #f1f1f1)",
              fontSize: 13,
            }}
          >
            {value}
            <button
              type="button"
              aria-label={`Remove ${value}`}
              onClick={() => props.onChange(props.values.filter((v) => v !== value))}
              style={{
                border: "none",
                background: "none",
                cursor: "pointer",
                padding: 0,
                display: "inline-flex",
                alignItems: "center",
              }}
            >
              <s-icon type="x" size="small" />
            </button>
          </span>
        ))}
      </div>
      <input
        type="text"
        value={draft}
        placeholder={props.placeholder ?? "Type and press Enter"}
        maxLength={props.maxLength ?? 100}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
        style={{
          padding: "6px 10px",
          borderRadius: 8,
          border: "1px solid var(--s-color-border, #d4d4d4)",
          font: "inherit",
        }}
      />
    </s-stack>
  );
}
