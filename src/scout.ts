import * as vscode from 'vscode';
import {
    generateRepoMap,
    searchWorkspace,
    readWorkspaceFiles,
    readSlices,
    partialTree,
    SliceSpec
} from './contextTools';
import { pythonOutline } from './pythonOutline';
import { applyCommanderPaste, parseCommanderText, ApplyOutcome } from './applyEdits';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard char budget for the Treasure Map (Copilot.ms web caps near 80k). */
export const TREASURE_MAP_BUDGET = 78_000;

const MAX_TOOL_ROUNDS = 60;
const MAX_IMPLEMENT_ROUNDS = 60;

/**
 * Allow-list of VS Code built-in / Copilot LM tools we'll surface to
 * Launchpad alongside our own. Read-only tools only — these are safe in
 * every mode (scout AND editing). We match by prefix on `tool.name`.
 */
const COPILOT_TOOL_ALLOWLIST: readonly string[] = [
    'copilot_searchCodebase',
    'copilot_search',
    'copilot_findFiles',
    'copilot_readFile',
    'copilot_listDirectory',
    'copilot_listDir',
    'copilot_grepSearch',
    'codebase_search',
    'file_search',
    'grep_search',
    'list_dir',
    'read_file'
];

/**
 * Additional Copilot tools we surface ONLY in editing modes (IMPLEMENT,
 * FOLLOW_INSTRUCTIONS). These let Haiku read-then-edit using Copilot's
 * native tool surface — avoids the byte-for-byte SEARCH/REPLACE bounces
 * that come from emitting edits as text. Never expose these to the scout.
 */
const COPILOT_EDIT_TOOL_ALLOWLIST: readonly string[] = [
    'copilot_replaceString',
    'copilot_insertEdit',
    'copilot_createFile',
    'copilot_applyPatch',
    'replace_string_in_file',
    'multi_replace_string_in_file',
    'create_file',
    'create_directory',
    'apply_patch',
    'insert_edit_into_file',
    'edit_file'
];

