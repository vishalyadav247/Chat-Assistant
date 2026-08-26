import { useNavigate } from "react-router";
import { Row } from "./Row";
import { TabPills } from "./TabPills";

// Canonical page header: the page title on its own line, then one row of
// [back] [tabs] ... [toolbar], with an optional description underneath.
// Replaces the six ad-hoc header variants that grew across the routes.
//
// `title` gets its own line rather than sharing the row with the back button
// and tab pills: crammed between them it read as just another control instead
// of the page name. Since s-page `heading` now carries the APP name (so the
// admin's uninstall dialog says "ChatConvert", not the current page), this IS
// the page title — same position as the plain <s-heading> the tabless pages use.

export function PageHeader<T extends string>(props: {
  /** Page title. Rendered on its own line above the back/tabs/toolbar row. */
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
  const hasTopRow = hasBack || props.tabs || props.toolbar;

  return (
    <s-stack gap="small">
      {props.title ? <s-heading>{props.title}</s-heading> : null}
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
