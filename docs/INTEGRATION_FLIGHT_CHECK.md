# `@router` — Integration Flight Check (Phase 5)

A scripted manual test protocol for the `@router` Copilot Chat Participant.
Automated unit tests cover the parsers, briefing composer, and context
tools. This checklist verifies everything the unit tests **cannot** see:
the Copilot Chat UI, streaming output, native diff gutters, dirty-state
indicators, and the end-to-end clipboard loop.

> Run every section in order. Do not skip steps — later steps depend on
> earlier state (e.g. having a dirty buffer to verify).

---

## 0. Pre-flight Setup

**Goal:** confirm the dev host launches and `@router` is registered.

| # | Action | Expected Result |
|---|--------|-----------------|
| 0.1 | From the project root, run `npm run compile`. | Exit code 0, `dist/extension.js` exists. |
| 0.2 | In VS Code, open this workspace and press **F5**. | A new Extension Development Host window opens. |
| 0.3 | In the dev host, open a real test workspace (e.g. a clone of any small TypeScript repo). | Folder is open, file explorer populates. |
| 0.4 | Sign in to GitHub Copilot if not already (`Copilot: Sign In`). | Copilot status bar item shows ready. |
| 0.5 | Open Copilot Chat (`Ctrl/Cmd+Alt+I`). Type `@`. | A `router` participant appears in the autocomplete with the description "Routes complex coding tasks…". |
| 0.6 | Type `@router /` and inspect slash-command suggestions. | Three commands listed: `/scout`, `/trivial`, `/apply`. |

**❌ FAIL CRITERIA:** participant absent from autocomplete, slash commands missing, or Copilot Chat refuses to load the extension.

---

## 1. Difficulty Evaluator — Trivial Path

**Goal:** verify the heuristic short-circuits trivial prompts to a direct answer (no Scout, no tools).

### 1.1 Pure greeting

**Prompt:**
```
@router hi
```

**Expected:**
- Progress line: `Routing as trivial via <vendor> / <family>…`
- A short greeting / capability summary streams in.
- **No** `Scout → toolName(…)` progress lines anywhere.
- **No** Briefing Package code block.

### 1.2 Meta question

**Prompt:**
```
@router what can you do?
```

**Expected:** same as 1.1 — trivial route, direct answer, no tool calls.

### 1.3 Forced trivial override

**Prompt:**
```
@router /trivial Refactor the entire authentication module to use OAuth.
```

**Expected:**
- Progress line shows `trivial` even though the content looks complex.
- Direct answer streams in (likely the model suggesting a rephrase or a high-level outline). No tool calls.

**❌ FAIL CRITERIA:** "Scout →" progress text appears, a Briefing block is rendered, or the response contains the literal `<BRIEFING>` tag.

---

## 2. Complex Path — Scout Triggers Tool Calls

**Goal:** verify a complex prompt fires the Scout loop and uses the Phase-2 tools.

### 2.1 Heuristic-routed complex prompt

**Prompt** (replace `<filename>` with a real source file in the open workspace):
```
@router Where in this codebase is <filename> imported, and what does it export?
```

**Expected (in order):**
1. Progress: `Routing as complex via <vendor> / <family>…`
2. Progress: `Scout is gathering workspace context…`
3. One or more `Scout → generateRepoMap(…)` / `Scout → searchWorkspace(…)` / `Scout → readWorkspaceFiles(…)` progress lines.
4. Final summary line: `Scout complete — N rounds, M tool calls.`
5. A copyable Briefing Package code block (see Section 3).

### 2.2 Forced scout override

**Prompt:**
```
@router /scout hello
```

**Expected:** Scout runs even on a trivial-looking prompt. At least one progress line beginning with `Scout →`.

### 2.3 Cancellation

**Prompt:** any complex prompt from 2.1.

**During tool execution**, click the chat **Cancel** button.

**Expected:** the loop halts; no further tool-call progress lines after cancellation; chat does not crash.

**❌ FAIL CRITERIA:** zero `Scout →` lines on a complex prompt, the loop runs more than 6 rounds, or the chat hangs / errors after cancel.

---

## 3. Briefing Package Rendering

**Goal:** verify the final Briefing Package renders as a copyable, well-formed Markdown block.

Using the response from **Section 2.1**:

