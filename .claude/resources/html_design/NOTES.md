# ChatConvert — Prototype Notes & Interaction Spec

Ye ek **static HTML prototype** hai (no build system, no backend). Maqsad: design intent + har screen ki poori interaction logic capture karna, taaki real app banate waqt exact reference mile.

Real build recommended stack: **React + Shopify Polaris + App Bridge** + backend (settings save/load, live data).

Neeche har page ka **exhaustive** interaction inventory hai (actual code se verified — real ids, labels, menu items). "Mock vs real" aur build-checklist aakhir mein.

---

## Global / Shell (sab pages common)

- **Layout**: sticky dark topbar + left sidebar (`.nav-item` / `.sub-rail` / `.sub-item`) + centered content (`max-width:1120px`).
- **Topbar**: global search (decorative, "CTRL K" hint), notifications bell (unread dot), user chip `chatconvert-store / dev` — sab non-functional.
- **Sidebar**: Shopify chrome nav (Home, Orders, Products… static) + **app sub-rail** = real anchor links: Dashboard, Inbox, Contacts, Chatbox, AI Agent, Proactive Chat, Curated Answers, Analytics, Plan & Usage, Settings. Active page pe `.active`.
- **Design tokens** (`:root` CSS vars): `--accent:#6d3bf5`, gradient `--cw1 #6d3bf5`→`--cw2 #3b82f6`, `--surface`, `--surface-2`, `--ink-strong`, `--muted`, `--border`, `--radius:16px`, `--shadow-sm/md`.
- **Toggle standard**: `.switch` 34×20px, on = purple.
- **Count-up animation**: `[data-count]` elements load pe animate hote hain (Indian number format `data-format="in"`).
- **Known dead code**: kai pages mein `#themeToggle`/`#themeLabel` (dark mode) ka JS hai par UI element render nahi hota — dark mode UI se unreachable. Real build mein ya toh toggle add karo ya code hatao.

---

## Chatbox (`chatbox.html`) — sabse detailed

Tabs: **General · Chat page · Appearance**. Left = settings, right = **live preview widget**. Page-head badge (On/Off) + Deactivate/Activate button.

### General tab
- **Chat focus mode** — toggle.
- **Header card**: Logo (default logo + **Upload logo** file input → FileReader data URL, settings+preview dono update), **Chatbox name** input (live → preview header title), **Description** input (live → preview subtitle).
- **Contact & Chat card** (teen rows): Chat status toggle, Live chat toggle, Contact methods toggle. Contact methods: **Add contact method** dropdown (`#cmAddBtn`/`#cmMenu`) → WhatsApp / Phone call / Email; added rows `#cmRows` (drag handle, colored icon, phone/email input, delete). Added method dropdown se hat jaata hai (single-use); delete pe wapas aata hai.
- **Order tracking** toggle, **FAQs** toggle.

### Chat page tab
- **Welcome message**: textarea `#welcomeMsg` (live → preview chat bubble; `{{customer_name}}`→"there"). "Use different offline message" checkbox.
- **Conversation starter**: master toggle (`data-pv="pvStarters"` → preview chips show/hide). 3 question cards (`.qcard`) — edit pencil → modal, delete → row hatao + chip update. **Add question** `#addQBtn` → modal `#mAddQ` (Question 0/100 + RTE Answer). "Import from FAQs" link.
- **Chat avatar**: radio group (Store branding / Team member profile).
- **Pre-chat form**: "How customers start a chat" radios (Chat as guest / anonymous / both) → conditional `.pc-both`/`.pc-gb` show/hide. Description input. "Add contact field" dropdown (`#fieldAddBtn` → Name / Phone number, Optional badge) → `#fieldRows` (Email = Required, delete per row). "Show marketing opt-in" checkbox. **Disclaimer consent** checkbox → reveals info-note + RTE editor (default "By sending us a message, you agree to our privacy policy.").

### Appearance tab
- **Brand colors**: Solid/Gradient toggle (`#accToggle`). Swatches (6 each) + Custom color (solid) / Start+End color (gradient) inputs with color-chip. → live preview accent via `--cw1/--cw2` (header, buttons, launcher, avatar, Track btn).
- **Chatbox button**: Launcher style (Icon only / Label only / Icon & label → preview launcher shape/label), Launcher icon (chat / help / **upload** → preview launcher icon), Launcher position (Bottom/Top × left/right → preview launcher align).
- **Remove "Powered by ChatConvert"** toggle → preview footer hide.

