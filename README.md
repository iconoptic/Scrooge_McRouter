# Scrooge McRouter

> A VS Code chat participant where **Launchpad** (a small in-editor model) scouts your codebase and packs a **Treasure Map** for **Scrooge** (a bigger model on the web). Paste Scrooge's reply back and Launchpad applies the edits — no leaving the editor, no copy-paste tax.

Scrooge McRouter is a Copilot Chat participant that turns your "ask the smart model in the browser" workflow into a one-stop round-trip. Launchpad does the boring legwork (reading files, running outlines, packaging context), Scrooge does the expensive thinking, and Launchpad lands the plane (applies SEARCH/REPLACE edits, snapshots the originals, and hands you native diff buttons).

---

## How it works

```
You ────► @router ──► Launchpad scouts the repo ──► Treasure Map (≤78k chars)
                                                          │
                                                          ▼
                              You paste the Map into Scrooge (web chat)
                                                          │
                                                          ▼
You paste Scrooge's reply ──► @router ──► Launchpad applies edits ──► Deposit / Bounce
```

- **Treasure Map** — a self-contained briefing with the user's request, repo tree, file slices, scout findings, and any "Previously Attempted" context from earlier turns.
- **Deposit** — edits applied cleanly, with snapshot-backed diff buttons and (optionally) auto-saved buffers.
- **Bounce** — an edit failed to match; Launchpad explains why and Scrooge gets a second-opinion retry before you have to copy anything.

---

## Modes

`@router` self-routes every request through Haiku (a tiny LM call) into one of four modes:

| Mode | When it fires | What happens |
|---|---|---|
| **ANSWER** | Pure Q&A, no edits needed | Launchpad answers directly. |
| **IMPLEMENT** | Small/local change Launchpad can do alone | Launchpad scouts + edits, with the full Copilot edit toolset. |
| **ESCALATE** | Big or cross-cutting change | Launchpad packs a Treasure Map for Scrooge. |
| **FOLLOW_INSTRUCTIONS** | You pasted Scrooge's SEARCH/REPLACE blocks | Launchpad applies them and reports Deposit/Bounce. |

You can also force a mode with a slash command.

---

## Slash commands

- `/dispatch` — force ESCALATE: build a Treasure Map right now.
- `/implement` — force IMPLEMENT: let Launchpad do the change locally.
- `/penny` — force ANSWER: just answer, no edits.
- `/deposit` — force FOLLOW_INSTRUCTIONS: apply the pasted edit blocks.

---

## Settings

| Setting | Default | What it does |
|---|---|---|
| `scroogeMcRouter.autoSaveAfterDeposit` | `true` | Save modified buffers after a successful deposit. Set to `false` if you want to review dirty buffers before saving. |

---

## Requirements

- VS Code `^1.95.0`
- The **GitHub Copilot Chat** extension (declared as an `extensionDependencies`).

---

## Install (from source)

```bash
npm install
npx tsc -p ./
```

Then press `F5` in VS Code to launch an Extension Development Host, or package with `vsce package`.

---

## Development

```bash
npm test            # 89 unit tests via mocha + chai + sinon
npx tsc -p ./       # typecheck + build to dist/
```

Source layout:

```
src/
  extension.ts     # Chat participant entry, routing, history threading
  router.ts        # Haiku mode-decision call
  scout.ts         # Tool-loop, briefing assembly, second-opinion retry
  applyEdits.ts    # SEARCH/REPLACE parser + applier, diff buttons
  snapshots.ts     # scrooge-pre:// URI provider for pre-edit diffs
  contextTools.ts  # Workspace tree, file slicing, vault snapshot
  pythonOutline.ts # Lightweight Python symbol outline
```

---

## Why?

Because the smartest model lives in your browser and the cheapest model lives in your editor. Scrooge McRouter makes them work the same shift.

> *"Work smarter, not harder!"* — Scrooge McDuck
