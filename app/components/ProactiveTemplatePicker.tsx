import { CAMPAIGN_TEMPLATES, type CampaignTemplate } from "../lib/campaigns/templates";

// Template picker view (spec 12, design proactive-chat.html #viewTemplates):
// 10 cards — category / name / description / preview verbatim from the design.
// Premium cards below Pro: 👑 Upgrade badge + disabled Create + upgrade link.
// Smart Product Page carries the ✦ NEW badge.

export function ProactiveTemplatePicker(props: {
  premiumAllowed: boolean;
  onBack: () => void;
  onCreate: (template: CampaignTemplate) => void;
}) {
  return (
    <s-section>
      <s-stack gap="base">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <s-button
            icon="arrow-left"
            variant="tertiary"
            accessibilityLabel="Back to campaigns"
            onClick={props.onBack}
          />
          <s-heading>Select template</s-heading>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
            gap: 16,
          }}
        >
          {CAMPAIGN_TEMPLATES.map((tpl) => {
            const gated = tpl.premium && !props.premiumAllowed;
            return (
              <div
                key={tpl.type}
                style={{
                  border: "1px solid var(--s-color-border, #e3e3e3)",
                  borderRadius: 16,
                  overflow: "hidden",
                  display: "flex",
                  flexDirection: "column",
                  position: "relative",
                  background: "var(--s-color-bg, #fff)",
                }}
              >
                {tpl.premium ? (
                  <span
                    style={{
                      position: "absolute",
                      top: 10,
                      right: 10,
                      fontSize: 10,
                      fontWeight: 800,
                      borderRadius: 20,
                      padding: "3px 9px",
                      color: "#8a5a00",
                      background: "#fde68a",
                      zIndex: 2,
                    }}
                  >
                    👑 {gated ? "Upgrade" : "Premium"}
                  </span>
                ) : null}
                {tpl.isNew ? (
                  <span
                    style={{
                      position: "absolute",
                      top: 10,
                      right: 10,
                      fontSize: 10,
                      fontWeight: 800,
                      borderRadius: 20,
                      padding: "3px 9px",
                      color: "#fff",
                      background: "linear-gradient(135deg,#7c3aed,#db2777)",
                      zIndex: 2,
                    }}
                  >
                    ✦ NEW
                  </span>
                ) : null}

                <div
                  aria-hidden="true"
                  style={{
                    height: 108,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: `linear-gradient(135deg, ${tpl.colors[0]}22, ${tpl.colors[1]}22)`,
                  }}
                >
                  <div
                    style={{
                      width: "78%",
                      background: "var(--s-color-bg, #fff)",
                      borderRadius: 12,
                      boxShadow: "0 8px 20px rgba(20,20,25,.12)",
                      padding: "10px 12px",
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
                      {tpl.previewLine}
                    </div>
                    <span
                      style={{
                        display: "inline-block",
                        fontSize: 10,
                        fontWeight: 700,
                        color: "#fff",
                        background: `linear-gradient(135deg, ${tpl.colors[0]}, ${tpl.colors[1]})`,
                        borderRadius: 7,
                        padding: "4px 10px",
                      }}
                    >
                      {tpl.defaults.ctaLabel}
                    </span>
                  </div>
                </div>

                <div
                  style={{
                    padding: "14px 16px 16px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    flex: 1,
                  }}
                >
                  <span
                    style={{
                      fontSize: 10.5,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                      color: "var(--s-color-text-secondary, #6b6b73)",
                    }}
                  >
                    {tpl.category}
                  </span>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>
                    {tpl.emoji} {tpl.name}
                  </span>
                  <span
                    style={{
                      fontSize: 12.5,
                      color: "var(--s-color-text-secondary, #6b6b73)",
                      flex: 1,
                      lineHeight: 1.5,
                    }}
                  >
                    {tpl.description}
                  </span>
                  <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
                    <s-button
                      disabled={gated}
                      variant={gated ? "secondary" : "primary"}
                      onClick={gated ? undefined : () => props.onCreate(tpl)}
                    >
                      Create
                    </s-button>
                    {gated ? <s-link href="/app/plan-usage">Upgrade to unlock</s-link> : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </s-stack>
    </s-section>
  );
}