### Live preview widget (prototype ki sabse valuable cheez)
Do screens — **home** (Contact us / Order tracking / FAQs) + **chat** (bubble + starter chips) + **order tracking screen** (Order number / Tracking number tabs, Email/Phone radios conditional, Track btn).
- Feature toggles → preview block live show/hide (empty state agar sab off).
- "Chat now" → chat screen (back arrow header, input dikhta hai). Order tracking → order form. Back → home. **X** → minimize (sirf launcher), launcher click → wapas open.
- Chat page pe tab switch karte hi preview auto chat-screen pe chala jaata hai.

---

## AI Agent (`ai-agent.html`) — sabse zyada interactive (14 modals)

Single-page app, 6 views via `showView()`: **Agent overview · Training data · Instructions · Test AI · Recommendation detail · Custom recommendation detail** (ek time ek view).

### Agent overview (`#viewAgent`)
- `Test AI` button (→ Test view), `Deactivate` (no handler). Dismissible banner `#agentBanner`. Unresolved-questions card + "Go to review". Setup grid 3 steps → Training / Instructions / Test views (progress bars animate). Promo card "Set it up for me".

### Training data (`#viewTraining`)
- Back → Agent, Test AI. **Primary tabs** (`#tabbar`): Products · Collections · Discounts · FAQs · Custom knowledge.
- **Products**: learn toggle, Manage metafields / Sync products (no handler), sub-tabs All/Active/Inactive (visual), product table `#prodRows` (10 rows) — row click → **View product modal `#mProduct`** (read-only detail); eye+kebab per row.
- **Collections**: learn toggle, Sync collections, table `#collRows` (5).
- **Discounts**: Upgrade banner, learn toggle + real-time sync mini switch, empty state.
- **FAQs**: **More actions** dropdown (`#faqMoreBtn` → Import `#mImport` / Export `#mExport`), **Add new** dropdown (`#faqAddBtn` → Add FAQ `#mFaq` / Add category `#mCat`), search (live filter), **Status** filter dropdown (Published/Draft/Clear), **Featured** filter dropdown (Featured/Not featured/Clear), category list `#cats` (5) — category/FAQ row click → edit modal, ⭐ toggle featured, Add FAQ per category.
- **Custom knowledge**: "6 items learned", review banner, **Add data** `#addDataBtn` (scroll), source sub-tabs `#dsSubtabs` (All/URL/Manual/CSV/File/Pages → filter `#dsRows`), sources table (6) — Edit → type-specific modal (Manual→`#mQA`, CSV→`#mCSV`, URL→`#mSource`, Pages→`#mPolicies`, File→`#mFileEdit`), **Re-sync only for URL/Pages**, Delete. Add-data tiles (url/manual/csv/file) → modals. Connect policies tile → `#mPolicies`.

### Instructions (`#viewInstructions`)
- Back → Agent, Test AI. **Tabs** (`#tabbarIns`): General Instructions · Product recommendations · Human handover.
- **General**: Role textarea (250 count), Communication style presets (Friendly/Professional/Empathetic/Custom + free text), Behaviours textarea (1000 count), Default language select, Auto-detect language toggle, Banned topics textarea, Fallback message. Cancel/Save.
- **Product recommendations**: Rules card (2 toggles: never OOS / push overstock). App recommendations: **Add new** `#addRecBtn` → detail view; rows (Best sellers, New arrivals) with status toggle, edit, delete. Custom recommendations: **Add new** `#addCustomBtn` → custom detail; rows with toggle/edit/delete. Cross-sell pairs: Add pair (no handler).
- **Human handover**: Auto triggers (4 toggles). Intent rules: **Add rule** `#addRuleBtn` → inline form `#ruleForm` (topic 150 count, submit disabled until text, Cancel). **Destination radio** (3 options, har ek nested config reveal karta hai): Transfer to human inbox (online msgs textareas + offline sub-radio Leave-a-message/Show contact-methods + wait-behavior radio), Collect info & email (reply-time select + info checkboxes + messages), Show contact methods (message textarea).

### Test AI (`#viewTest`)
- Chat `#chatBody`, reset button, suggestion chips (`.js-ask` scripted replies), input `#chatInput`+send (Enter sends), review-sources info-box, feedback faces (3, single-select).

### Recommendation detail (`#viewRec`)
- Title input, trigger-question chips (`#recTrigInput`+Add, `×` remove), Status select, **Add products** `#addProductsBtn` → **Browse products modal `#mBrowse`**, product rows (eye+trash). Cancel/Save.

