import { Link, isRouteErrorResponse } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

// Shared route ErrorBoundary body for /app/* pages (spec 18): a 403 thrown by
// requireShopAccess's permission gate (web-surface roles) renders a friendly
// "No access" page inside the current shell; everything else keeps Shopify's
// boundary behaviour (needed for embedded auth retries).

export function routeError(error: unknown) {
  if (isRouteErrorResponse(error) && error.status === 403) {
    return (
      <s-page heading="No access">
        <s-section>
          <s-stack gap="base">
            <s-paragraph>
              Your role doesn&apos;t include this page. Ask the store owner to change your role if you need it.
            </s-paragraph>
            <s-stack direction="inline" gap="small">
              <Link to="/app/inbox">Go to Inbox</Link>
            </s-stack>
          </s-stack>
        </s-section>
      </s-page>
    );
  }
  return boundary.error(error);
}
