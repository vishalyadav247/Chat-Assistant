# ChatConvert — LLM Learning Lab

This folder is a hands-on lab to learn and test how the AI sales agent works —
the LLM, its "training", guardrails, and how vector / hybrid search and RAG
behave. No Remix, no app. Just the LLM core, editable and testable.

## Where to start

> **Building the real app?** `PRODUCTION-BUILD-SPEC.md` is the authoritative spec — read it to confirm your requirements, and hand it to your coding assistant as context.


1. **Read** `LLM-Concepts-Explained.md` — the ideas (training, keyword/vector/hybrid
   search, RAG, guardrails, curated answers) in plain language with examples.
2. **Read** `LLM-Training-Guide.md` — the actual instructions/prompts and rules
   given to the model ("how the AI is trained").
3. **Test it (desktop app that reads these JSON files):** run `chatconvert_ui.py` —
   a Python/Tkinter window: chat on the right, a live workflow diagram on the left
   that lights up the path each message takes, and a "how it worked" breakdown.
   It loads all data from the JSON files here, so editing a file changes the app.

## The files

The five editable data files live in **`data-sources/`**; the app and docs live in `demo/`.

| File | What it is | Edit it to… |
|------|------------|-------------|
| `persona.json` | The assistant's identity, tone, rules (its "training") | change how it talks & behaves |
| `products.json` | The product catalog (40 items) | change what it can recommend |
| `knowledge.json` | Policy / FAQ answers (30 docs) | change what questions it can answer (RAG) |
| `curated_answers.json` | Hand-picked answers for top questions (6) | pre-set replies that skip the LLM |
| `guardrails.json` | Banned topics, fallback, match thresholds | change safety limits |
| `PRODUCTION-BUILD-SPEC.md` | **Source of truth**: architecture + pgvector data model + runtime pipeline + decisions | build the real app / verify alignment |
| `LLM-Guide.html` | **Slide deck** (left menu + pagination): architecture + full technical flow — search, DB, RAG, chat history | understand the whole design |
| `chatconvert_ui.py` | Desktop UI (Python/Tkinter) — reads the JSON files, chat + live workflow diagram | the tester (run this) |
| `prompts.json` | **All the LLM instructions, in plain editable JSON** — router, reply rules, curated confirm, persona template | add/remove/edit any instruction line |
| `prompts.py` | Tiny loader that reads `prompts.json` (don't need to edit) | — |
| `Chat-Flow-Explained.md` | Plain read-through of the whole chat: intent → each lane → human handover | understand how a chat runs, step by step |
| `LLM-Concepts-Explained.md` | The concepts, explained | learn |
| `LLM-Training-Guide.md` | The prompts & guardrail rules | learn / tune |

## Run the desktop app

```bash
pip install openai numpy
python chatconvert_ui.py
```

Put your OpenAI key in the `OPENAI_API_KEY` constant at the top of `chatconvert_ui.py`
(or set the env var, or paste it in the field). Tkinter ships with Python — nothing else
to install. Two buttons: **Connect / Reconnect** (embeds the data) and **Reload data**
(re-reads the JSON files after you edit them, then re-embeds). Left half = the live
workflow path; right half = the chat (inline bubbles); it remembers the session.

## Things to try (to learn each concept)

- `keep my hands warm under $30` → keyword finds nothing, vector wins → **hybrid search**.
- `do you ship to Canada?` → retrieves a policy and answers only from it → **RAG**.
- `what are your best sellers?` → a **curated answer** replies with no LLM call.
- `can you give me medical advice?` → **guardrail** blocks it.
- `a fancy diamond necklace` → no match → it **asks a question** instead of guessing.
- Edit `data-sources/persona.json` (make the tone formal), re-run → replies change → that's **training**.

## Understand the architecture

Open `LLM-Guide.html` in a browser — a slide deck with a left content menu and top-right
pagination covering the whole design: system architecture, data ingestion, the runtime
pipeline step-by-step (with code), and deep dives on vector search, hybrid search,
effective DB calls, chat history, and RAG.
