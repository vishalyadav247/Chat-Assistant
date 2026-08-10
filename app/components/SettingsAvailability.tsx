import { useMemo } from "react";
import type { CSSProperties } from "react";
import type { AvailabilityData } from "../lib/settings/schemas";

// Settings → Chatbox → Chat availability sub-view (spec 16, #availability):
// working hours, online-status mode, breaks, holidays, status messages with
// {{schedule}} merge, timezone. Live status preview comes from the loader
// (resolveAvailability) and reflects the last SAVED settings.

const DAY_ROWS: Array<{ day: number; label: string }> = [
  { day: 1, label: "Monday" },
  { day: 2, label: "Tuesday" },
  { day: 3, label: "Wednesday" },
  { day: 4, label: "Thursday" },
  { day: 5, label: "Friday" },
  { day: 6, label: "Saturday" },
  { day: 0, label: "Sunday" },
];

const FALLBACK_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];

const inputStyle: CSSProperties = {
  padding: "6px 10px",
  borderRadius: 8,
  border: "1px solid var(--s-color-border, #d4d4d4)",
  font: "inherit",
  background: "var(--s-color-bg-surface, #fff)",
};

const rowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 12 };

type DayEntry = AvailabilityData["days"][number];
type StatusKey = "online" | "offline" | "break" | "holiday";

const STATUS_TONE: Record<StatusKey, "success" | "neutral" | "caution" | "info"> = {
  online: "success",
  offline: "neutral",
  break: "caution",
  holiday: "info",
};

