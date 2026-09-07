import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Form, redirect, useActionData, useLoaderData, useNavigation } from "react-router";

import { runtimeConfig } from "../../lib/admin/runtime-config.server";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";

// Public marketing page — the only ChatConvert surface served outside the
// Shopify admin and the /web team app. Two ways in:
//
//   1. the shop-domain login card → login() → Shopify's managed install screen;
//   2. the App Store listing link, once a handle is configured.
//
// The login card was removed on 2026-08-21 citing "App Store review req 2.3.1",
// and restored on 2026-09-07: that citation was never verifiable (see the note
// in shopify.server.ts) and Shopify's own app template ships this exact form.
//
// Shopify still bounces merchants through this route with ?shop=… on their way
// into the embedded app — that redirect below is load-bearing, and has to stay
// AHEAD of the card so an install already in flight is never shown a form.

export const meta: MetaFunction = () => [
  { title: "ChatConvert — AI product recommendations & support chat for Shopify" },
  {
    name: "description",
    content:
      "ChatConvert adds an AI assistant to your storefront that recommends products from your catalog, answers questions from your policies and FAQs, and hands off to your team when a shopper needs a person.",
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  // The EFFECTIVE handle — Admin → Settings, then SHOPIFY_APP_STORE_HANDLE,
  // then DEFAULT_APP_STORE_HANDLE — not process.env directly, which is why
  // setting the handle in the operator console never lit this link up. It only
  // comes back blank if someone deliberately clears every source, and then the
  // band degrades to a note rather than to a dead link.
  const handle = runtimeConfig().appStoreHandle;
  return { listingUrl: handle ? `https://apps.shopify.com/${handle}` : null };
};

// login() throws a redirect to Shopify's managed-install screen on success, so
// anything that comes back here is a validation failure to re-render in place.
// It accepts a bare handle as well as a full domain and normalises both.
export const action = async ({ request }: ActionFunctionArgs) => {
  return { errors: await login(request) };
};

// LoginErrorType is a string enum — MISSING_SHOP / INVALID_SHOP, NOT the member
// names. Compared as literals so the enum (a value from a .server package) never
// reaches the client bundle; the fallback covers both, so a renamed member
// degrades to the generic message rather than to nothing.
function loginErrorMessage(error: string | undefined): string | null {
  if (!error) return null;
  if (error === "MISSING_SHOP") return "Enter your store domain to continue.";
  return "That doesn't look like a Shopify store domain — try my-store.myshopify.com.";
}

/** 20px stroke icons, sized by the chip that holds them. */
const ICONS = {
  chat: "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z",
  book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 0 6.5 22H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15z",
  inbox: "M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z",
  package: "M16.5 9.4 7.5 4.21M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z M3.27 6.96 12 12.01l8.73-5.05M12 22.08V12",
  chart: "M3 3v18h18M18.7 8l-5.1 5.2-2.8-2.8L7 14.3",
  lock: "M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2zM7 11V7a5 5 0 0 1 10 0v4",
  check: "M20 6 9 17l-5-5",
  spark: "m12 3 1.9 5.8L20 10.7l-5.2 3.4L15.5 20 12 16.8 8.5 20l.7-5.9L4 10.7l6.1-1.9L12 3z",
  arrow: "M5 12h14M12 5l7 7-7 7",
  store: "M3 9.5 4.8 4.2A1.5 1.5 0 0 1 6.2 3h11.6a1.5 1.5 0 0 1 1.4 1.2L21 9.5M3 9.5h18M3 9.5a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0M5 12.6V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7.4",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16v-4M12 8h.01",
} as const;

function Icon(props: { path: string; size?: number; className?: string }) {
  return (
    <svg
      className={props.className}
      width={props.size ?? 20}
      height={props.size ?? 20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* Multi-subpath `d` strings render as one path — no need to split them. */}
      <path d={props.path} />
    </svg>
  );
}

// Six capabilities, each one a shipped feature — not a roadmap. The tint on the
// icon chip is per-card so the grid reads as a set rather than a list.
const FEATURES: { title: string; body: string; icon: string; tint: string }[] = [
  {
    title: "Recommends your real catalog",
    body: "Products, collections and the metafields you choose stay synced, so the assistant only suggests what you actually stock — and shoppers add to cart without leaving the chat.",
    icon: ICONS.spark,
    tint: "violet",
  },
  {
    title: "Answers grounded in your store",
    body: "Trained on your policy pages, FAQs and the curated answers you write. It will not improvise: no matching source, no invented answer.",
    icon: ICONS.book,
    tint: "blue",
  },
  {
    title: "Hands off to your team",
    body: "When a shopper needs a person, the conversation moves to a shared inbox with the full transcript attached — on the web, or on your phone.",
    icon: ICONS.inbox,
    tint: "aqua",
  },
  {
    title: "Proactive messages",
    body: "Open a conversation based on the page, the cart value or how a shopper is behaving, instead of waiting for them to click the bubble.",
    icon: ICONS.send,
    tint: "amber",
  },
  {
    title: "Order tracking in chat",
    body: "Customers check where their order is without emailing support — the assistant looks it up and answers in the same thread.",
    icon: ICONS.package,
    tint: "rose",
  },
  {
    title: "Analytics that close the loop",
    body: "See what shoppers asked, what converted, and every question the assistant could not answer — so you know exactly what to train next.",
    icon: ICONS.chart,
    tint: "green",
  },
];

export default function Index() {
  const { listingUrl } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  // The success path leaves this page entirely (redirect to admin.shopify.com),
  // so the button stays busy until the browser navigates away.
  const submitting = navigation.formMethod === "POST";
  const error = loginErrorMessage(actionData?.errors?.shop);

  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.topbar}>
          <div className={styles.brand}>
            <span className={styles.brandMark} aria-hidden="true">
              C
            </span>
            <span className={styles.brandName}>ChatConvert</span>
          </div>
          <span className={styles.topPill}>Shopify app</span>
        </header>

        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <span className={styles.heroBadge}>
              <Icon path={ICONS.chat} size={15} />
              AI recommendations &amp; support chat
            </span>
            <h1 className={styles.heroHeading}>
              Answer every shopper — and recommend what you actually stock
            </h1>
            <p className={styles.heroText}>
              ChatConvert puts an AI assistant on your storefront that is grounded in your own
              catalog, policies and FAQs — and knows when to hand the conversation to a human.
            </p>
          </div>

          <div className={styles.heroCard}>
            <h2 className={styles.cardTitle}>Install ChatConvert</h2>
            <p className={styles.cardSub}>Log in with your store to get started.</p>

            {/* Plain <Form>, not useSubmit — this page is NOT embedded, so the
                iframe session rules in CLAUDE.md do not apply here. */}
            <Form method="post" className={styles.loginForm}>
              <label className={styles.fieldLabel} htmlFor="shop">
                Shop domain
              </label>
              <div className={styles.fieldRow}>
                <span className={styles.field}>
                  <Icon path={ICONS.store} size={17} className={styles.fieldIcon} />
                  <input
                    id="shop"
                    name="shop"
                    type="text"
                    className={styles.fieldInput}
                    placeholder="my-shop-domain.myshopify.com"
                    autoComplete="on"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? "shop-error" : "shop-hint"}
                  />
                </span>
                <button type="submit" className={styles.submitButton} disabled={submitting}>
                  {submitting ? "Redirecting…" : "Log in"}
                  <Icon path={ICONS.arrow} size={16} />
                </button>
              </div>

              {error ? (
                <p className={styles.fieldError} id="shop-error" role="alert">
                  {error}
                </p>
              ) : (
                <p className={styles.fieldHint} id="shop-hint">
                  <Icon path={ICONS.info} size={14} />
                  e.g. my-shop-domain.myshopify.com
                </p>
              )}
            </Form>

            <div className={styles.cardDivider} />

            <p className={styles.cardFine}>
              <Icon path={ICONS.lock} size={15} />
              Secure OAuth via Shopify — we never see your password.
            </p>
          </div>
        </section>

        <section className={styles.features} aria-label="Features">
          {FEATURES.map((feature) => (
            <article key={feature.title} className={styles.featureCard}>
              <span className={`${styles.featureIcon} ${styles[feature.tint]}`}>
                <Icon path={feature.icon} size={20} />
              </span>
              <h3 className={styles.featureTitle}>{feature.title}</h3>
              <p className={styles.featureBody}>{feature.body}</p>
            </article>
          ))}
        </section>

        <section className={styles.band}>
          <div>
            <h2 className={styles.bandTitle}>Install from the Shopify App Store</h2>
            <p className={styles.bandSub}>
              {listingUrl
                ? "One click from the listing — no code, no theme edits."
                : "Log in with your store domain above — the install screen is the same one the listing opens."}
            </p>
          </div>
          {listingUrl ? (
            <a className={styles.primaryButton} href={listingUrl}>
              View on the Shopify App Store
              <Icon path={ICONS.arrow} size={17} />
            </a>
          ) : (
            <p className={styles.cardHint}>
              Already installed? Open it from <strong>Apps</strong> in your Shopify admin.
            </p>
          )}
        </section>

        <section className={styles.band}>
          <div>
            <h2 className={styles.bandTitle}>Already using ChatConvert?</h2>
            <p className={styles.bandSub}>
              Your team can reply to live conversations from any browser — no Shopify seat needed.
            </p>
          </div>
          <a className={styles.primaryButton} href="/web/login">
            Sign in to the inbox
            <Icon path={ICONS.arrow} size={17} />
          </a>
        </section>

        <p className={styles.trust}>
          <Icon path={ICONS.check} size={16} />
          <span>Works on any Shopify theme</span>
          <span className={styles.trustDot} aria-hidden="true">
            ·
          </span>
          <span>Free plan to start</span>
          <span className={styles.trustDot} aria-hidden="true">
            ·
          </span>
          <span>Installs with one click, no theme edits</span>
        </p>
      </div>
    </div>
  );
}
