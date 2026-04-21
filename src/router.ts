import * as vscode from 'vscode';
import { parseCommanderText } from './applyEdits';

/**
 * Phase A — Routing brain.
 *
 * Given the user's prompt, decide what `@scrooge` should do:
 *
 *   - ANSWER               → reply directly with text. Greetings, conceptual Qs.
 *   - IMPLEMENT            → small/clear coding task. Haiku reads files,
 *                            emits SEARCH/REPLACE blocks, we apply them.
 *   - ESCALATE             → ambiguous, large, or cross-cutting. Run the
 *                            scout loop and emit a Treasure Map for the boss
 *                            (Scrooge) to consume on the web.
 *   - FOLLOW_INSTRUCTIONS  → the prompt is *prose instructions pasted back
 *                            from Scrooge*. Haiku reads the cited files and
 *                            translates the instructions into SEARCH/REPLACE
 *                            blocks, which we apply.
 *
 * Two routing layers:
 *
 *   1. `isPureEditsPaste(text)` — pure, synchronous. If the prompt parses as
 *      ≥1 SEARCH/REPLACE block with very little surrounding prose, we skip
 *      the LM entirely and apply directly. This is the same path `/deposit`
 *      uses.
 *
 *   2. `decideMode(model, prompt)` — one short Haiku call. The model returns
 *      a single JSON object `{ "mode": ..., "rationale": ... }`. Pure
 *      `parseModeDecision()` is exported for unit testing.
 */

export type Mode = 'ANSWER' | 'IMPLEMENT' | 'ESCALATE' | 'FOLLOW_INSTRUCTIONS';

export interface ModeDecision {
    mode: Mode;
    rationale: string;
}

// ---------------------------------------------------------------------------
// Layer 1 — pure-edits detector
// ---------------------------------------------------------------------------

/**
 * Decide whether `text` looks like a paste-from-Scrooge consisting almost
 * entirely of SEARCH/REPLACE blocks (or full-file fences with `File:` headers).
 *
 * Returns `true` if we should bypass the LM and route straight to
 * `applyCommanderPaste`. Pure / synchronous.
 *
 * Rules:
 *   - Must parse to ≥1 block.
 *   - Non-block prose (lines outside any header / fence / SR marker) must be
 *     ≤10% of total non-blank lines AND ≤30 lines absolute.
 */
