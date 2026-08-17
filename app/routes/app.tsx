import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { resolveReviewPromptEligible } from "../lib/review.server";
import { ReviewPrompt } from "../components/ReviewPrompt";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const reviewPromptEligible = await resolveReviewPromptEligible(session.shop);

  return {
    // eslint-disable-next-line no-undef
    apiKey: process.env.SHOPIFY_API_KEY || "",
    reviewPromptEligible,
  };
};

export default function App() {
  const { apiKey, reviewPromptEligible } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/inbox">Inbox</s-link>
        <s-link href="/app/contacts">Contacts</s-link>
        <s-link href="/app/chatbox">Chatbox</s-link>
        <s-link href="/app/ai-agent">AI Agent</s-link>
        <s-link href="/app/proactive-chat">Proactive Chat</s-link>
        <s-link href="/app/curated-answers">Curated Answers</s-link>
        <s-link href="/app/analytics">Analytics</s-link>
        <s-link href="/app/plan-usage">Plan &amp; Usage</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
      <ReviewPrompt eligible={reviewPromptEligible} />
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
