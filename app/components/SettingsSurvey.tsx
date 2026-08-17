import type { ShopSettingsData } from "../lib/settings/schemas";
import { ChipInput } from "./ChipInput";

// Settings → Chatbox → Satisfaction survey sub-view (spec 16, ?tab=survey):
// format (stars/emoji), content, trigger criteria (on-resolve + keywords).

type SurveyData = ShopSettingsData["survey"];

export function SettingsSurvey(props: {
  value: SurveyData;
  onChange: (value: SurveyData) => void;
  onCancel: () => void;
}) {
  const { value, onChange } = props;

  return (
    <s-stack gap="base">
      <s-stack direction="inline" gap="small" alignItems="center">
        <s-button
          icon="chevron-left"
          variant="tertiary"
          accessibilityLabel="Back to chatbox settings"
          onClick={props.onCancel}
        />
        <s-heading>Satisfaction survey</s-heading>
      </s-stack>

      <s-section heading="Survey format">
        <s-choice-list
          label="Survey format"
          labelAccessibilityVisibility="exclusive"
          name="survey-format"
          values={[value.format]}
          onChange={(e) => {
            const format = (e.currentTarget.values[0] ?? "stars") as SurveyData["format"];
            onChange({ ...value, format });
          }}
        >
          <s-choice value="stars">
            Star rating
            <s-text slot="details">★★★★★ — rate the conversation from 1 to 5 stars</s-text>
          </s-choice>
          <s-choice value="emoji">
            Emoji scale
            <s-text slot="details">😞 🙁 😐 🙂 😍 — maps to a 1–5 rating</s-text>
          </s-choice>
        </s-choice-list>
      </s-section>

      <s-section heading="Survey content">
        <s-text-field
          label="Intro"
          value={value.intro}
          onInput={(e) => onChange({ ...value, intro: e.currentTarget.value })}
        />
        <s-text-field
          label="Thank you message"
          value={value.thanks}
          onInput={(e) => onChange({ ...value, thanks: e.currentTarget.value })}
        />
      </s-section>

      <s-section heading="Trigger time">
        <s-paragraph>Send the survey at the right time whenever one of the criteria is met</s-paragraph>
        <s-checkbox
          label="Conversation is resolved"
          checked={value.triggerOnResolve}
          onChange={(e) => onChange({ ...value, triggerOnResolve: e.currentTarget.checked })}
        />
        <s-checkbox
          label="When specific keywords appear in conversation"
          checked={value.triggerKeywords.enabled}
          onChange={(e) =>
            onChange({
              ...value,
              triggerKeywords: { ...value.triggerKeywords, enabled: e.currentTarget.checked },
            })
          }
        />
        {value.triggerKeywords.enabled ? (
          <ChipInput
            values={value.triggerKeywords.keywords}
            placeholder="Enter keyword to add"
            maxLength={50}
            onChange={(keywords) =>
              onChange({ ...value, triggerKeywords: { ...value.triggerKeywords, keywords } })
            }
          />
        ) : null}
      </s-section>
    </s-stack>
  );
}