export function SettingsAvailability(props: {
  value: AvailabilityData;
  timezone: string;
  preview: { status: string; message: string };
  onChange: (value: AvailabilityData) => void;
  onTimezoneChange: (timezone: string) => void;
  onCancel: () => void;
}) {
  const { value, onChange } = props;

  const timezones = useMemo(() => {
    const list =
      typeof Intl.supportedValuesOf === "function"
        ? Intl.supportedValuesOf("timeZone")
        : FALLBACK_TIMEZONES;
    return list.includes(props.timezone) ? list : [props.timezone, ...list];
  }, [props.timezone]);

  const dayEntry = (day: number): DayEntry =>
    value.days.find((d) => d.day === day) ?? { day, enabled: false, from: "09:00", to: "17:00" };

  const setDay = (day: number, patch: Partial<DayEntry>) => {
    const exists = value.days.some((d) => d.day === day);
    const days = exists
      ? value.days.map((d) => (d.day === day ? { ...d, ...patch } : d))
      : [...value.days, { ...dayEntry(day), ...patch }];
    onChange({ ...value, days });
  };

  const setBreakRange = (index: number, patch: Partial<{ from: string; to: string }>) => {
    const ranges = value.breaks.ranges.map((r, i) => (i === index ? { ...r, ...patch } : r));
    onChange({ ...value, breaks: { ...value.breaks, ranges } });
  };

  const setHoliday = (index: number, patch: Partial<{ name: string; from: string; to: string }>) => {
    const items = value.holidays.items.map((h, i) => (i === index ? { ...h, ...patch } : h));
    onChange({ ...value, holidays: { ...value.holidays, items } });
  };

  const today = () => new Date().toISOString().slice(0, 10);
  const tone = STATUS_TONE[props.preview.status as StatusKey] ?? "neutral";

  return (
    <s-stack gap="base">
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-button
          icon="chevron-left"
          variant="tertiary"
          accessibilityLabel="Back to chatbox settings"
          onClick={props.onCancel}
        />
        <s-heading>Chat availability</s-heading>
      </s-stack>

      <s-section>
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-text>Current status:</s-text>
          <s-badge tone={tone}>{props.preview.status}</s-badge>
          <s-text tone="neutral">&ldquo;{props.preview.message}&rdquo;</s-text>
        </s-stack>
        <s-text tone="neutral">
          This is what shoppers see in the widget right now. It reflects your saved settings and
          updates after you save.
        </s-text>
      </s-section>

      <s-section heading="Working hours">
        <s-paragraph>Display your online status during these hours</s-paragraph>
        <s-choice-list
          label="Working hours mode"
          labelAccessibilityVisibility="exclusive"
          name="working-hours-mode"
          values={[value.mode]}
          onChange={(e) => {
            const mode = (e.currentTarget.values[0] ?? "always") as AvailabilityData["mode"];
            onChange({ ...value, mode });
          }}
        >
          <s-choice value="always">24 hours / 7 days</s-choice>
          <s-choice value="custom">Custom time</s-choice>
        </s-choice-list>
        {value.mode === "custom" ? (
          <s-stack gap="small">
            {DAY_ROWS.map(({ day, label }) => {
              const entry = dayEntry(day);
              return (
                <div key={day} style={rowStyle}>
                  <div style={{ width: 140 }}>
                    <s-checkbox
                      label={label}
                      checked={entry.enabled}
                      onChange={(e) => setDay(day, { enabled: e.currentTarget.checked })}
                    />
                  </div>
                  <input
                    type="time"
                    value={entry.from}
                    disabled={!entry.enabled}
                    aria-label={`${label} opening time`}
                    style={inputStyle}
                    onChange={(e) => setDay(day, { from: e.currentTarget.value })}
                  />
                  <s-text tone="neutral">To</s-text>
                  <input
                    type="time"
                    value={entry.to}
                    disabled={!entry.enabled}
                    aria-label={`${label} closing time`}
                    style={inputStyle}
                    onChange={(e) => setDay(day, { to: e.currentTarget.value })}
                  />
                </div>
              );
            })}
          </s-stack>
        ) : null}
        <s-choice-list
          label="Show online status"
          name="online-status-mode"
          values={[value.onlineStatusMode]}
          onChange={(e) => {
            const mode = (e.currentTarget.values[0] ??
              "working_hours") as AvailabilityData["onlineStatusMode"];
            onChange({ ...value, onlineStatusMode: mode });
          }}
        >
          <s-choice value="working_hours">
            During working hours
            <s-text slot="details">Follows the schedule above, regardless of agent activity</s-text>
          </s-choice>
          <s-choice value="working_hours_or_agent">
            During working hours, or when any agent is online
            <s-text slot="details">
              An online agent shows the status as online even outside working hours
            </s-text>
          </s-choice>
          <s-choice value="agent_during_hours">
            Only when an agent is online during working hours
            <s-text slot="details">
              Shows offline when no agent is online, even within working hours. The AI assistant
              still replies while offline.
            </s-text>
          </s-choice>
        </s-choice-list>
      </s-section>

      <s-section>
        <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
          <s-heading>Break time</s-heading>
          <s-switch
            label="Break time"
            labelAccessibilityVisibility="exclusive"
            checked={value.breaks.enabled}
            onChange={(e) => {
              const enabled = e.currentTarget.checked;
              const ranges =
                enabled && value.breaks.ranges.length === 0
                  ? [{ from: "13:00", to: "14:00" }]
                  : value.breaks.ranges;
              onChange({ ...value, breaks: { enabled, ranges } });
            }}
          />
        </s-stack>
        {value.breaks.enabled ? (
          <s-stack gap="small">
            {value.breaks.ranges.map((range, index) => (
              <div key={index} style={rowStyle}>
                <input
                  type="time"
                  value={range.from}
                  aria-label={`Break ${index + 1} start`}
                  style={inputStyle}
                  onChange={(e) => setBreakRange(index, { from: e.currentTarget.value })}
                />
                <s-text tone="neutral">To</s-text>
                <input
                  type="time"
                  value={range.to}
                  aria-label={`Break ${index + 1} end`}
                  style={inputStyle}
                  onChange={(e) => setBreakRange(index, { to: e.currentTarget.value })}
                />
                <s-button
                  icon="x"
                  variant="tertiary"
                  accessibilityLabel={`Remove break ${index + 1}`}
                  onClick={() =>
                    onChange({
                      ...value,
                      breaks: {
                        ...value.breaks,
                        ranges: value.breaks.ranges.filter((_, i) => i !== index),
                      },
                    })
                  }
                />
              </div>
            ))}
            <s-box>
              <s-button
                icon="plus"
                variant="tertiary"
                onClick={() =>
                  onChange({
                    ...value,
                    breaks: {
                      ...value.breaks,
                      ranges: [...value.breaks.ranges, { from: "13:00", to: "14:00" }],
                    },
                  })
                }
              >
                Add break time
              </s-button>
            </s-box>
          </s-stack>
        ) : null}
      </s-section>

      <s-section>
        <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
          <s-heading>Holiday</s-heading>
          <s-switch
            label="Holiday"
            labelAccessibilityVisibility="exclusive"
            checked={value.holidays.enabled}
            onChange={(e) => {
              const enabled = e.currentTarget.checked;
              const items =
                enabled && value.holidays.items.length === 0
                  ? [{ name: "", from: today(), to: today() }]
                  : value.holidays.items;
              onChange({ ...value, holidays: { enabled, items } });
            }}
          />
        </s-stack>
        {value.holidays.enabled ? (
          <s-stack gap="small">
            {value.holidays.items.map((holiday, index) => (
              <div key={index} style={{ ...rowStyle, flexWrap: "wrap" }}>
                <div style={{ minWidth: 200, flex: 1 }}>
                  <s-text-field
                    label="Holiday name"
                    labelAccessibilityVisibility={index === 0 ? "visible" : "exclusive"}
                    placeholder="Enter holiday name"
                    value={holiday.name}
                    onInput={(e) => setHoliday(index, { name: e.currentTarget.value })}
                  />
                </div>
                <input
                  type="date"
                  value={holiday.from}
                  aria-label={`Holiday ${index + 1} start date`}
                  style={inputStyle}
                  onChange={(e) => setHoliday(index, { from: e.currentTarget.value })}
                />
                <s-text tone="neutral">To</s-text>
                <input
                  type="date"
                  value={holiday.to}
                  aria-label={`Holiday ${index + 1} end date`}
                  style={inputStyle}
                  onChange={(e) => setHoliday(index, { to: e.currentTarget.value })}
                />
                <s-button
                  icon="x"
                  variant="tertiary"
                  accessibilityLabel={`Remove holiday ${index + 1}`}
                  onClick={() =>
                    onChange({
                      ...value,
                      holidays: {
                        ...value.holidays,
                        items: value.holidays.items.filter((_, i) => i !== index),
                      },
                    })
                  }
                />
              </div>
            ))}
            <s-box>
              <s-button
                icon="plus"
                variant="tertiary"
                onClick={() =>
                  onChange({
                    ...value,
                    holidays: {
                      ...value.holidays,
                      items: [...value.holidays.items, { name: "", from: today(), to: today() }],
                    },
                  })
                }
              >
                Add holiday
              </s-button>
            </s-box>
          </s-stack>
        ) : null}
      </s-section>

      <s-section heading="Status messages">
        <s-text-field
          label="Online status"
          value={value.messages.online}
          onInput={(e) =>
            onChange({ ...value, messages: { ...value.messages, online: e.currentTarget.value } })
          }
        />
        <s-text-field
          label="Offline status (with schedule)"
          details="Shown when an upcoming opening schedule is available. Use {{schedule}} to insert the next time you'll be back (e.g. tomorrow 9 AM)."
          value={value.messages.offline}
          onInput={(e) =>
            onChange({ ...value, messages: { ...value.messages, offline: e.currentTarget.value } })
          }
        />
        <s-text-field
          label="Break status"
          details="Use {{schedule}} to insert the time you'll be back (e.g. 1 PM)."
          value={value.messages.break}
          onInput={(e) =>
            onChange({ ...value, messages: { ...value.messages, break: e.currentTarget.value } })
          }
        />
        <s-text-field
          label="Holiday status"
          details="Use {{schedule}} to insert the day and time you'll be back (e.g. Monday 9 AM)."
          value={value.messages.holiday}
          onInput={(e) =>
            onChange({ ...value, messages: { ...value.messages, holiday: e.currentTarget.value } })
          }
        />
        <s-select
          label="Time zone"
          details="Working hours, breaks and holidays are interpreted in this time zone."
          value={props.timezone}
          onChange={(e) => props.onTimezoneChange(e.currentTarget.value)}
        >
          {timezones.map((tz) => (
            <s-option key={tz} value={tz}>
              {tz.replace(/_/g, " ")}
            </s-option>
          ))}
        </s-select>
      </s-section>
    </s-stack>
  );
}