| # | Check | Expected |
|---|-------|----------|
| 3.1 | A fenced code block is visible, rendered with monospace font and no syntax highlighting (it's a `markdown` block). | ✅ |
| 3.2 | Hover over the block — a **Copy** button appears in the corner. | ✅ |
| 3.3 | Click Copy, paste into a scratch buffer. The pasted text starts with `# Briefing Package for Commander`. | ✅ |
| 3.4 | The pasted text contains all of: `## Original User Request`, `## Goal`, `## Relevant Files`, `## Key Findings`, `## Open Questions`, `## Repository Map`. | ✅ |
| 3.5 | The original prompt from Section 2.1 appears verbatim under `## Original User Request`. | ✅ |
| 3.6 | The repo map under `## Repository Map` is wrapped in triple backticks and **does not** include `node_modules/`, `.git/`, `dist/`, or `out/`. | ✅ |
| 3.7 | The literal string `<BRIEFING>` does **not** appear anywhere in the rendered output. | ✅ |
| 3.8 | The pasted text contains no `[truncated]` markers unless the workspace genuinely exceeded 2000 files. | ✅ |

**❌ FAIL CRITERIA:** missing Copy button, raw `<BRIEFING>` tags leaking through, ignored directories appear in the map, or the user prompt is missing.

---

## 4. `/apply` — Write Tool & Dirty-State Invariant

**Goal:** verify `/apply` parses pasted Commander output, applies edits via `WorkspaceEdit`, and **leaves the file unsaved** for review.

### 4.1 Setup a known target

In the dev-host workspace, create a file `flight-check.txt` containing exactly:
```
alpha
beta
gamma
```
Save it (so its on-disk state is clean).

### 4.2 SEARCH/REPLACE on an existing file

**Prompt** (paste exactly, including the literal markers):
```
@router /apply
File: flight-check.txt
<<<<<<< SEARCH
beta
=======
BETA-MODIFIED
>>>>>>> REPLACE
```

**Expected:**
- Chat output: `✅ Applied edits to 1 file: flight-check.txt`
- Chat footer reminds the user to save / undo.
- Open `flight-check.txt`. **The editor tab title shows a dot (•)** indicating an unsaved buffer.
- Buffer contents:
  ```
  alpha
  BETA-MODIFIED
  gamma
  ```
- The diff gutter (left of the line numbers) shows a **modified** marker on line 2.
- `Ctrl/Cmd+Z` reverts the change inside the editor.
- Re-do the edit, then **save** (`Ctrl/Cmd+S`); on-disk file now matches the buffer.

### 4.3 Create a new file

**Prompt:**
```
@router /apply
File: phase5-new-file.ts
```ts
export const HELLO = "world";
```
```

**Expected:**
- Chat output: `🆕 Created 1 file: phase5-new-file.ts`
- The file appears in the explorer **with the unsaved-dot indicator**.
- Contents match exactly `export const HELLO = "world";` (one line, no extras).

### 4.4 Multi-file paste

**Prompt:** (same fences, two files in one paste)
```
@router /apply
File: flight-check.txt
<<<<<<< SEARCH
alpha
=======
ALPHA
>>>>>>> REPLACE

File: flight-check-two.txt
```
brand new file body
```
```

**Expected:**
- Chat reports both an **applied** entry (`flight-check.txt`) and a **created** entry (`flight-check-two.txt`).
- Both files are dirty; neither has been auto-saved.

### 4.5 Failure modes

| Sub-test | Prompt | Expected |
|----------|--------|----------|
| 4.5a Malformed paste | `@router /apply just some prose, no code` | Warning: `⚠️ No file edits found in the pasted text.` Lists expected formats. No file changes. |
| 4.5b Missing target for SEARCH/REPLACE | `@router /apply`<br>`File: nope/never.ts`<br>`<<<<<<< SEARCH`<br>`x`<br>`=======`<br>`y`<br>`>>>>>>> REPLACE` | `❌ 1 failure: nope/never.ts — target does not exist…` No new file created. |
| 4.5c SEARCH text not in file | `@router /apply`<br>`File: flight-check.txt`<br>`<<<<<<< SEARCH`<br>`THIS STRING IS NOT IN THE FILE`<br>`=======`<br>`X`<br>`>>>>>>> REPLACE` | `❌ 1 failure: flight-check.txt — SEARCH text not found…` `flight-check.txt` remains untouched (no dirty marker). |
| 4.5d Unterminated SEARCH block | `@router /apply`<br>`File: flight-check.txt`<br>`<<<<<<< SEARCH`<br>`alpha` | `⚠️ No file edits found…` (parser correctly drops malformed block). |

**❌ CRITICAL FAIL:** any successful `/apply` that leaves the target file in a **clean / saved** state. Phase-4 invariant: edits must always land in the dirty buffer for human review.

---

## 5. Model Selection Sanity

**Goal:** confirm model resolution falls back gracefully.

### 5.1 Default selection

**Prompt:** any from Section 1.

**Expected:** the progress line names a real vendor/family (e.g. `anthropic / claude-3-5-haiku` or `copilot / gpt-4o`).

### 5.2 Manual model picker override

In the chat input, click the model picker and select a different model. Send `@router /scout list the source files in this repo`.

**Expected:** progress line names the **manually selected** model, not the auto-pick.

### 5.3 No-model failure mode

(Hard to reproduce intentionally — only verify if Copilot is signed out.)

**Expected:** `⚠️ No language models are available. Make sure you are signed into GitHub Copilot…`

---

## 6. Logs & Telemetry Spot-Check

| # | Action | Expected |
|---|--------|----------|
| 6.1 | After any `/scout` run, open the Output panel → **GitHub Copilot Chat** channel. | No exceptions or stack traces from `scrooge-mcrouter`. |
| 6.2 | Open the Developer Tools console (`Help → Toggle Developer Tools`). | No red errors originating from our extension during the test run. |

---

## Sign-off

| Section | Pass / Fail | Notes |
|---------|-------------|-------|
| 0. Pre-flight | ☐ | |
| 1. Trivial path | ☐ | |
| 2. Complex / Scout | ☐ | |
| 3. Briefing rendering | ☐ | |
| 4. `/apply` & dirty-state | ☐ | |
| 5. Model selection | ☐ | |
| 6. Logs | ☐ | |

**Tester:** _________________ **Date:** _________________ **Build (git SHA):** _________________
