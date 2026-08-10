---
name: spec-workflow
description: The spec-driven development loop for ChatConvert. Use when starting, resuming, or completing any feature work — picking what to build, implementing against a spec, and updating progress.
---

# Spec-driven workflow

Every feature in this project has a spec in `.claude/specs/` (indexed in `00-overview.md`). Work is never freelanced — it flows spec → implementation → verification → progress update.

## The loop

1. **Pick**: open `.claude/PROGRESS.md` → feature table. Take the highest-priority feature that is `spec-ready` and unblocked (dependency column). Confirm with the user if ambiguous.
2. **Read**: the feature's spec fully, plus `00-overview.md` (guidelines) and the specs it depends on. Check "Out of scope / gaps" — do not build those.
3. **Mark**: set the feature `in-progress` in PROGRESS.md before coding.
4. **Implement**: follow the spec's Data model / Routes / Business rules exactly. Use the relevant skills (`db-tenancy`, `shopify-app-dev`, `polaris-admin-ui`, `theme-extension-widget`, `ai-pipeline`). If the spec conflicts with reality discovered during work, STOP: update the spec first (spec is the source of truth), note the delta in PROGRESS.md decisions log, then continue.
5. **Verify**: walk the spec's **Acceptance criteria** one by one — each gets a pass/fail with evidence. Run `npm run typecheck && npm run lint && npm run build` plus feature tests. Use the `qa-verifier` and `tenancy-auditor` subagents for review.
6. **Close**: set `done` in PROGRESS.md with a one-line note (what shipped, any deferred criteria as new backlog rows). Never mark done with failing criteria.

## Rules

- One feature in-progress at a time unless the user says otherwise.
- Spec changes are edits to the spec file + a dated line in PROGRESS.md decisions log — never silent drift.
- New scope discovered mid-feature → backlog row in PROGRESS.md, not scope creep.
- Design references live in `.claude/resources/html_design/` — when a spec cites a page, open it for pixel/interaction detail rather than guessing.
- Requirements questions the resources can't answer → shopify.dev docs (via `docs-researcher` subagent / shopify-dev-mcp), then ask the user.