function isAllowedCopilotTool(name: string, includeEditTools: boolean): boolean {
    if (COPILOT_TOOL_ALLOWLIST.some(p => name === p || name.startsWith(p))) {
        return true;
    }
    if (includeEditTools && COPILOT_EDIT_TOOL_ALLOWLIST.some(p => name === p || name.startsWith(p))) {
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

export const SCOUT_SYSTEM_PROMPT = [
    'You are **Launchpad**, a lightweight scout model running INSIDE VS Code',
    'with FULL access to the workspace via tool calls. You are the ONLY agent',
    'in this pipeline with file and terminal access.',
    '',
    '---',
    '',
    '## Identity: Who You Are and What You Own',
    '',
    'You are **Launchpad**, a lightweight scout model running INSIDE VS Code',
    'with FULL access to the workspace via tool calls. You are the ONLY agent',
    'in this pipeline with file and terminal access.',
    '',
    '**Scrooge** (the larger model) runs in a BROWSER with ZERO workspace access.',
    'Scrooge cannot:',
    '- read files, list directories, or search code',
    '- run shell commands (git, npm, python, tsc, etc.)',
    '- access the terminal, environment variables, or OS state',
    '- see ANYTHING you don\'t explicitly paste into the Treasure Map',
    '',
    'Therefore:',
    '- If a task requires reading files → YOU do it.',
    '- If a task requires running a command (git diff, git log, npm test,',
    '  python -c, tsc --noEmit) → YOU do it.',
    '- If a task requires searching the codebase → YOU do it.',
    '- You NEVER ask Scrooge to perform any tool-based action.',
    '  Scrooge\'s job is to THINK and PLAN. Your job is to SEE and ACT.',
    '',
    '**Self-check before escalating:** If your Treasure Map contains a phrase',
    'like "run `git ...`" or "check the file at ..." directed at Scrooge,',
    'you have made an error. Rewrite it so YOU run the command first and',
    'paste the OUTPUT into the Treasure Map.',
    '',
    '---',
    '',
    '## Context-Gathering Protocol',
    '',
    'Before composing ANY Treasure Map, execute the following reconnaissance',
    'tiers IN ORDER. Stop early only if the user\'s request is trivially',
    'answerable from Tier 1 alone.',
    '',
    '**When to trace execution paths:**',
    'If the user\'s request matches ANY of these signals, you MUST run the',
    'Execution Path Tracing procedure (Tier 2+):',
    '- Words/phrases: "debug", "trace", "flow", "what happens when",',
    '  "call chain", "how does X work", "walk me through", "why does"',
    '- References a specific error, exception, or unexpected behavior',
    '- Asks about a user action, event handler, or request lifecycle',
    '- Asks "where is X called" or "what calls X"',
    '',
    '### Tier 1: Orientation (always run)',
    '',
    '1. **Scan project structure:**',
    '   - Call `partialTree(roots, depth=2)` on top-level directories.',
    '   - Identify: src/, tests/, config files, entry points.',
    '',
    '2. **Scan project manifests:**',
    '   - Python: read `pyproject.toml`, `setup.cfg`, `setup.py`, or',
    '     `requirements.txt` (first 80 lines). Note dependencies.',
    '   - TypeScript/Node: read `package.json` (full), `tsconfig.json` (full).',
    '     Note scripts, dependencies, compiler options.',
    '   - Scan for critical config: `.env.example`, docker-compose files, CI configs.',
    '',
    '3. **Search for user\'s keywords:**',
    '   - For every symbol, filename, or concept the user mentioned,',
    '     call `searchWorkspace` and log which files + line ranges matched.',
    '',
    '4. **Scan for type/model directories:**',
    '   - From the tree output, identify common type/schema directories:',
    '     types/, types.ts, types.d.ts, models/, models.py, schemas/',
    '     interfaces/, dtos/, *_types.py, *_models.py',
    '   - Bookmark these paths for priority extraction in Tier 2.',
    '',
    '### Tier 2: Structural Understanding (run for non-trivial requests)',
    '',
    '5. **Outline the hot files** (files most relevant to the user\'s ask):',
    '   - Python: Call `pythonOutline` on up to 8 .py files. Extract:',
    '     - class/function signatures WITH type hints and docstrings (first line)',
    '     - `__all__` exports if present',
    '     - decorators (especially `@app.route`, `@pytest.fixture`, `@dataclass`)',
    '   - TypeScript: Call `readSlices` on files, targeting:',
    '     - exported interfaces, types, and enums (search for `export (interface|type|enum)`)',
    '     - class declarations and their public method signatures',
    '     - JSDoc `@param` / `@returns` blocks',
    '     - barrel files (`index.ts`) to understand public API surface',
    '',
    '4. **Extract schemas and types** (highest signal-to-noise context):',
    '',
    '   TypeScript — search for and extract via readSlices:',
    '   - export interface <Name>    → read the full interface block',
    '   - export type <Name>         → read the full type alias',
    '   - export enum <Name>         → read the full enum',
    '   - Zod schemas: z.object(     → read until closing paren/semicolon',
    '   - Data-class-style classes where body is primarily property declarations',
    '',
    '   Use searchWorkspace: "export interface", "export type", "export enum", "z.object"',
    '   filtered to hot files and bookmarked type directories only.',
    '',
    '   Python — search for and extract via readSlices:',
    '   - class Foo(BaseModel):      → Pydantic models (full class)',
    '   - class Foo(TypedDict):      → TypedDict definitions (full class)',
    '   - @dataclass / @dataclasses.dataclass → decorated class (full)',
    '   - class Foo(Enum): / class Foo(StrEnum): → enum class (full)',
    '   - class Foo(Protocol):       → Protocol classes (full)',
    '',
    '   Use searchWorkspace: "(BaseModel)", "TypedDict", "@dataclass", "(Protocol)"',
    '   filtered to hot files and bookmarked model directories only.',
    '',
    '   Extraction rules:',
    '   - Do NOT extract from node_modules/ or third-party packages.',
    '   - If a type file exceeds 200 lines, extract ONLY types imported by hot files.',
    '   - Annotate each block: `### <filepath>:<startLine>-<endLine> — <TypeName>`',
    '',
    '5. **Map the import/dependency graph** for the hot files:',
    '   - Python: search for `from <module> import` and `import <module>` in',
    '     each hot file. Follow ONE level deep into local imports (not stdlib',
    '     or third-party). Read the outline of each local dependency found.',
    '   - TypeScript: search for `import .* from [\'"]\.` (relative imports).',
    '     Follow ONE level deep. Read the outline of each local dependency.',
    '',
    '6. **Trace execution paths** (when triggered by heuristic above):',
    '',
    '   Walk the call chain relevant to the user\'s request:',
    '',
    '   a) Identify the entry point:',
    '      - Python: look for `if __name__`, CLI decorators (@click.command,',
    '        @app.command, typer), FastAPI/Flask route handlers (@app.get,',
    '        @router.post), test functions (def test_*), pytest fixtures.',
    '      - TypeScript: look for activate() (VS Code extensions), app.listen',
    '        or route registrations (Express/Fastify), exported handlers,',
    '        test blocks (describe/it/test).',
    '',
    '   b) Read the entry point function body via readSlices (~40 lines).',
    '',
    '   c) Identify every LOCAL function/method call within it. Ignore stdlib',
    '      and third-party calls.',
    '',
    '   d) For each local call, use searchWorkspace to find its definition.',
    '      Read that function\'s signature + first 15 lines of body.',
    '',
    '   e) Repeat ONE more level deep. Maximum trace depth: 3 levels from',
    '      entry point.',
    '',
    '   f) Cap the trace at 6 nodes. If the chain is longer, summarize the',
    '      middle: "→ ... (N intermediate calls) → ..."',
    '',
    '   g) Note dead ends explicitly: if a call leads to a third-party',
    '      library, dynamic dispatch, or unresolvable reference, write:',
    '      "→ dynamic dispatch at scout.ts:340 — cannot trace further"',
    '',
    '7. **Identify other execution paths** relevant to the request (when NOT tracing):',
    '   - For simpler requests, just read 20 lines from relevant functions to',
    '     understand the call chain at a high level.',
    '   - Read slices of each node in the chain (signature + first 20 lines of body).',,
    '',
    '### Tier 3: Deep Dive (run when the request involves debugging, refactoring, or architecture)',
    '',
    '8. **Read implementation slices** — now that you know the structure, use',
    '   `readSlices` to pull the specific logic the user is asking about.',
    '   Prefer 30–80 line ranges centered on the relevant function body.',
    '   Annotate each slice: `// FROM: src/scout.ts:142-195 (handleEscalate)`',
    '',
    '9. **Gather runtime/config context** if relevant:',
    '   - Config files: `.env.example`, `docker-compose.yml`, CI configs',
    '   - Type definitions: `.d.ts` files, `py.typed` markers, stub files',
    '   - Test fixtures and mocks that reveal expected behavior',
    '',
    '10. **Run diagnostic commands** when the user\'s request implies it:',
    '   - `git diff --stat` and `git diff` (for commit message / review requests)',
    '   - `git log --oneline -20` (for recent history context)',
    '   - `tsc --noEmit 2>&1 | head -50` (for TS type errors)',
    '   - `python -m py_compile <file>` (for Python syntax checks)',
    '   - `grep -rn "TODO|FIXME|HACK" src/` (for known debt)',
    '',
    '### Negative Result Tracking',
    '',
    'During ALL tiers, keep a running log of searches that returned NO results',
    'or UNEXPECTED results. Specifically watch for:',
    '',
    '1. Missing tests: you read src/foo.ts and searched for test/foo, foo.test.ts,',
    '   foo.spec.ts — nothing found.',
    '   → Log: "No test file found for src/foo.ts"',
    '',
    '2. Missing error handling: you traced an execution path and a function',
    '   performs I/O, shell commands, network calls, or file operations with no',
    '   try/catch, no .catch(), no error callback.',
    '   → Log: "No error handling in runCommand() at src/utils.ts:88"',
    '',
    '3. Missing type safety: a Python function has no type hints, or a',
    '   TypeScript function uses `any` where a concrete type is expected.',
    '   → Log: "processData() at src/handler.ts:45 — param typed as any"',
    '',
    '4. Missing documentation: a public function/class has no docstring (Python)',
    '   or JSDoc (TypeScript).',
    '   → Log: "Router.dispatch() at src/router.ts:102 — undocumented"',
    '',
    '5. Unresolved user references: the user mentioned a symbol or concept and',
    '   searchWorkspace returned zero results.',
    '   → Log: "User mentioned \'retryPolicy\' — no matches in workspace"',
    '',
    '6. Missing config or dependencies: you looked for expected config files,',
    '   env vars, or CI definitions and found nothing.',
    '   → Log: "No .env or .env.example found"',
    '',
    'Track ONLY gaps relevant to the user\'s request. Typical count: 3–8 items.',
    'Cap at 15 — if you have more, summarize the remainder.',
    'Each item should be ONE terse line, not a paragraph.',
    '',
    '---',
    '',
    '- **Target:** keep Cited Context under 50 KB (~50,000 chars), leaving',
    '  ~28,000 chars for the Treasure Map framing + Scrooge\'s reply budget.',
    '- **Type definitions get PRIORITY in the character budget.** Allocate',
    '  up to 30% of the Cited Context budget to Types & Schemas. If you must',
    '  cut content to stay under budget, cut Implementation Slices first, then',
    '  Signatures, then Config. Cut Types last.',
    '- **Prioritize signal over volume:** a 20-line interface is worth more',
    '  than 200 lines of implementation.',
    '- **Label everything:** every code block in Cited Context MUST have a',
    '  header: `### <filepath>:<startLine>-<endLine> — <symbol or description>`',
    '- **Summarize when possible:** if a file is relevant but large, provide',
    '  a 3-sentence summary + its outline instead of raw code.',
    '',
    '---',
    '',
    '## Git Operations Protocol',
    '',
    'When the user asks about commits, diffs, branches, or code review:',
    '',
    '1. **YOU run the git commands.** Never delegate git to Scrooge.',
    '',
    '2. **For commit message suggestions:**',
    '   a. Run `git diff --cached --stat` (staged changes summary)',
    '   b. Run `git diff --cached` (staged diff — if >40KB, use `--stat` only',
    '      and then `git diff --cached -- <file>` for the 5 most-changed files)',
    '   c. Run `git diff --stat` (unstaged changes, if relevant)',
    '   d. Run `git log --oneline -5` (recent commit style reference)',
    '   e. Compose commit message(s) yourself in ANSWER mode, OR include the',
    '      diff summaries in a Treasure Map if the changes are architecturally',
    '      complex enough to warrant Scrooge\'s input.',
    '',
    '3. **For code review requests:**',
    '   a. Run `git diff [target]` to get the actual changes',
    '   b. Read the FULL context of each changed function (not just the diff',
    '      hunk — use `readSlices` to get 20 lines above and below)',
    '   c. Package the diffs WITH surrounding context into the Treasure Map',
    '',
    '4. **Self-check:** if your Treasure Map says "review the diff" without',
    '   INCLUDING the diff, you have failed. Scrooge cannot see it.',
    '',
    '---',
    '',
    '## Pre-Escalation Quality Gate',
    '',
    'Before emitting ANY Treasure Map, run this mental checklist:',
    '',
    '☐ Does the Cited Context section contain at least ONE code block?',
    '  → If empty, you almost certainly skipped reconnaissance. Go back.',
    '',
    '☐ Could Scrooge answer the user\'s question using ONLY what\'s in this',
    '  Treasure Map, without needing to ask "can you show me the code"?',
    '  → If no, you need to gather more context.',
    '',
    '☐ Does the Treasure Map ask Scrooge to run any commands or read any files?',
    '  → If yes, rewrite: YOU run them and paste the results.',
    '',
    '☐ Is every file path in the Treasure Map backed by actual content you read?',
    '  → If you mention `src/foo.ts` but didn\'t read it, either read it now',
    '    or remove the reference.',
    '',
    '☐ Are the code blocks annotated with file paths and line numbers?',
    '  → Unannotated code is nearly useless to Scrooge.',
    '',
    '☐ Does "What I Couldn\'t Find" exist in this Treasure Map?',
    '  → It MUST ALWAYS be present. If missing, you skipped negative-result',
    '    tracking. Review your search results for gaps before finalizing.',
    '',
    '☐ If the request triggered execution path tracing, is "## Execution Path"',
    '  present with annotated call chain nodes (filepath:line numbers)?',
    '  → If not present but should be, trace now before finalizing.',
    '',
    '☐ Does every factual assertion in the Treasure Map have a confidence',
    '  tag ([VERIFIED], [INFERRED], or [UNCERTAIN])?',
    '  → Scan each section. Untagged assertions mislead Scrooge about certainty.',
    '',
    '☐ Is the tag distribution plausible?',
    '  → If everything is [VERIFIED], you\'re over-confident.',
    '  → If everything is [UNCERTAIN], do more recon before escalating.',
    '  → Aim for roughly 50–70% VERIFIED, 20–40% INFERRED, 5–15% UNCERTAIN.',
    '',
    '☐ Is the total prompt under 78,000 characters?',
    '  → If over, summarize the least-critical sections. Never truncate mid-block.',
    '',
    '---',
    '',
    '## Confidence Annotations',
    '',
    'Every factual assertion you make in the Treasure Map — in Findings,',
    'Execution Path, Cited Context annotations, and What I Couldn\'t Find —',
    'MUST carry one of three confidence tags:',
    '',
    '**[VERIFIED]** — You directly read the source code, ran a command, or',
    'confirmed via search results. This is a factual restatement of what you saw.',
    '',
    '**[INFERRED]** — You are making a reasonable deduction from what you',
    'read, but did not directly confirm this specific claim. You followed imports',
    'but didn\'t read the target. You recognized a pattern but didn\'t trace it fully.',
    '',
    '**[UNCERTAIN]** — You are speculating, matching on names alone, or',
    'reporting something you could not verify. You searched and found ambiguous',
    'or no results.',
    '',
    '**How to decide which tag to use:**',
    'Ask yourself — "Did I READ the specific code/output that supports this claim?"',
    '- Yes, I read it verbatim → [VERIFIED]',
    '- I read related code and this follows logically → [INFERRED]',
    '- I didn\'t read it, or I read it and it\'s ambiguous → [UNCERTAIN]',
    '',
    '**Formatting rules:**',
    '- Place the tag INLINE at the end of the assertion, not on its own line.',
    '- For Cited Context code blocks, the tag goes in the HEADER line.',
    '- For Execution Path nodes, the tag goes after the description.',
    '- For bullet lists, the tag goes at the end of the bullet.',
    '',
    '**Distribution sanity check:**',
    'Before finalizing, scan your tags. A well-scouted Treasure Map is roughly:',
    '- 50–70% [VERIFIED] (direct reads)',
    '- 20–40% [INFERRED] (logical deductions)',
    '- 5–15% [UNCERTAIN] (gaps or speculation)',
    'If all tags are [VERIFIED], you\'re over-confident. If all are [UNCERTAIN],',
    'do more recon before escalating.',
    '',
    '---',
    '',
    '## Briefing Format',
    '',
    'When done, output ONLY a final answer wrapped in <BRIEFING>…</BRIEFING>:',
    '',
    '<BRIEFING>',
    '## Goal',
    '<one-paragraph restatement of what the user is trying to do>',
    '',
    '## Relevant Files',
    '<bullet list of file paths with one-line justification each>',
    '',
    '## Key Findings',
    '<bullet list of concrete facts: symbols, call sites, conventions.',
    'Cite file:line where useful. No speculation.>',
    '',
    '## Open Questions',
    '<bullet list of things Scrooge should clarify or decide. May be empty.>',
    '</BRIEFING>'
].join('\n');

const IMPLEMENT_SYSTEM_PROMPT = [
    'You are "Launchpad", but for this turn you ARE implementing the user\'s',
    'request directly. Use the tools to read the files you need, then output',
    'edits in the SEARCH/REPLACE format below — and NOTHING ELSE.',
    '',
    'CRITICAL PATH RULES:',
    '  - All file paths in tool calls and `File:` headers MUST be',
    '    workspace-relative (e.g. `src/foo.py`), NEVER absolute',
    '    (`/home/user/...`, `C:\\...`). Do NOT invent or guess at the',
    '    workspace root — you do not know it.',
    '  - If a tool returns "file not found", the path is wrong. Try the path',
    '    exactly as it appeared in earlier search results. Do NOT prepend',
    '    `/home/user/workspace/`, `alpha/`, or any other guessed prefix.',
    '',
    'Format (one block per change; group blocks for the same file together):',
    '',
    'File: path/to/file.py',
    '<<<<<<< SEARCH',
    '<exact existing text, including indentation>',
    '=======',
    '<replacement text>',
    '>>>>>>> REPLACE',
    '',
    'For brand-new files, use a fenced code block instead of SEARCH/REPLACE:',
    '',
    'File: path/to/new_file.py',
    '```python',
    '<full file contents>',
    '```',
    '',
    'Rules:',
    '  - SEARCH text must match the file byte-for-byte (preserve indentation).',
    '    ALWAYS read the file (read_file / readSlices / pythonOutline) in this',
    '    same turn before emitting a SEARCH block. Copy the SEARCH text directly',
    '    from that tool output — never from memory or imagination.',
    '  - Keep edits surgical. Do not reformat surrounding code.',
    '  - If after looking at the code you decide the task is too ambiguous to',
    '    implement safely, output exactly: NEEDS_ESCALATION: <one-sentence reason>',
    '    and nothing else. No bold, no markdown wrappers — plain text only.',
    '  - Do not include any prose, explanation, or summary alongside the edits.',
    '  - ALTERNATIVE PATH: if Copilot\'s native edit tools (e.g. replace_string_in_file,',
    '    create_file, insert_edit_into_file) are available in your tool list, you',
    '    MAY use them directly instead of emitting SEARCH/REPLACE text. They read',
    '    the file themselves and avoid byte-mismatch failures. If you go this',
    '    route, finish the turn with empty text — the router will detect the edits',
    '    by tool name. Do NOT mix both styles in one turn.'
].join('\n');

const FOLLOW_SYSTEM_PROMPT = [
    'You are "Launchpad". The user has pasted prose instructions back from a',
    'heavier model ("Scrooge"). Scrooge has NEVER seen the actual file',
    'contents — it is working from a written briefing and may quote text',
    'that does not literally exist in the file. Treat its prose as a',
    'specification, not as ground truth.',
    '',
    'CRITICAL PATH RULES:',
    '  - All paths in tool calls and `File:` headers MUST be workspace-relative.',
    '    Do NOT invent absolute paths (`/home/user/...`, `C:\\...`).',
    '  - If a tool returns "file not found", the path is wrong. Use the path',
    '    exactly as it appears in the briefing or in earlier search results.',
    '',
    'Workflow:',
    '  1. Read the instructions carefully.',
    '  2. ALWAYS use the tools to read the files Scrooge cited (read_file /',
    '     readSlices / pythonOutline) before emitting any edit. Copy the SEARCH',
    '     text directly from the tool output, NEVER from Scrooge\'s prose, and',
    '     never from memory.',
    '  3. If Scrooge described a region by reference ("the docstring at the',
    '     top of `_setup_ui`") and your read shows no such region, that is',
    '     fine — use the closest real anchor (e.g. the line ABOVE where the',
    '     change should land) for your SEARCH block. Do NOT bail just because',
    '     Scrooge\'s description was loose.',
    '  4. Emit SEARCH/REPLACE blocks (and full-file fences for new files) that',
    '     execute the plan. Same format as below — output edits and ONLY edits.',
    '',
    'File: path/to/file.py',
    '<<<<<<< SEARCH',
    '<exact existing text>',
    '=======',
    '<replacement text>',
    '>>>>>>> REPLACE',
    '',
    'Rules:',
    '  - If Scrooge\'s plan spans multiple phases, implement only the first',
    '    coherent unit of work — typically Phase 1, or whatever the user',
    '    asked you to start with. Note in a single trailing comment line',
    '    "// next: <what\'s left>" if you stopped early.',
    '  - SEARCH text must match the file byte-for-byte.',
    '  - If the plan is so ambiguous you cannot produce safe edits, output',
    '    exactly: NEEDS_ESCALATION: <one-sentence reason>',
    '    Plain text only — no bold, no markdown wrappers.',
    '  - No prose, no markdown, no explanations alongside the edits.',
    '  - ALTERNATIVE PATH: if Copilot\'s native edit tools (e.g. replace_string_in_file,',
    '    create_file) are available, you MAY use them directly instead of emitting',
    '    SEARCH/REPLACE text. Finish the turn with empty text in that case.'
].join('\n');

// ---------------------------------------------------------------------------
// Tool registry exposed to the Scout
// ---------------------------------------------------------------------------

const OWN_TOOLS: vscode.LanguageModelChatTool[] = [
    {
        name: 'searchWorkspace',
        description:
            'Search the workspace for a literal string or regex. Returns matching ' +
            'lines as "path:line: code". First-line tool for locating symbols.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string' },
                isRegex: { type: 'boolean' },
                caseSensitive: { type: 'boolean' },
                include: { type: 'string', description: 'Glob, e.g. "**/*.py".' },
                maxMatches: { type: 'number' }
            },
            required: ['query'],
            additionalProperties: false
        }
    },
    {
        name: 'pythonOutline',
        description:
            'Return a compact structural outline of one or more .py files: ' +
            'imports + every class/def signature with its first-line docstring. ' +
            'Cheap to call on 1–8 files. Use this BEFORE readSlices/readWorkspaceFiles.',
        inputSchema: {
            type: 'object',
            properties: {
                paths: { type: 'array', items: { type: 'string' } }
            },
            required: ['paths'],
            additionalProperties: false
        }
    },
    {
        name: 'readSlices',
        description:
            'Read explicit line ranges from one or more files. Use this after ' +
            'pythonOutline / searchWorkspace has pointed you at specific lines. ' +
            'Far cheaper than reading whole files.',
        inputSchema: {
            type: 'object',
            properties: {
                slices: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'string' },
                            startLine: { type: 'number' },
                            endLine: { type: 'number' }
                        },
                        required: ['path', 'startLine', 'endLine']
                    }
                }
            },
            required: ['slices'],
            additionalProperties: false
        }
    },
    {
        name: 'readWorkspaceFiles',
        description:
            'Read the FULL text of a small number of files. Use sparingly — ' +
            'prefer readSlices unless a slice would lose critical context. ' +
            'Avoid for files >300 lines.',
        inputSchema: {
            type: 'object',
            properties: {
                paths: { type: 'array', items: { type: 'string' } }
            },
            required: ['paths'],
            additionalProperties: false
        }
    },
    {
        name: 'partialTree',
        description:
            'Render a file tree restricted to one or more workspace-relative ' +
            'subdirectories. Useful when Scrooge needs to see what else lives ' +
            'near the relevant code without dumping the whole repo.',
        inputSchema: {
            type: 'object',
            properties: {
                roots: { type: 'array', items: { type: 'string' } },
                maxDepth: { type: 'number', description: 'Default 3.' }
            },
            required: ['roots'],
            additionalProperties: false
        }
    },
    {
        name: 'generateRepoMap',
        description:
            'Render the FULL workspace tree. Expensive and noisy — only call ' +
            'this if the user explicitly asked about overall project layout.',
        inputSchema: {
            type: 'object',
            properties: { maxFiles: { type: 'number' } },
            additionalProperties: false
        }
    }
];

