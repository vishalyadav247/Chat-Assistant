import { useNavigate } from "react-router";
import { Row } from "./Row";
import { TabPills } from "./TabPills";

// Canonical page sub-header: one row of [back] [title] [tabs] ... [toolbar],
// with an optional description underneath. Replaces the six ad-hoc header
// variants that grew across the routes. The s-page `heading` attribute stays
// the platform page title; use `title` here only for sub-views/editors.

export function PageHeader<T extends string>(props: {
  title?: string;
  description?: string;
  backTo?: string;
  backLabel?: string;
  onBack?: () => void;
  tabs?: { id: T; label: string; badge?: string | number }[];
  activeTab?: T;
  onTabChange?: (id: T) => void;
  toolbar?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const navigate = useNavigate();
  const hasBack = Boolean(props.backTo || props.onBack);
  const hasTopRow = hasBack || props.title || props.tabs || props.toolbar;

  return (
    <s-stack gap="small">
      {hasTopRow ? (
        <Row justify="between">
          <Row gap="sm">
            {hasBack ? (
              <s-button
                icon="arrow-left"
                variant="tertiary"
                accessibilityLabel={props.backLabel ? `Back to ${props.backLabel}` : "Back"}
                onClick={() => (props.onBack ? props.onBack() : navigate(props.backTo!))}
              >
                {props.backLabel}
              </s-button>
            ) : null}
            {props.title ? <s-heading>{props.title}</s-heading> : null}
            {props.tabs && props.activeTab !== undefined && props.onTabChange ? (
              <TabPills tabs={props.tabs} active={props.activeTab} onChange={props.onTabChange} />
            ) : null}
          </Row>
          {props.toolbar ? <Row gap="sm">{props.toolbar}</Row> : null}
        </Row>
      ) : null}
      {props.description ? <s-paragraph>{props.description}</s-paragraph> : null}
      {props.children}
    </s-stack>
  );
}
