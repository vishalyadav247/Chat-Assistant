# ChatConvert — Privacy Policy

> **Before you publish this, replace every `⟪…⟫` placeholder.** They are the facts only you
> know: legal entity, address, hosting region, and contact addresses. Everything else in this
> document was written from the actual code and is accurate as of ⟪EFFECTIVE DATE⟫ — if you
> change retention windows, sub-processors, or scopes, update this file in the same commit.
>
> This is not legal advice. Shopify's own guidance recommends a lawyer review your policy
> against the jurisdictions you operate in (GDPR, UK GDPR, CPRA, CPA, VCDPA).
>
> Structure follows the question list Shopify publishes at
> https://shopify.dev/docs/apps/launch/privacy-requirements — each numbered section answers
> one of their required questions, so a reviewer can tick them off in order.

**Effective date:** ⟪EFFECTIVE DATE⟫
**App:** ChatConvert (Shopify App Store)
**Provider:** ⟪LEGAL ENTITY NAME⟫, ⟪REGISTERED POSTAL ADDRESS⟫
**Privacy contact:** ⟪privacy@yourdomain.com⟫

---

## 0. Who is responsible for what

ChatConvert is an AI product-recommendation and support chat app installed by a merchant on
their Shopify store.

- **The merchant is the data controller** for their store's data and for the shoppers who chat
  with them. They decide what to collect, how long to keep it, and how to answer requests from
  their own customers.
- **⟪LEGAL ENTITY NAME⟫ is the data processor.** We store and process that data only to provide
  the app to that merchant, on their instructions.
- Every record in our database is scoped to a single store. One merchant's data is never
  readable by another merchant.

If you are a **shopper** who chatted on a store using ChatConvert, the store you chatted with is
your point of contact. We will pass any request you send us to that merchant.

---

## 1. Information we collect through Shopify's APIs

When a merchant installs ChatConvert, they grant these access scopes. We read only what each one
is listed for:

| Scope | What we read | Why |
|---|---|---|
| `read_products` | Product titles, descriptions, images, prices, variants, inventory status | Catalog mirror that grounds every AI recommendation |
| `read_content` | Metafield definitions | Keeps the merchant's metafield catalog current |
| `read_discounts` | Discount codes and rules | So the assistant can reference live offers |
| `read_legal_policies` | The store's own published policies | Knowledge source for policy questions |
| `read_online_store_pages` | Store pages | Knowledge source for support answers |
| `read_themes` | **Only** `config/settings_data.json` | Detects whether the chat widget is enabled on the theme. We do not read theme code |
| `write_app_proxy` | — | Transport for the storefront widget |
| `write_files` | Merchant-uploaded logo/icon | Widget branding |
| `read_orders` | **Protected customer data.** Order number, status, fulfilment and tracking, plus the order's email/phone for verification only | In-widget order-status lookup |
| `read_customers` | **Protected customer data.** Customer name, email, phone | Matching a chat contact to an existing customer |
| `write_customers` | **Protected customer data.** Creates/updates a customer record | Only when the merchant explicitly converts a chat contact into a customer |

**Protected customer data.** `read_orders`, `read_customers` and `write_customers` place this app
at Shopify's Protected Customer Data **level 2**. We have requested and been approved for access
to the specific fields listed above, and we apply Shopify's level 1 and level 2 requirements.

**Order lookup is deliberately narrow.** A shopper proves ownership of an order by supplying the
order number **plus** the email or phone already on that order. We compare, then return a minimal
status subset. We never echo the order's stored email, phone, or shipping address back into the
chat, and we do not store them.

---

## 2. Information we collect directly from the merchant

- **Account and staff identity:** the store's `.myshopify.com` domain, shop name, currency, and
  timezone; and for each team member the merchant invites — name, email address, and a hashed
  password (we never store passwords in readable form).
- **Configuration the merchant types in:** the assistant's persona and instructions, curated
  answers, FAQs, business hours, handover rules, campaign content, and knowledge sources
  (uploaded documents, crawled URLs, or pages selected from the store).
- **Billing state:** the selected plan, subscription status, and trial dates. **Payment card
  details are handled entirely by Shopify's Billing API — we never see or store them.**

---

## 3. Automated logs about use of the app

Yes, and they are deliberately minimal.

- **Operational log.** Errors and warnings only — never informational traffic. Each entry holds a
  timestamp, an event code, a short message, and the store it belongs to. **It never stores chat
  message bodies or contact details**, and this is enforced by an automated test that fails the
  build if an email address ever appears in it. **Retained 14 days, then deleted.**
- **Usage counters.** Per-store, per-day counts of AI calls and tokens, used for billing and
  capacity. These are aggregate numbers, not content.

---

## 4. Information we collect directly from merchants' customers (shoppers)

Collected through the chat widget on the merchant's storefront:

- **Chat messages** — everything the shopper types, and the assistant's replies. Shoppers may
  volunteer personal information in free text; that text is stored as part of the transcript.
- **Contact details the shopper chooses to give** — name, email, and/or phone, via the optional
  pre-chat form or during the conversation. Optional, and configured by the merchant.
- **A session identifier** — a random UUID generated in the shopper's browser, used to keep one
  conversation continuous. It rotates after 30 minutes of inactivity.
- **Page context** — which page the chat was opened on, so answers are relevant.
- **Coarse location** and **marketing opt-in status**, where the shopper provides it.
- **A satisfaction rating**, if the shopper answers the optional post-chat survey.