/**
 * Discover Copilot built-in LM tools (allow-listed) and translate them into
 * `LanguageModelChatTool`s we can pass to `model.sendRequest`. When
 * `includeEditTools` is true, also surfaces write-capable tools that let
 * Haiku edit files directly via Copilot's native tool surface.
 */
function discoverCopilotTools(includeEditTools = false): vscode.LanguageModelChatTool[] {
    const all = (vscode.lm as { tools?: readonly vscode.LanguageModelToolInformation[] }).tools;
    if (!all || all.length === 0) {
        return [];
    }
    const out: vscode.LanguageModelChatTool[] = [];
    for (const t of all) {
        if (!isAllowedCopilotTool(t.name, includeEditTools)) {
            continue;
        }
        out.push({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema as object | undefined ?? { type: 'object', properties: {} }
        });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

interface ToolResult {
    text: string;
    isError: boolean;
}

async function executeTool(
    name: string,
    rawInput: unknown,
    token: vscode.CancellationToken,
    toolInvocationToken: vscode.ChatParticipantToolToken | undefined
): Promise<ToolResult> {
    const input = (rawInput && typeof rawInput === 'object') ? rawInput as Record<string, unknown> : {};
    try {
        switch (name) {
            case 'generateRepoMap': {
                const maxFiles = typeof input.maxFiles === 'number' ? input.maxFiles : undefined;
                return { text: await generateRepoMap(maxFiles), isError: false };
            }
            case 'searchWorkspace': {
                const query = typeof input.query === 'string' ? input.query : '';
                if (!query) {
                    return { text: '(error: missing required "query")', isError: true };
                }
                return {
                    text: await searchWorkspace(query, {
                        isRegex: input.isRegex === true,
                        caseSensitive: input.caseSensitive === true,
                        include: typeof input.include === 'string' ? input.include : undefined,
                        maxMatches: typeof input.maxMatches === 'number' ? input.maxMatches : undefined
                    }),
                    isError: false
                };
            }
            case 'readWorkspaceFiles': {
                const paths = Array.isArray(input.paths)
                    ? input.paths.filter((p): p is string => typeof p === 'string')
                    : [];
                if (paths.length === 0) {
                    return { text: '(error: missing or empty "paths")', isError: true };
                }
                return { text: await readWorkspaceFiles(paths), isError: false };
            }
            case 'pythonOutline': {
                const paths = Array.isArray(input.paths)
                    ? input.paths.filter((p): p is string => typeof p === 'string')
                    : [];
                if (paths.length === 0) {
                    return { text: '(error: missing or empty "paths")', isError: true };
                }
                return { text: await pythonOutline(paths), isError: false };
            }
            case 'readSlices': {
                const raw = Array.isArray(input.slices) ? input.slices : [];
                const slices: SliceSpec[] = [];
                for (const s of raw) {
                    if (s && typeof s === 'object') {
                        const o = s as Record<string, unknown>;
                        if (typeof o.path === 'string'
                            && typeof o.startLine === 'number'
                            && typeof o.endLine === 'number') {
                            slices.push({
                                path: o.path,
                                startLine: o.startLine,
                                endLine: o.endLine
                            });
                        }
                    }
                }
                if (slices.length === 0) {
                    return { text: '(error: missing or empty "slices")', isError: true };
                }
                return { text: await readSlices(slices), isError: false };
            }
            case 'partialTree': {
                const roots = Array.isArray(input.roots)
                    ? input.roots.filter((p): p is string => typeof p === 'string')
                    : [];
                if (roots.length === 0) {
                    return { text: '(error: missing or empty "roots")', isError: true };
                }
                const maxDepth = typeof input.maxDepth === 'number' ? input.maxDepth : undefined;
                return { text: await partialTree(roots, maxDepth), isError: false };
            }
            default: {
                // Fall through to Copilot built-in tools via vscode.lm.invokeTool.
                // Permissive at dispatch time: gating happens earlier in
                // discoverCopilotTools() based on mode.
                if (isAllowedCopilotTool(name, true)) {
                    try {
                        const result = await vscode.lm.invokeTool(
                            name,
                            { input, toolInvocationToken },
                            token
                        );
                        return { text: stringifyToolResult(result), isError: false };
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        return { text: `(invoking "${name}" failed: ${msg})`, isError: true };
                    }
                }
                return { text: `(error: unknown tool "${name}")`, isError: true };
            }
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { text: `(tool "${name}" threw: ${msg})`, isError: true };
    }
}

function stringifyToolResult(result: vscode.LanguageModelToolResult): string {
    const parts: string[] = [];
    for (const part of result.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
            parts.push(part.value);
        }
    }
    return parts.join('\n') || '(empty tool result)';
}

// ---------------------------------------------------------------------------
// Generic tool-calling loop
// ---------------------------------------------------------------------------

interface LoopResult {
    finalText: string;
    rounds: number;
    toolsUsed: string[];
}

async function runToolLoop(
    model: vscode.LanguageModelChat,
    systemPrompt: string,
    userPrompt: string,
    tools: vscode.LanguageModelChatTool[],
    maxRounds: number,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    history: vscode.LanguageModelChatMessage[] = [],
    toolInvocationToken?: vscode.ChatParticipantToolToken
): Promise<LoopResult> {
    const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(systemPrompt),
        ...history,
        vscode.LanguageModelChatMessage.User(`User request:\n${userPrompt}`)
    ];

    const toolsUsed: string[] = [];
    let finalText = '';
    let rounds = 0;

    for (let round = 0; round < maxRounds; round++) {
        if (token.isCancellationRequested) {
            break;
        }
        rounds = round + 1;

        const response = await model.sendRequest(messages, { tools }, token);

        const textChunks: string[] = [];
        const toolCalls: vscode.LanguageModelToolCallPart[] = [];

        for await (const part of response.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
                textChunks.push(part.value);
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                toolCalls.push(part);
            }
        }
        const turnText = textChunks.join('');

        if (toolCalls.length === 0) {
            finalText = turnText;
            break;
        }

        const assistantParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
        if (turnText.length > 0) {
            assistantParts.push(new vscode.LanguageModelTextPart(turnText));
        }
        assistantParts.push(...toolCalls);
        messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

        const resultParts: vscode.LanguageModelToolResultPart[] = [];
        for (const call of toolCalls) {
            stream.progress(`Launchpad → ${call.name}(…)`);
            toolsUsed.push(call.name);
            const result = await executeTool(call.name, call.input, token, toolInvocationToken);
            resultParts.push(
                new vscode.LanguageModelToolResultPart(call.callId, [
                    new vscode.LanguageModelTextPart(result.text)
                ])
            );
        }
        messages.push(vscode.LanguageModelChatMessage.User(resultParts));
    }

    if (!finalText) {
        finalText = '(Launchpad ran out of fuel)';
    }
    return { finalText, rounds, toolsUsed };
}