### Custom recommendation detail (`#viewCustomRec`)
- Search terms (`#addTermBtn` add row, View examples toggle, example-term click fills), Products conditions (Browse products `#mBrowse` / Browse collections `#mBrowseColl`, collapsible selected lists), products preview table. Cancel/Save.

### Modals (14, sab `.js-mclose` / backdrop / Esc se band)
`#mBrowseColl`, `#mBrowse` (browse products — checkbox add), `#mProduct` (read-only), `#mCat` (edit/add category — name, icon picker, position, status, feature checkbox), `#mFaq` (edit/add FAQ — question, RTE answer, status, category, featured, Delete hidden in add mode), `#mQA` (Q&A — synonyms chips), `#mUploadCSV`, `#mFileEdit`, `#mUploadFile`, `#mSource` (URL — crawl-scope radio 3, re-crawl checkbox), `#mPolicies` (per-page switches, "X of 20 used" counter), `#mCSV`, `#mImport`, `#mExport` (scope radio 2).

---

## Dashboard (`dashboard.html`)

- **Hero**: "Assistant online" pill, buttons Answer 3 questions / Sync catalog / Preview widget (no handlers).
- **Overview card**: date-range dropdown `#rangeBtn`/`#rangeMenu` (Last 7 days / 30 days / 12 months → label update + re-run count animation), "Compare to" static, Reload `#reloadBtn` (re-animate). KPIs: Total conversations, Live conversations `#liveCount` (setInterval every 3.5s ±1, clamp 4–12), Assisted revenue, Total sales share, Resolution rate (Resolved 8 / Total 20). Sab display/animation only.
- **Setup checklist**: ring 0/5, 5 "To do" items, har ek distinct page link (Customize chatbox→chatbox, Sync data→ai-agent, AI instructions→ai-agent, Publish 5 curated→curated-answers, Launch campaign→proactive-chat).
- **Live conversations** feed (4 static rows, Live / Waiting tags).

---

## Inbox (`inbox.html`)

Full JS-rendered, 4-column grid (Filters | List | Thread | Details), `convos[]` (10) with flags.
- **Filters** (`renderFilters`): All / Open / Resolved / Unassigned / Handover / Starred / Blocked — click → set filter, jump to first match, counts per filter.
- **List**: title reflects filter, **Unread toggle** `#unreadToggle` (unread-only), search `#convSearch` (by name), rows (avatar, name, ★, time, unread dot, preview, tags Online store/Handover/AI). Row click → mark read + open thread.
- **Thread**: contact name, **Star** `#starBtn` (toggle starred), **Resolve** `#resolveBtn` (open↔resolved, "Resolved ✓"), messages `#msgs` (in/out bubbles, system notes, Seen), composer `#compInput` (contenteditable) + emoji/attach (decorative) + Send `#sendBtn` (disabled until text, Enter sends).
- **Details**: conversation details, assignee ("Assign" no handler), accordions (device/orders/pages), shopping cart card (Upgrade pill, 2 items, total), satisfaction survey, footer **Block** / **Delete** (no handlers).
- Responsive: columns progressively hide (≤1240 Details, ≤1040 Filters, ≤900 sidebar+list).

---

## Contacts (`contacts.html`)

`contacts[]` (16), client-side filter/search/paginate.
- **Export** `#exportBtn` → **Export modal `#mExport`** (radio: Current page / All contacts; Cancel / Export; close via X/Cancel/backdrop/Esc).
- Stat cards (Total/Customers/Leads/Anonymous — live computed).
- Search `#search` (name OR email), Sort button (decorative), **Tabs** All/Customer/Lead/Anonymous (filter by type), table (Name/Email/Type/Channel/Location/Conversations), empty state, **pager** `#prev`/`#next` (10/page), rows-per-page (static).

---

## Curated Answers (`curated-answers.html`)

Two-view segmented page.
- **At a glance**: 4 KPIs (Published/Served/Needs attention/Questions to curate), "5 of 100 used" progress bar.
- **Segment** `#segbar`: Your curated answers (list) / Add curated answer (add).
- **List view**: Revalidate stock (no handler), search `#caSearch` (by question), table (Question/Status/Products/Stock/Actions, `answers[]` 5), per-row Edit / Delete (no handlers), empty state.
- **Add view**: Shopper question input, Also-matches synonyms input + Add (no handler), Talking points textarea, Status select (Draft/Published), Priority select (Normal/High/Low), Hand-picked products "Browse catalog" (no handler), **Create curated answer** (no handler) + **Cancel** `#cancelAdd` (→ list). Suggestions sidebar (static).

