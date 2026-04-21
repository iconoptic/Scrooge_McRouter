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
    'You are "Launchpad", a lightweight in-editor scout for the boss ("Scrooge").',
    'You are NOT solving the user\'s task. You are gathering targeted context so',
    'a heavier model can solve it on the web.',
    '',
    'This workspace is Python-focused. Prefer the Python-aware tools.',
    '',
    'Recommended workflow:',
    '  1. searchWorkspace for the symbols / strings the user mentioned.',
    '  2. pythonOutline on the 1–8 .py files most likely to be relevant.',
    '     This gives you signatures + docstrings without burning bytes on bodies.',
    '  3. readSlices on the specific line ranges that matter.',
    '  4. Only use readWorkspaceFiles for whole files when a slice would lose',
    '     critical context. Avoid for files >300 lines.',
    '  5. partialTree(roots) when Scrooge needs to know what else lives near the',
    '     relevant code. NEVER call generateRepoMap unless the user explicitly',
    '     asked about overall layout — the full tree is wasteful.',
    '',
    'Built-in Copilot tools (codebase_search, file_search, grep_search, read_file,',
    'list_dir, etc.) may be available. Prefer them for semantic search; their',
    'results are typically higher-signal than a regex scan.',
    '',
    'Operating rules:',
    '  - Total file bytes you read should stay under ~50 KB. Be surgical.',
    '  - Do NOT propose code changes. Do NOT solve the task. Do NOT speculate.',
    '  - Stop calling tools as soon as you have enough context.',
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
    '  Aim for ≤78,000.'
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
        'back into the `@router` chat participant; Launchpad will read your',
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
        sections.push({
            name: 'cited',
            text: '## Cited Context\n\n```\n' + inputs.citedContext + '\n```',
            trimPriority: 1
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
    const trimOrder = ['cited', 'tree', 'findings'];
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
            'You are @router (Scrooge McRouter), a concise coding assistant in VS Code. ' +
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
        'then add your follow-up. Paste Scrooge\'s reply back into `@router` and ' +
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