// ---------------------------------------------------------------------------
// Briefing extraction & packaging
// ---------------------------------------------------------------------------

/**
 * Pull the <BRIEFING>…</BRIEFING> block out of the scout's final text.
 * Falls back to the whole text if the model omitted the wrapper.
 */
export function extractBriefingBody(scoutFinalText: string): string {
    const match = scoutFinalText.match(/<BRIEFING>([\s\S]*?)<\/BRIEFING>/i);
    return (match ? match[1] : scoutFinalText).trim();
}

export interface PriorAttempt {
    /** The mode that bailed: 'IMPLEMENT' or 'FOLLOW_INSTRUCTIONS'. */
    mode: string;
    /** Tools Launchpad called during the bailed attempt. */
    toolsUsed: string[];
    /** Why it bailed (NEEDS_ESCALATION reason, or generic message). */
    reason: string;
    /** The bailed attempt's final text output, trimmed for the briefing. */
    finalText: string;
}

export interface BriefingInputs {
    userPrompt: string;
    scoutFinalText: string;
    citedContext?: string;
    partialTreeText?: string;
    modelInfo: { vendor: string; family: string };
    budgetChars?: number;
    priorAttempt?: PriorAttempt;
    executionPath?: string;
    notFoundItems?: string[];
}

const SCROOGE_INSTRUCTIONS = [
    '## What Scrooge is being asked to do',
    '',
    'You (Scrooge) are receiving a briefing prepared in-editor by a small model',
    '("Launchpad"). The user will paste your reply back into Launchpad, who will',
    'translate it into edits against this workspace. Therefore:',
    '',
    '- **You have NO file access.** You cannot read, list, or search the',
    '  workspace. The only code you can see is whatever Launchpad explicitly',
    '  pasted into the "Cited Context" section below (often empty). Do NOT',
    '  quote literal source lines, docstrings, function bodies, or imports',
    '  unless they appear verbatim in this prompt. If you need exact code,',
    '  ask Launchpad to read specific lines and re-run.',
    '- **Output a phased plan in plain prose.** Reference files and symbols by',
    '  name. Keep it actionable.',
    '- **Strongly prefer prose over literal code.** Describe each change in',
    '  English ("in `parse_args`, add a new `--verbose` flag handled the same',
    '  way as `--quiet`") rather than emitting SEARCH/REPLACE blocks. Launchpad',
    '  will read the file and produce the exact edit. SEARCH/REPLACE blocks you',
    '  invent will almost always fail to match.',
    '- **Phase large changes.** Phase 1, Phase 2, Phase 3… Each phase should be',
    '  small enough that Launchpad can apply it without further context.',
    '- **If a "Previously Attempted" section appears below**, an earlier round',
    '  failed. Do NOT claim the task is already done. Do NOT repeat your prior',
    '  plan verbatim. Diagnose the failure, then output a *smaller, more',
    '  concrete* next step. If the failure was a SEARCH/REPLACE byte-mismatch,',
    '  switch to prose-only descriptions of the change.',
    '- **Hard char limit: your reply MUST be ≤80,000 characters** (Copilot.ms cap).',
    '  Aim for ≤78,000.',
    '',
    '## Reading Confidence Tags',
    '',
    'Launchpad\'s assertions in this briefing are tagged with confidence levels:',
    '',
    '- **[VERIFIED]** — Launchpad directly read the code or output. Treat as',
    '  ground truth.',
    '- **[INFERRED]** — Launchpad deduced this from partial evidence. Probably',
    '  correct, but worth flagging if your plan depends on it. If you need',
    '  certainty, ask Launchpad to verify specific details in a follow-up round.',
    '- **[UNCERTAIN]** — Launchpad is guessing or could not confirm. Do NOT',
    '  build critical plan steps on [UNCERTAIN] claims. Either ask Launchpad',
    '  to investigate further, or note the assumption explicitly in your plan.',
    '',
    '## Mode Selection Refinement',
    '',
    'When Launchpad escalates a task to you, think about the context:',
    '',
    '- **Can the user ANSWER this directly?** Simple questions about the codebase',
    '  (what does X do, where is Y defined, what changed recently) should be',
    '  answered directly using available tool calls. You don\'t need Scrooge for lookup.',
    '',
    '- **Can Launchpad IMPLEMENT this directly?** Small, well-scoped edits',
    '  (rename a variable, add a log line, fix a typo, write a simple commit message)',
    '  are within Launchpad\'s capability. Launchpad handles these directly.',
    '',
    '- **You (Scrooge) are needed for ESCALATE cases** — when the task requires:',
    '  - Architectural reasoning across multiple subsystems',
    '  - Complex refactoring with non-obvious tradeoffs',
    '  - Design decisions that benefit from deeper analysis',
    '  - Problems where Launchpad has gathered context but isn\'t confident in',
    '    the solution',
    '',
    '- **When you DO receive an escalation**, your Treasure Map quality is your',
    '  primary contribution. A well-scouted Treasure Map makes you 10x more useful.',
    '  A lazy Treasure Map wastes the user\'s time and tokens. If Launchpad\'s',
    '  findings feel incomplete, ask for clarification or more context before',
    '  proposing a plan.'
].join('\n');