---

## Proactive Chat (`proactive-chat.html`)

Two-view page (no modals).
- **Create proactive chat** `#openTemplates` → template picker; **back** `#backToDash` → dashboard.
- **Dashboard**: subtabs All/Active/Inactive (visual), search/filter icons (decorative), range/compare labels, table `#pcRows` (5 campaigns: name, type, View, CTR bar, ATCs, Revenue, Status badge, Updated, kebab), pager (static).
- **Template picker** `#tplGrid` (10 templates): Welcome, Subscribe, Product rec, Cart booster, View cart, Abandoned cart, Collection boost, Remove items, Search page, Smart Product Page. Upgrade-gated cards → "👑 Upgrade" badge + disabled Create; NEW badge on Smart Product Page. Functional cards **Create** `.js-create` → dashboard.

---

## Analytics (`analytics.html`)

Static, no views/modals.
- **Segment** `#seg`: Weekly / Monthly / Yearly → `#rangeLabel` text swap (Last 7/30 days, 12 months). Visual only.
- **Reload** `#reloadBtn` → re-animate KPI count-up. Export CSV (no handler), kebabs (decorative).
- KPI tiles (Conversations, Recommend→cart, Top question, Fell back — animate).
- Bar chart `#chart` (7 days, animate width on load, not interactive). Unanswered questions card = static empty state.

---

## Plan & Usage (`plan-usage.html`)

Static, no modals.
- **Billing toggle** `#billSeg`: Monthly / Yearly (Save 18%) → rewrites all `.amt` prices + `.terms` via `data-m`/`data-y`.
- Plan cards (Free/Basic/Pro popular/Plus current) — buttons static (no handler).
- **Discount code** `#discInput` + **Apply** `#discApply` (empty → error msg; valid → "✓ Code applied", Enter triggers).
- Usage meter `#umeterFill` (animate). Done-for-you card button (static).
- **FAQ accordion** `#faqList` (6, per-item expand/collapse, "+"→"×", not mutually exclusive).

---

## Settings (`settings.html`)

Two tab panels, no modals.
- **Tabs** `#stabbar`: General / Privacy & Data Requests.
- **General**: Storefront theme select (Auto-detect/Dawn/Refresh/Craft/Custom), **toggle** "Open cart drawer after add to cart" (on).
- **Privacy**: customer data requests card (info), Data retention select (Forever/90/60/30/7 days) + Save (static), redaction info card.
- Note: CSS mein ek "Widget Appearance" tab ka leftover styling hai par HTML mein panel nahi (unbuilt).

---

## index (`index.html`)
Landing/redirect only: `<meta refresh>` → `dashboard.html` (0s) + fallback link. Koi interactivity nahi.

---

## Mock vs Real (summary)

| Aspect | Prototype (mock) | Real app |
|---|---|---|
| Styling | Custom CSS tokens | Polaris components (tokens → Polaris theme) |
| Navigation | Static `<a href>` between .html | React Router / Polaris Navigation |
| Data (tables, KPIs, feeds) | Hardcoded JS arrays | API + App Bridge session |
| Toggles / inputs | Sirf visual state | Persist to DB, reflect on storefront widget |
| File uploads (logo, icons) | FileReader → data URL (session only) | CDN / Shopify Files, save URL |
| Modals / dialogs | UI-only, Save/Export band nahi | Real CRUD, validation, jobs |
| Search / filter / paginate | Client-side over mock arrays | Server queries / indexed search |
| Chatbox live preview | JS DOM show/hide | Same concept, state from real settings |
| Dark mode | Dead code (no UI trigger) | Add proper toggle ya remove |

## Real-build checklist
1. Har view/screen ko React component tree mein todo; layout, states, flows isi prototype se lo.
2. Styling Polaris se replace karo; design tokens map karo.
3. Saare toggles/inputs/selects ko backend settings store se bind karo (abhi sab mock).
4. Chatbox **live-preview logic** carry over karo — sabse valuable.
5. Modals ko real CRUD + validation + async jobs (sync, import, export) se jodo.
6. File uploads real storage pe.
7. Dead code (theme toggle) clean karo ya proper implement karo.
8. Storefront widget (customer-facing) preview ke final output ke basis pe banao.

> Rule of thumb: **structure + flows + interaction logic → carry over**; **styling layer + data/backend → rebuild**.