**Cookies and tracking.** **ChatConvert sets no cookies on the storefront.** The widget uses the
browser's own `localStorage` (for the rotating session id) and `sessionStorage` (per-tab UI state
and a short-lived config cache). It does not track shoppers across sites, does not build
advertising profiles, and carries no third-party analytics or advertising pixels.

**Consent.** The widget integrates with the **Shopify Customer Privacy API**. Where the storefront
exposes it, analytics events are held until the shopper's consent state is resolved and are not
sent if analytics consent is withheld. Answering the shopper's question is never blocked by this.

**Disclosure.** Merchants can enable a disclaimer shown in the chat window so shoppers know they
are talking to an AI assistant and that the conversation is stored.

---

## 5. How we use the information

We use it **only to provide the app to the merchant who installed it**:

- generating product recommendations and support answers;
- looking up order status when a shopper asks;
- showing the merchant their inbox, analytics, and unanswered questions;
- routing conversations to a human agent and sending notification emails;
- metering plan usage and billing;
- diagnosing errors.

**We do not** sell personal data, share it with advertisers or data brokers, use it for our own
marketing, or use one merchant's data to serve another merchant.

### Sub-processors

| Sub-processor | What is sent | Purpose |
|---|---|---|
| **OpenAI** | Chat messages, conversation history, and the merchant's own catalog/knowledge excerpts used to ground an answer | Generating replies and embeddings. Default models: `gpt-4o-mini` and `text-embedding-3-small`. Sent via the OpenAI **API**, where content is **not used to train their models** |
| **Shopify** | — | Source of store data and host of the merchant's store |
| **⟪Resend, or your SMTP provider⟫** | Recipient address and notification content | Handover and system notification email |
| **⟪HOSTING PROVIDER⟫** | All application data at rest | Application hosting and the PostgreSQL database |

We do not send store or shopper data to any other third party.

### Automated decision-making

The assistant generates suggestions and answers. It does not make decisions with legal or
similarly significant effects about any individual.

---

## 6. How long we keep data

| Data | Retention |
|---|---|
| **Chat transcripts and contacts** | **Set by the merchant** in Settings → Privacy & Data Requests: 7, 30, 60, or 90 days, or *Keep forever*. **The default is *Keep forever***, so a merchant who wants a shorter window must choose one. A nightly job deletes anything past the chosen window |
| **Operational log** | 14 days, then deleted |
| **Store configuration, catalog mirror, knowledge sources** | For as long as the app is installed |
| **After uninstall** | A **7-day grace period** so an accidental uninstall or reinstall does not lose the merchant's setup. After 7 days **every record belonging to that store is permanently deleted** |
| **GDPR data-request exports** | **Never stored.** The export is computed at the moment of download and exists only for the lifetime of that response — no file is written to disk |

---

## 7. Where data is stored and transferred

Application data is stored in a PostgreSQL database hosted in **⟪REGION — e.g. eu-west-1⟫** with
**⟪HOSTING PROVIDER⟫**.

⟪Are you established in Europe? State it here.⟫ Requests sent to OpenAI are processed in
**⟪REGION⟫**. Where personal data of individuals in the European Economic Area or the United
Kingdom is transferred outside those areas, we rely on **⟪Standard Contractual Clauses / UK
Addendum / other lawful mechanism⟫**.

---

## 8. Security

- All database queries are scoped to a single store; cross-store access is structurally prevented
  and covered by an automated tenancy audit.
- API keys and provider secrets are **encrypted at rest**, never returned to the browser, and
  never written to logs.
- AI provider keys are held server-side only and are never exposed to the storefront widget.
- Admin sessions use HttpOnly cookies; staff passwords are stored only as hashes; repeated failed
  logins lock the account.
- Storefront requests are verified via Shopify's signed app-proxy mechanism, and all Shopify
  webhooks are HMAC-verified before any processing.

No system is perfectly secure. If we become aware of a breach affecting personal data, we will
notify affected merchants without undue delay and cooperate with them as the controller.

---

## 9. Data subject rights, and Shopify's mandatory webhooks

ChatConvert implements all three of Shopify's mandatory compliance webhooks:

- **`customers/data_request`** — creates a request the merchant can fulfil from
  Settings → Privacy & Data Requests, producing an export of every contact record,
  conversation, full message transcript, and unresolved question tied to that customer's email.
- **`customers/redact`** — erases that customer's personal data from our records.
- **`shop/redact`** — erases everything belonging to the store, 48 hours after uninstall as
  Shopify requires.

Shoppers who want access, correction, deletion, portability, or restriction of their data should
contact **the merchant whose store they chatted with**, since the merchant is the controller.
Merchants can contact us at ⟪privacy@yourdomain.com⟫ and we will assist within the statutory
deadline. You may also lodge a complaint with your local supervisory authority.

---

## 10. Children

ChatConvert is a business tool for merchants and is not directed at children. We do not knowingly
collect personal data from children. If you believe a child's data has reached us through a chat
transcript, contact us and we will delete it.

---

## 11. Changes to this policy

If we make a material change — a new sub-processor, a new category of data, or a shorter or longer
retention window — we will update the effective date above and notify merchants in the app before
the change takes effect.

---

## 12. Contact

⟪LEGAL ENTITY NAME⟫
⟪REGISTERED POSTAL ADDRESS⟫
Privacy: ⟪privacy@yourdomain.com⟫ · Support: ⟪support@yourdomain.com⟫
⟪EU/UK representative under GDPR Art. 27, if you are not established in the EEA/UK⟫