/**
 * Render a "Previously Attempted" section that warns Scrooge a fresh-looking
 * Treasure Map is actually a retry. Truncates the bailed model output so it
 * doesn't blow the budget.
 */
function renderPriorAttemptSection(p: PriorAttempt): string {
    const MAX_FINAL = 1500;
    const finalSnippet = p.finalText.length > MAX_FINAL
        ? p.finalText.slice(0, MAX_FINAL) + `\n\n[… ${p.finalText.length - MAX_FINAL} more chars truncated]`
        : p.finalText;
    const tools = p.toolsUsed.length > 0
        ? p.toolsUsed.slice(0, 20).join(', ') + (p.toolsUsed.length > 20 ? `, … (+${p.toolsUsed.length - 20})` : '')
        : '(none)';
    const lines = [
        '## ⚠️ Previously Attempted (Launchpad bailed)',
        '',
        '**This is a retry, not a fresh task.** Launchpad already attempted this',
        `request in mode \`${p.mode}\` and gave up. Do NOT respond with "already done"`,
        'or repeat the previous plan verbatim — that loop is what got us here.',
        '',
        `- **Bail reason:** ${p.reason}`,
        `- **Tools Launchpad used:** ${tools}`,
        '',
        "**Launchpad's last output (verbatim, possibly truncated):**",
        '',
        '```',
        finalSnippet || '(no output)',
        '```'
    ];
    return lines.join('\n');
}

