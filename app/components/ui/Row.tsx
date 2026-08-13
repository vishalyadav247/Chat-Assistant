import { SPACE } from "./tokens";

// Layout primitives replacing ad-hoc `display:flex` divs with raw gap values.
// Use these (or s-stack) for every new row of controls — never `gap: <number>`.

export function Row(props: {
  gap?: keyof typeof SPACE;
  justify?: "start" | "end" | "between" | "center";
  align?: "center" | "start" | "end" | "stretch";
  wrap?: boolean;
  flex?: number | string;
  children: React.ReactNode;
}) {
  const justify =
    props.justify === "between"
      ? "space-between"
      : props.justify === "end"
        ? "flex-end"
        : props.justify === "center"
          ? "center"
          : "flex-start";
  return (
    <div
      style={{
        display: "flex",
        gap: SPACE[props.gap ?? "sm"],
        alignItems:
          props.align === "start"
            ? "flex-start"
            : props.align === "end"
              ? "flex-end"
              : (props.align ?? "center"),
        justifyContent: justify,
        flexWrap: props.wrap === false ? "nowrap" : "wrap",
        flex: props.flex,
        minWidth: 0,
      }}
    >
      {props.children}
    </div>
  );
}

/**
 * Toolbar row: left content flows, `end` content is pushed right.
 * The standard shell for page/section action rows.
 */
export function Toolbar(props: { children?: React.ReactNode; end?: React.ReactNode }) {
  return (
    <Row gap="sm" justify="between">
      <Row gap="sm">{props.children}</Row>
      {props.end ? <Row gap="sm">{props.end}</Row> : null}
    </Row>
  );
}
