import type { ReactNode } from "react";

// One radio row that can reveal its own settings directly beneath it.
//
// Polaris's `<s-choice-list>` flattens `<s-choice>` children to text — you
// can't nest a field inside an option ("component types other than choice
// can't be used as options"). The working pattern, first proven by the
// order-tracking modes in SettingsChatbox, is ONE single-choice list per
// option, all sharing a `name`, with the revealed panel rendered as a sibling.
// Extracted here because the proactive-chat editor needs it a dozen times.

export function RadioOption<T extends string>(props: {
  /** Radio group name — every option in one group must share it. */
  name: string;
  value: T;
  /** Currently selected value in the group. */
  selected: T;
  label: string;
  /** Secondary line under the label (the design's help text). */
  details?: string;
  disabled?: boolean;
  /** Trailing badge, e.g. an upgrade chip on a gated option. */
  badge?: ReactNode;
  onSelect: (value: T) => void;
  /** Revealed directly beneath THIS option while it is selected. */
  children?: ReactNode;
}) {
  const isSelected = props.selected === props.value;
  return (
    <s-stack gap="small-300">
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-choice-list
          label={props.label}
          labelAccessibilityVisibility="exclusive"
          name={props.name}
          disabled={props.disabled}
          values={isSelected ? [props.value] : []}
          onInput={(e) => {
            // A radio can only ever be turned ON; ignore the de-select event
            // the previously checked list fires so two clicks can't clear the
            // group.
            if (e.currentTarget.values.includes(props.value)) props.onSelect(props.value);
          }}
        >
          <s-choice value={props.value}>
            {props.label}
            {props.details ? <s-text slot="details">{props.details}</s-text> : null}
          </s-choice>
        </s-choice-list>
        {props.badge}
      </s-stack>
      {isSelected && props.children ? (
        <s-box paddingInlineStart="large">
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <s-stack gap="base">{props.children}</s-stack>
          </s-box>
        </s-box>
      ) : null}
    </s-stack>
  );
}

/** Radio group without reveal panels — the common case. */
export function RadioGroup<T extends string>(props: {
  name: string;
  selected: T;
  options: { value: T; label: string; details?: string; disabled?: boolean; badge?: ReactNode }[];
  onSelect: (value: T) => void;
}) {
  return (
    <s-stack gap="small-300">
      {props.options.map((option) => (
        <RadioOption
          key={option.value}
          name={props.name}
          value={option.value}
          selected={props.selected}
          label={option.label}
          details={option.details}
          disabled={option.disabled}
          badge={option.badge}
          onSelect={props.onSelect}
        />
      ))}
    </s-stack>
  );
}