/**
 * Compose the Treasure Map. Pure function — all inputs are explicit, no
 * workspace access. Enforces the char budget by trimming low-priority
 * sections in order: cited context → partial tree → findings.
 */
export function composeBriefing(inputs: BriefingInputs): string {
    const budget = inputs.budgetChars ?? TREASURE_MAP_BUDGET;
    const briefingBody = extractBriefingBody(inputs.scoutFinalText);
    const modelLabel = `${inputs.modelInfo.vendor}/${inputs.modelInfo.family}`;

    const aboutSection = [
        '## About this prompt',
        '',
        `This Treasure Map was prepared by **Launchpad** running as ${modelLabel}`,
        'inside VS Code. The user will paste this entire prompt into a separate',
        '"Scrooge" session (e.g. claude.ai or copilot.microsoft.com) and follow',
        'up with their actual instructions. They will then paste your reply',
        'back into the `@scrooge` chat participant; Launchpad will read your',
        'response and apply the resulting edits to the workspace.'
    ].join('\n');

    const requestSection = [
        '## Original User Request (verbatim)',
        '',
        '> ' + inputs.userPrompt.trim().split('\n').join('\n> ')
    ].join('\n');

    const findingsSection = [
        '## Launchpad\'s Findings',
        '',
        briefingBody
    ].join('\n');

    const priorAttemptSection = inputs.priorAttempt
        ? renderPriorAttemptSection(inputs.priorAttempt)
        : undefined;

    const sections: { name: string; text: string; trimPriority: number }[] = [
        { name: 'about',      text: aboutSection,            trimPriority: 99 }, // never trim
        { name: 'request',    text: requestSection,          trimPriority: 99 }, // never trim
        { name: 'scrooge',    text: SCROOGE_INSTRUCTIONS,    trimPriority: 99 }, // never trim
        { name: 'findings',   text: findingsSection,         trimPriority: 3  }
    ];

    if (priorAttemptSection) {
        sections.push({ name: 'prior', text: priorAttemptSection, trimPriority: 99 }); // never trim
    }

    if (inputs.partialTreeText && inputs.partialTreeText.trim().length > 0) {
        sections.push({
            name: 'tree',
            text: '## Workspace Subtree\n\n```\n' + inputs.partialTreeText + '\n```',
            trimPriority: 2
        });
    }
    if (inputs.citedContext && inputs.citedContext.trim().length > 0) {
        // If citedContext has markdown subsections (### headers), render as markdown.
        // Otherwise wrap in code fence for backward compatibility.
        const hasSections = inputs.citedContext.includes('\n###');
        const citedText = hasSections
            ? '## Cited Context\n\n' + inputs.citedContext
            : '## Cited Context\n\n```\n' + inputs.citedContext + '\n```';
        sections.push({
            name: 'cited',
            text: citedText,
            trimPriority: 1
        });
    }
    if (inputs.executionPath && inputs.executionPath.trim().length > 0) {
        sections.push({
            name: 'execution',
            text: inputs.executionPath,
            trimPriority: 4  // Lower priority than cited context
        });
    }
    if (inputs.notFoundItems && inputs.notFoundItems.length > 0) {
        const notFoundText = [
            '## What I Couldn\'t Find',
            '',
            '_Launchpad searched for but could not locate the following.',
            'Scrooge should factor these gaps into recommendations._',
            '',
            ...inputs.notFoundItems.map(item => '- ' + item)
        ].join('\n');
        sections.push({
            name: 'notfound',
            text: notFoundText,
            trimPriority: 5  // Lowest trim priority
        });
    } else if (inputs.executionPath || inputs.citedContext) {
        // Always include "What I Couldn't Find" if we have other sections
        const notFoundText = [
            '## What I Couldn\'t Find',
            '',
            'No gaps noted — all searches returned relevant results.'
        ].join('\n');
        sections.push({
            name: 'notfound',
            text: notFoundText,
            trimPriority: 5
        });
    }

    const truncationNotes: string[] = [];
    const compose = (): string => {
        const ordered = [
            sections.find(s => s.name === 'about')!,
            sections.find(s => s.name === 'scrooge')!,
            sections.find(s => s.name === 'prior'),
            sections.find(s => s.name === 'request')!,
            sections.find(s => s.name === 'findings')!,
            sections.find(s => s.name === 'cited'),
            sections.find(s => s.name === 'execution'),
            sections.find(s => s.name === 'notfound'),
            sections.find(s => s.name === 'tree')
        ].filter((s): s is { name: string; text: string; trimPriority: number } => !!s);

        const body = '# Treasure Map for Scrooge\n\n' +
            ordered.map(s => s.text).join('\n\n') +
            (truncationNotes.length > 0
                ? '\n\n---\n' + truncationNotes.join('\n')
                : '');
        return body;
    };

    let composed = compose();
    // Trim from lowest priority up until under budget.
    // Priorities: 1=cited (protected), 2=tree, 3=findings, 4=execution, 5=notfound
    // Trim order protects types by cutting implementation-heavy sections first.
    const trimOrder = ['tree', 'findings', 'execution', 'notfound', 'cited'];
    for (const target of trimOrder) {
        if (composed.length + 64 <= budget) break;
        const idx = sections.findIndex(s => s.name === target);
        if (idx < 0) continue;
        const overshoot = composed.length - budget + 64;
        const original = sections[idx].text;
        if (original.length <= 0) continue;
        if (original.length > overshoot) {
            const keep = Math.max(200, original.length - overshoot - 80);
            sections[idx].text = original.slice(0, keep) +
                `\n\n[truncated: dropped ${original.length - keep} chars from ${target}]`;
            truncationNotes.push(`[truncated: dropped ${original.length - keep} chars from ${target}]`);
        } else {
            // Drop the section entirely.
            sections[idx].text = '';
            truncationNotes.push(`[truncated: dropped entire ${target} section (${original.length} chars)]`);
        }
        composed = compose();
    }

    const footer = `\n\n---\n_Total: ${composed.length} chars (budget ${budget})._`;
    composed += footer;
    return composed;
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Direct text reply (mode = ANSWER).
 */
export async function handleAnswer(
    model: vscode.LanguageModelChat,
    userPrompt: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    history: vscode.LanguageModelChatMessage[] = []
): Promise<void> {
    const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(
            'You are @scrooge (Scrooge McRouter), a concise coding assistant in VS Code. ' +
            'Answer briefly. If the user actually needs codebase context, suggest they ' +
            'rephrase or use /dispatch to send Launchpad on a scouting run.'
        ),
        ...history,
        vscode.LanguageModelChatMessage.User(userPrompt)
    ];
    const response = await model.sendRequest(messages, {}, token);
    for await (const chunk of response.text) {
        stream.markdown(chunk);
    }
}