export function isPureEditsPaste(text: string): boolean {
    if (!text || text.trim().length === 0) {
        return false;
    }
    const blocks = parseCommanderText(text);
    if (blocks.length === 0) {
        return false;
    }

    // Count "structural" lines (anything inside a fence, SR block, or header).
    // Approximation: any line matching one of the structural patterns OR
    // sitting between an opening fence and its closer.
    const lines = text.split(/\r?\n/);
    const totalNonBlank = lines.filter(l => l.trim().length > 0).length;
    if (totalNonBlank === 0) {
        return false;
    }

    let inFence = false;
    let fenceMarker = '';
    let inSR = false;
    let structural = 0;
    let prose = 0;

    const headerRx = /^\s*(?:file|path)\s*[:=]/i;
    const mdHeaderPath = /^\s*#{1,6}\s+\S+\.[A-Za-z0-9]+\s*$/;
    const fenceRx = /^([`~]{3,})/;
    const srOpenRx = /^<{3,}\s*SEARCH\s*$/i;
    const srCloseRx = /^>{3,}\s*REPLACE\s*$/i;
    const dividerRx = /^={3,}\s*$/;

    for (const line of lines) {
        if (line.trim().length === 0) {
            continue;
        }
        if (inFence) {
            structural++;
            if (line.startsWith(fenceMarker)) {
                inFence = false;
            }
            continue;
        }
        const fence = line.match(fenceRx);
        if (fence) {
            inFence = true;
            fenceMarker = fence[1];
            structural++;
            continue;
        }
        if (srOpenRx.test(line)) {
            inSR = true;
            structural++;
            continue;
        }
        if (inSR) {
            structural++;
            if (srCloseRx.test(line)) {
                inSR = false;
            }
            continue;
        }
        if (dividerRx.test(line) || headerRx.test(line) || mdHeaderPath.test(line)) {
            structural++;
            continue;
        }
        prose++;
    }

    if (prose > 30) {
        return false;
    }
    const proseRatio = prose / totalNonBlank;
    return proseRatio <= 0.10;
}

// ---------------------------------------------------------------------------
// Layer 2 — Haiku-routed mode decision
// ---------------------------------------------------------------------------

const ROUTER_SYSTEM_PROMPT = [
    'You are the routing brain of @scrooge (Scrooge McRouter), a VS Code chat',
    'participant. For every user turn you classify what should happen next.',
    '',
    'Pick exactly one mode:',
    '',
    '  - ANSWER: A brief conceptual / factual / greeting reply suffices.',
    '    No code edits, no file reads needed. Examples: "what does X mean?",',
    '    "hello", "explain this concept".',
    '',
    '  - IMPLEMENT: A small, clearly-defined coding task you (a Haiku-class',
    '    model) can carry out yourself by reading at most a few files and',
    '    producing surgical edits. Examples: "rename foo to bar in baz.py",',
    '    "add a docstring to the parse_args function", "fix the typo on',
    '    line 42 of main.py".',
    '',
    '  - ESCALATE: The task is ambiguous, large, or cross-cutting. The user',
    '    is going to consult a heavier model (Scrooge — e.g. Claude Opus on',
    '    the web) for guidance. Your job is to gather context and prepare a',
    '    Treasure Map. Examples: "design a new caching layer", "refactor',
    '    the capture pipeline to be async", "I have no idea why this is',
    '    flaky".',
    '',
    '  - FOLLOW_INSTRUCTIONS: The user has pasted *prose instructions* back',
    '    from Scrooge — typically a phased plan with file references but',
    '    little or no literal code. Your job is to read the cited files and',
    '    translate the plan into surgical SEARCH/REPLACE edits. Signals:',
    '    very long prose, phase/step headings, references to specific files',
    '    or symbols, language like "implement the following" / "next, do X".',
    '    (Pasted *literal* code edits never reach you — those are auto-',
    '    applied before routing.)',
    '',
    'Output protocol — return ONE line of JSON, no prose, no fences:',
    '{"mode":"ANSWER|IMPLEMENT|ESCALATE|FOLLOW_INSTRUCTIONS","rationale":"<≤120 chars>"}'
].join('\n');

const VALID_MODES: ReadonlySet<Mode> = new Set<Mode>([
    'ANSWER', 'IMPLEMENT', 'ESCALATE', 'FOLLOW_INSTRUCTIONS'
]);

/**
 * Pure JSON-extractor. Tolerates surrounding whitespace, fenced blocks, and
 * leading prose. Falls back to ESCALATE on garbage so the user always gets
 * the maximum-effort response.
 */
export function parseModeDecision(rawText: string): ModeDecision {
    const fallback: ModeDecision = {
        mode: 'ESCALATE',
        rationale: 'router output unparseable; escalating by default'
    };
    if (!rawText) {
        return fallback;
    }
    // Strip code fences if the model added them anyway.
    const stripped = rawText
        .replace(/```(?:json)?\s*/gi, '')
        .replace(/```/g, '')
        .trim();

    // Find the first balanced { … } block.
    const start = stripped.indexOf('{');
    if (start < 0) {
        return fallback;
    }
    let depth = 0;
    let end = -1;
    for (let i = start; i < stripped.length; i++) {
        const c = stripped[i];
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) { end = i; break; }
        }
    }
    if (end < 0) {
        return fallback;
    }
    const candidate = stripped.slice(start, end + 1);
    let parsed: unknown;
    try {
        parsed = JSON.parse(candidate);
    } catch {
        return fallback;
    }
    if (!parsed || typeof parsed !== 'object') {
        return fallback;
    }
    const obj = parsed as Record<string, unknown>;
    const mode = typeof obj.mode === 'string' ? obj.mode.toUpperCase() : '';
    if (!VALID_MODES.has(mode as Mode)) {
        return fallback;
    }
    const rationale = typeof obj.rationale === 'string' ? obj.rationale.slice(0, 240) : '';
    return { mode: mode as Mode, rationale };
}

/**
 * Run a single short routing turn. The system prompt is tiny and we cap the
 * model output by *requesting* a one-line JSON response; we don't enforce
 * tokens because the API we're on doesn't expose that knob portably.
 */
export async function decideMode(
    model: vscode.LanguageModelChat,
    userPrompt: string,
    token: vscode.CancellationToken,
    history: vscode.LanguageModelChatMessage[] = []
): Promise<ModeDecision> {
    const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(ROUTER_SYSTEM_PROMPT),
        ...history,
        vscode.LanguageModelChatMessage.User(`User turn:\n${userPrompt}`)
    ];
    let raw = '';
    try {
        const response = await model.sendRequest(messages, {}, token);
        for await (const chunk of response.text) {
            raw += chunk;
            // Early exit once we've captured a balanced object — saves tokens.
            if (raw.includes('}') && raw.includes('{')) {
                const probe = parseModeDecision(raw);
                if (probe.rationale !== 'router output unparseable; escalating by default') {
                    return probe;
                }
            }
        }
    } catch {
        return { mode: 'ESCALATE', rationale: 'router LM call failed; escalating' };
    }
    return parseModeDecision(raw);
}
