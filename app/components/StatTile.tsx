// KPI stat tile + overview grid shell (specs 09/11/12/13/14).
// Delta rendering: arrow-up / arrow-down icon; `invert` flips tone for
// metrics where down is good (e.g. response time).

export function StatTile(props: {
  label: string;
  value: string;
  sub?: string;
  delta?: { value: string; direction: "up" | "down"; invert?: boolean };
}) {
  const d = props.delta;
  const good = d ? (d.direction === "up") !== Boolean(d.invert) : true;
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack gap="small">
        <s-text tone="neutral">{props.label}</s-text>
        <s-heading>{props.value}</s-heading>
        {d ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
            <s-icon
              type={d.direction === "up" ? "arrow-up" : "arrow-down"}
              size="small"
              tone={good ? "success" : "critical"}
            />
            <s-text tone={good ? "success" : "critical"}>{d.value}</s-text>
          </span>
        ) : null}
        {props.sub ? <s-text tone="neutral">{props.sub}</s-text> : null}
      </s-stack>
    </s-box>
  );
}

export function StatGrid(props: { children: React.ReactNode; columns?: number }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(auto-fit, minmax(180px, 1fr))`,
        gap: 12,
      }}
    >
      {props.children}
    </div>
  );
}