/**
 * Run the scout loop and emit a Treasure Map (mode = ESCALATE).
 */
export async function handleEscalate(
    model: vscode.LanguageModelChat,
    userPrompt: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    history: vscode.LanguageModelChatMessage[] = [],
    priorAttempt?: PriorAttempt,
    toolInvocationToken?: vscode.ChatParticipantToolToken
): Promise<{ rounds: number; toolsUsed: string[]; chars: number }> {
    stream.progress('Launchpad is scouting the territory…');
    const tools = [...OWN_TOOLS, ...discoverCopilotTools()];

    // If we're escalating *because* an earlier IMPLEMENT/FOLLOW bailed, prefix
    // the scout's user prompt so the scout's findings reflect the retry
    // context (not just a fresh task).
    const scoutPrompt = priorAttempt
        ? [
            `NOTE: A prior ${priorAttempt.mode} attempt by Launchpad failed.`,
            `Bail reason: ${priorAttempt.reason}`,
            'Focus your scouting on understanding *why* the previous attempt',
            'could not complete the request, and gather context that would let',
            'Scrooge produce a smaller, more concrete next step.',
            '',
            '--- ORIGINAL USER REQUEST ---',
            userPrompt
        ].join('\n')
        : userPrompt;

    const scout = await runToolLoop(
        model, SCOUT_SYSTEM_PROMPT, scoutPrompt, tools,
        MAX_TOOL_ROUNDS, stream, token, history, toolInvocationToken
    );

    const briefing = composeBriefing({
        userPrompt,
        scoutFinalText: scout.finalText,
        modelInfo: { vendor: model.vendor, family: model.family },
        priorAttempt
    });

    stream.markdown(
        `**Launchpad returned** — ${scout.rounds} leg${scout.rounds === 1 ? '' : 's'}, ` +
        `${scout.toolsUsed.length} tool${scout.toolsUsed.length === 1 ? '' : 's'} deployed, ` +
        `${briefing.length} chars (budget ${TREASURE_MAP_BUDGET}).\n\n` +
        'Copy the Treasure Map below into Scrooge (claude.ai / copilot.microsoft.com), ' +
        'then add your follow-up. Paste Scrooge\'s reply back into `@scrooge` and ' +
        'Launchpad will translate it into edits — no slash command needed.\n\n'
    );
    stream.markdown('````markdown\n' + briefing + '\n````\n');

    return { rounds: scout.rounds, toolsUsed: scout.toolsUsed, chars: briefing.length };
}

/**
 * Detect a NEEDS_ESCALATION sentinel even if the model wrapped it in markdown
 * (e.g. `**NEEDS_ESCALATION:**`, `### NEEDS_ESCALATION`, leading code fence).
 * Returns the cleaned reason text, or undefined if not an escalation.
 */
export function detectNeedsEscalation(rawText: string): string | undefined {
    if (!rawText) return undefined;
    const stripped = rawText
        .replace(/^```[\s\S]*?\n/, '')   // opening fence
        .replace(/\n```\s*$/, '')         // closing fence
        .replace(/^[#>*_`\s]+/, '')       // markdown lead chars
        .trim();
    const m = stripped.match(/^\**\s*NEEDS[_ ]ESCALATION\s*\**\s*[:\-\u2014]?\s*(.*)$/is);
    if (!m) return undefined;
    return m[1].trim() || '(no reason provided)';
}

/**
 * Common implementation for IMPLEMENT and FOLLOW_INSTRUCTIONS modes:
 * run a tool loop, then parse the model's final text as SEARCH/REPLACE
 * blocks and apply them. Returns the apply outcome plus an "escalated"
 * flag so the caller can fall back to the scout loop.
 */
async function handleEditingLoop(
    model: vscode.LanguageModelChat,
    systemPrompt: string,
    userPrompt: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    history: vscode.LanguageModelChatMessage[] = [],
    toolInvocationToken?: vscode.ChatParticipantToolToken
): Promise<{
    outcome?: ApplyOutcome;
    rounds: number;
    toolsUsed: string[];
    escalated: boolean;
    finalText: string;
}> {
    const tools = [...OWN_TOOLS, ...discoverCopilotTools(true)];
    const result = await runToolLoop(
        model, systemPrompt, userPrompt, tools,
        MAX_IMPLEMENT_ROUNDS, stream, token, history, toolInvocationToken
    );

    const text = result.finalText.trim();
    const escalationReason = detectNeedsEscalation(text);
    if (escalationReason !== undefined) {
        return {
            rounds: result.rounds,
            toolsUsed: result.toolsUsed,
            escalated: true,
            finalText: `NEEDS_ESCALATION: ${escalationReason}`
        };
    }

    const blocks = parseCommanderText(text);
    if (blocks.length === 0) {
        // No SEARCH/REPLACE in the final text — but if Haiku used Copilot's
        // native edit tools (replace_string_in_file, etc.) the workspace is
        // already updated. Treat that as success rather than escalating.
        const usedEditTool = result.toolsUsed.some(
            n => COPILOT_EDIT_TOOL_ALLOWLIST.some(p => n === p || n.startsWith(p))
        );
        if (usedEditTool) {
            return {
                rounds: result.rounds,
                toolsUsed: result.toolsUsed,
                escalated: false,
                finalText: text
            };
        }
        return {
            rounds: result.rounds,
            toolsUsed: result.toolsUsed,
            escalated: true,
            finalText: text
        };
    }

    stream.progress(`Applying ${blocks.length} edit${blocks.length === 1 ? '' : 's'}…`);
    const outcome = await applyCommanderPaste(text);
    return {
        outcome,
        rounds: result.rounds,
        toolsUsed: result.toolsUsed,
        escalated: false,
        finalText: text
    };
}

export async function handleImplement(
    model: vscode.LanguageModelChat,
    userPrompt: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    history: vscode.LanguageModelChatMessage[] = [],
    toolInvocationToken?: vscode.ChatParticipantToolToken
) {
    return handleEditingLoop(model, IMPLEMENT_SYSTEM_PROMPT, userPrompt, stream, token, history, toolInvocationToken);
}

export async function handleFollowInstructions(
    model: vscode.LanguageModelChat,
    userPrompt: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    history: vscode.LanguageModelChatMessage[] = [],
    toolInvocationToken?: vscode.ChatParticipantToolToken
) {
    return handleEditingLoop(model, FOLLOW_SYSTEM_PROMPT, userPrompt, stream, token, history, toolInvocationToken);
}

/**
 * Internal second-opinion: when an IMPLEMENT or FOLLOW pass bails, run a
 * scout to gather concrete file-level findings, then re-run the same
 * editing loop with those findings injected as additional context. This
 * breaks the "bail \u2192 dump-to-Scrooge \u2192 paste back \u2192 bail again" loop.
 *
 * Returns the final outcome. If THIS pass also bails, the caller should
 * fall back to a full Treasure Map.
 */
export async function handleSecondOpinion(
    model: vscode.LanguageModelChat,
    originalPrompt: string,
    bailedMode: 'IMPLEMENT' | 'FOLLOW_INSTRUCTIONS',
    bailReason: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    history: vscode.LanguageModelChatMessage[] = [],
    toolInvocationToken?: vscode.ChatParticipantToolToken
) {
    stream.progress('Launchpad is gathering a second opinion before bothering Scrooge\u2026');
    const scoutTools = [...OWN_TOOLS, ...discoverCopilotTools()];

    const scoutPrompt = [
        `A prior ${bailedMode} attempt failed. Bail reason: ${bailReason}`,
        '',
        'Gather the MINIMUM context needed for a retry:',
        '  - Confirm the workspace-relative paths of every file mentioned in',
        '    the original request below. Use searchWorkspace + readSlices.',
        '  - Read the exact lines that need to change so the next attempt',
        '    can produce byte-exact SEARCH/REPLACE blocks.',
        '  - Do NOT propose a plan. Just report verified file paths and the',
        '    relevant code slices.',
        '',
        '--- ORIGINAL REQUEST ---',
        originalPrompt
    ].join('\n');

    const scout = await runToolLoop(
        model, SCOUT_SYSTEM_PROMPT, scoutPrompt, scoutTools,
        MAX_TOOL_ROUNDS, stream, token, history, toolInvocationToken
    );
    const findings = extractBriefingBody(scout.finalText) || scout.finalText;

    stream.progress('Retrying the edit with verified findings\u2026');

    const systemPrompt = bailedMode === 'IMPLEMENT' ? IMPLEMENT_SYSTEM_PROMPT : FOLLOW_SYSTEM_PROMPT;
    const retryPrompt = [
        '--- ORIGINAL REQUEST ---',
        originalPrompt,
        '',
        '--- VERIFIED CONTEXT FROM SCOUT (use these paths and code slices verbatim) ---',
        findings,
        '',
        '--- INSTRUCTIONS ---',
        'A previous attempt failed: ' + bailReason,
        'You now have verified file paths and code slices above. Use them to',
        'produce byte-exact SEARCH/REPLACE blocks (or call native edit tools).',
        'Do NOT bail again unless the scout findings clearly contradict the',
        'original request.'
    ].join('\n');

    const result = await handleEditingLoop(
        model, systemPrompt, retryPrompt, stream, token, history, toolInvocationToken
    );
    return {
        ...result,
        rounds: result.rounds + scout.rounds,
        toolsUsed: [...scout.toolsUsed, ...result.toolsUsed]
    };
}
