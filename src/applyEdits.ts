import * as vscode from 'vscode';
import { recordSnapshot } from './snapshots';

/**
 * Phase 4 — Clipboard "Commander" Loop
 *
 * Parses code-modification instructions out of pasted chat text and applies
 * them via `vscode.WorkspaceEdit`. Files are intentionally left DIRTY so
 * the user can review native diffs in the editor before saving.
 *
 * Two input formats are supported (mix-and-match in a single paste OK):
 *
 *   1. FULL-FILE / NEW-FILE  ── replace the whole file (or create it):
 *
 *        File: src/foo.ts
 *        ```ts
 *        // entire new file contents
 *        ```
 *
 *      `File:`, `Path:`, or `### path/to/file` are all accepted as the
 *      header. The fence language tag is optional.
 *
 *   2. SEARCH / REPLACE  ── targeted edit. Header still names the file,
 *      then one or more blocks of the form:
 *
 *        <<<<<<< SEARCH
 *        existing exact text
 *        =======
 *        replacement text
 *        >>>>>>> REPLACE
 *
 *      The "<<<", "===", ">>>" markers tolerate any number of repeated
 *      angle/equals chars (>= 3).
 */

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface ApplyOutcome {
    appliedFiles: string[];
    createdFiles: string[];
    failures: { path: string; reason: string }[];
    parsedBlocks: number;
    /** Per-file URIs for chat-side rendering (anchors, diff buttons). */
    fileUris: Map<string, vscode.Uri>;
    /** Pre-edit snapshot URIs (scrooge-pre://) for the diff button. */
    snapshotUris: Map<string, vscode.Uri>;
    /** Files that were saved to disk after applying. */
    savedFiles: string[];
}

/**
 * Parse `pasted` and apply every edit it describes to the workspace.
 * Returns a structured outcome the caller can render to chat.
 */
export async function applyCommanderPaste(pasted: string): Promise<ApplyOutcome> {
    const blocks = parseCommanderText(pasted);
    const outcome: ApplyOutcome = {
        appliedFiles: [],
        createdFiles: [],
        failures: [],
        parsedBlocks: blocks.length,
        fileUris: new Map(),
        snapshotUris: new Map(),
        savedFiles: []
    };

    if (blocks.length === 0) {
        return outcome;
    }

    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
        for (const b of blocks) {
            outcome.failures.push({ path: b.path, reason: 'no workspace folder is open' });
        }
        return outcome;
    }

    const autoSave = vscode.workspace
        .getConfiguration('scroogeMcRouter')
        .get<boolean>('autoSaveAfterDeposit', true);

    // Group by file so all edits to one file land in a single WorkspaceEdit
    // operation (cleaner undo, fewer dirty-state flickers).
    const byPath = new Map<string, ParsedBlock[]>();
    for (const b of blocks) {
        const list = byPath.get(b.path) ?? [];
        list.push(b);
        byPath.set(b.path, list);
    }

    for (const [relPath, fileBlocks] of byPath) {
        const uri = resolveTarget(relPath, root);
        try {
            const result = await applyToFile(uri, fileBlocks);
            outcome.fileUris.set(relPath, uri);
            if (result.preSnapshotUri) {
                outcome.snapshotUris.set(relPath, result.preSnapshotUri);
            }
            if (result.created) {
                outcome.createdFiles.push(relPath);
            } else {
                outcome.appliedFiles.push(relPath);
            }
            if (autoSave) {
                try {
                    const doc = await vscode.workspace.openTextDocument(uri);
                    if (doc.isDirty) {
                        const saved = await doc.save();
                        if (saved) {
                            outcome.savedFiles.push(relPath);
                        }
                    } else {
                        // Already on disk (createFile + insert may have flushed).
                        outcome.savedFiles.push(relPath);
                    }
                } catch {
                    // Save failure is non-fatal; the edit is already applied.
                }
            }
        } catch (err) {
            outcome.failures.push({
                path: relPath,
                reason: err instanceof Error ? err.message : String(err)
            });
        }
    }

    return outcome;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type EditKind =
    | { kind: 'fullFile'; content: string }
    | { kind: 'searchReplace'; search: string; replace: string };

export interface ParsedBlock {
    path: string;
    edit: EditKind;
}

const HEADER_PATTERNS: RegExp[] = [
    // "File: path", "Path: path", "FILE: path" — most common
    /^\s*(?:file|path)\s*[:=]\s*[`"']?([^\s`"'<>][^\n`"']*?)[`"']?\s*$/i,
    // "### path/to/file.ts" or "## path"
    /^\s*#{1,6}\s+([^\s#][^\n]*\.[A-Za-z0-9]+)\s*$/,
    // bare backticked path on a line by itself
    /^\s*`([^`\n]+\.[A-Za-z0-9]+)`\s*$/
];

function tryParseHeader(line: string): string | undefined {
    for (const rx of HEADER_PATTERNS) {
        const m = line.match(rx);
        if (m) {
            return m[1].trim();
        }
    }
    return undefined;
}

const FENCE_RX = /^([`~]{3,})([^\n]*)$/;
const SEARCH_OPEN_RX = /^<{3,}\s*SEARCH\s*$/i;
const DIVIDER_RX = /^={3,}\s*$/;
const REPLACE_CLOSE_RX = /^>{3,}\s*REPLACE\s*$/i;

/**
 * Tokenize the pasted text into a flat list of `ParsedBlock`s.
 * A header line "binds" subsequent fenced blocks / SEARCH-REPLACE blocks
 * until a new header appears.
 */
export function parseCommanderText(text: string): ParsedBlock[] {
    const lines = text.split(/\r?\n/);
    const blocks: ParsedBlock[] = [];
    let currentPath: string | undefined;

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        // 1. Header?
        const header = tryParseHeader(line);
        if (header) {
            currentPath = header;
            i++;
            continue;
        }

        // 2. Fenced code block?
        const fenceMatch = line.match(FENCE_RX);
        if (fenceMatch) {
            const fence = fenceMatch[1];
            const bodyStart = i + 1;
            let j = bodyStart;
            while (j < lines.length && !lines[j].startsWith(fence)) {
                j++;
            }
            const body = lines.slice(bodyStart, j).join('\n');
            i = j < lines.length ? j + 1 : j;

            if (!currentPath) {
                // No file association → ignore. Could be commentary.
                continue;
            }

            // Within a fence we may have SEARCH/REPLACE blocks; otherwise the
            // fence body is a full-file replacement.
            const srBlocks = extractSearchReplace(body);
            if (srBlocks.length > 0) {
                for (const sr of srBlocks) {
                    blocks.push({ path: currentPath, edit: sr });
                }
            } else {
                blocks.push({
                    path: currentPath,
                    edit: { kind: 'fullFile', content: body }
                });
            }
            continue;
        }

        // 3. Bare SEARCH/REPLACE (no surrounding fence)?
        if (SEARCH_OPEN_RX.test(line) && currentPath) {
            const consumed = consumeSearchReplace(lines, i);
            if (consumed) {
                blocks.push({ path: currentPath, edit: consumed.edit });
                i = consumed.nextIndex;
                continue;
            }
        }

        i++;
    }

    return blocks;
}

function extractSearchReplace(body: string): EditKind[] {
    const lines = body.split('\n');
    const out: EditKind[] = [];
    let i = 0;
    while (i < lines.length) {
        if (SEARCH_OPEN_RX.test(lines[i])) {
            const consumed = consumeSearchReplace(lines, i);
            if (consumed) {
                out.push(consumed.edit);
                i = consumed.nextIndex;
                continue;
            }
        }
        i++;
    }
    return out;
}

function consumeSearchReplace(
    lines: string[],
    startIdx: number
): { edit: Extract<EditKind, { kind: 'searchReplace' }>; nextIndex: number } | undefined {
    // startIdx points at the SEARCH opener.
    let i = startIdx + 1;
    const searchLines: string[] = [];
    while (i < lines.length && !DIVIDER_RX.test(lines[i])) {
        if (REPLACE_CLOSE_RX.test(lines[i])) {
            return undefined; // malformed: closer before divider
        }
        searchLines.push(lines[i]);
        i++;
    }
    if (i >= lines.length) {
        return undefined;
    }
    i++; // skip divider
    const replaceLines: string[] = [];
    while (i < lines.length && !REPLACE_CLOSE_RX.test(lines[i])) {
        replaceLines.push(lines[i]);
        i++;
    }
    if (i >= lines.length) {
        return undefined;
    }
    return {
        edit: {
            kind: 'searchReplace',
            search: searchLines.join('\n'),
            replace: replaceLines.join('\n')
        },
        nextIndex: i + 1
    };
}

// ---------------------------------------------------------------------------
// Path resolution & application
// ---------------------------------------------------------------------------

function resolveTarget(raw: string, root: vscode.WorkspaceFolder): vscode.Uri {
    const cleaned = raw.replace(/^[`"']|[`"']$/g, '').trim();
    if (cleaned.startsWith('/') || /^[A-Za-z]:[\\/]/.test(cleaned)) {
        return vscode.Uri.file(cleaned);
    }
    return vscode.Uri.joinPath(root.uri, ...cleaned.split(/[\\/]/));
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

async function applyToFile(
    uri: vscode.Uri,
    blocks: ParsedBlock[]
): Promise<{ created: boolean; preSnapshotUri?: vscode.Uri }> {
    const exists = await fileExists(uri);
    const edit = new vscode.WorkspaceEdit();

    // If any block is a fullFile and the file doesn't exist yet → create it.
    // If multiple blocks target a non-existent file, only fullFile makes sense.
    if (!exists) {
        const fullFileBlock = blocks.find(b => b.edit.kind === 'fullFile');
        if (!fullFileBlock || fullFileBlock.edit.kind !== 'fullFile') {
            throw new Error(
                `target does not exist and no full-file content was provided: ${uri.fsPath}`
            );
        }
        edit.createFile(uri, { ignoreIfExists: false, overwrite: false });
        edit.insert(uri, new vscode.Position(0, 0), fullFileBlock.edit.content);
        const ok = await vscode.workspace.applyEdit(edit);
        if (!ok) {
            throw new Error('vscode.workspace.applyEdit() returned false');
        }
        return { created: true };
    }

    // File exists: open it as a TextDocument so we can compute ranges and so
    // the edit lands in the editor's dirty buffer (not just on disk).
    const doc = await vscode.workspace.openTextDocument(uri);
    // Snapshot BEFORE applying so the diff button can show what changed.
    const preText = doc.getText();
    const preSnapshotUri = recordSnapshot(uri, preText);

    for (const block of blocks) {
        if (block.edit.kind === 'fullFile') {
            const fullRange = new vscode.Range(
                new vscode.Position(0, 0),
                doc.lineAt(doc.lineCount - 1).range.end
            );
            edit.replace(uri, fullRange, block.edit.kind === 'fullFile' ? block.edit.content : '');
        } else {
            const range = findSearchRange(doc, block.edit.search);
            if (!range) {
                throw new Error(
                    `SEARCH text not found in ${vscode.workspace.asRelativePath(uri)}: ` +
                    JSON.stringify(block.edit.search.slice(0, 80)) +
                    (block.edit.search.length > 80 ? '…' : '')
                );
            }
            edit.replace(uri, range, block.edit.replace);
        }
    }

    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
        throw new Error('vscode.workspace.applyEdit() returned false');
    }
    return { created: false, preSnapshotUri };
}

/**
 * Find a contiguous occurrence of `needle` in `doc`. First tries an exact
 * match; if that fails, retries with each line right-trimmed (tolerates
 * trailing-whitespace drift introduced by chat copy/paste). Returns the
 * range of the matched substring, or undefined.
 */
function findSearchRange(doc: vscode.TextDocument, needle: string): vscode.Range | undefined {
    const haystack = doc.getText();

    let idx = haystack.indexOf(needle);
    if (idx < 0) {
        const normalized = needle.replace(/[ \t]+$/gm, '');
        const haystackNorm = haystack.replace(/[ \t]+$/gm, '');
        const idxNorm = haystackNorm.indexOf(normalized);
        if (idxNorm < 0) {
            return undefined;
        }
        // Map normalized index back to original by character offset (the
        // normalization only removes characters, never inserts, so original
        // offset >= normalized offset). Walk forward until we've consumed
        // `idxNorm` non-trailing-whitespace chars.
        let origPos = 0;
        let normPos = 0;
        const isStripped = (i: number): boolean => {
            // True when haystack[i] is trailing whitespace that was stripped.
            if (haystack[i] !== ' ' && haystack[i] !== '\t') {
                return false;
            }
            let j = i;
            while (j < haystack.length && (haystack[j] === ' ' || haystack[j] === '\t')) {
                j++;
            }
            return j === haystack.length || haystack[j] === '\n' || haystack[j] === '\r';
        };
        while (origPos < haystack.length && normPos < idxNorm) {
            if (!isStripped(origPos)) {
                normPos++;
            }
            origPos++;
        }
        idx = origPos;
        // Match length: walk forward `normalized.length` non-stripped chars.
        let endOrig = idx;
        let consumed = 0;
        while (endOrig < haystack.length && consumed < normalized.length) {
            if (!isStripped(endOrig)) {
                consumed++;
            }
            endOrig++;
        }
        return new vscode.Range(doc.positionAt(idx), doc.positionAt(endOrig));
    }

    return new vscode.Range(doc.positionAt(idx), doc.positionAt(idx + needle.length));
}

// ---------------------------------------------------------------------------
// Chat-side renderer
// ---------------------------------------------------------------------------

export function renderApplyOutcome(
    stream: vscode.ChatResponseStream,
    outcome: ApplyOutcome
): void {
    if (outcome.parsedBlocks === 0) {
        stream.markdown(
            '⚠️ Empty deposit slip — no file edits found in the pasted text.\n\n' +
            'Expected a `File: path/to/file.ext` header followed by either a fenced code block ' +
            '(full-file replacement) or one or more `<<<<<<< SEARCH … ======= … >>>>>>> REPLACE` blocks.'
        );
        return;
    }

    const renderFile = (path: string, kind: 'edited' | 'created'): void => {
        const uri = outcome.fileUris.get(path);
        if (!uri) {
            stream.markdown(`- \`${path}\`\n`);
            return;
        }
        stream.markdown('- ');
        stream.anchor(uri, path);
        if (kind === 'edited') {
            const preUri = outcome.snapshotUris.get(path);
            if (preUri) {
                stream.button({
                    command: 'vscode.diff',
                    title: 'Diff',
                    arguments: [preUri, uri, `${path} ← before deposit`]
                });
            }
        }
        stream.markdown('\n');
    };

    if (outcome.appliedFiles.length > 0) {
        stream.markdown(
            `💰 Deposited edits to ${outcome.appliedFiles.length} file${outcome.appliedFiles.length === 1 ? '' : 's'}:\n`
        );
        for (const p of outcome.appliedFiles) {
            renderFile(p, 'edited');
        }
    }
    if (outcome.createdFiles.length > 0) {
        stream.markdown('\n');
        stream.markdown(
            `🪙 Minted ${outcome.createdFiles.length} new file${outcome.createdFiles.length === 1 ? '' : 's'}:\n`
        );
        for (const p of outcome.createdFiles) {
            renderFile(p, 'created');
        }
    }
    if (outcome.failures.length > 0) {
        stream.markdown('\n');
        stream.markdown(
            `🦆 ${outcome.failures.length} bounced edit${outcome.failures.length === 1 ? '' : 's'}:\n`
        );
        for (const f of outcome.failures) {
            stream.markdown(`- \`${f.path}\` — ${f.reason}\n`);
        }
    }

    const touched = outcome.appliedFiles.length + outcome.createdFiles.length;
    const savedAll = touched > 0 && outcome.savedFiles.length === touched;
    stream.markdown('\n');
    if (savedAll) {
        stream.markdown(
            `_All ${outcome.savedFiles.length} file${outcome.savedFiles.length === 1 ? '' : 's'} ` +
            `saved to disk. Use the **Diff** buttons to review, or \`Ctrl/Cmd+Z\` in the editor to undo._`
        );
    } else if (outcome.savedFiles.length > 0) {
        stream.markdown(
            `_${outcome.savedFiles.length} of ${touched} file(s) saved; the rest are dirty in the vault. ` +
            `Press \`Ctrl/Cmd+S\` to save or \`Ctrl/Cmd+Z\` to revert._`
        );
    } else {
        stream.markdown(
            '_Files left **unsaved** in the vault for your inspection. ' +
            'Press `Ctrl/Cmd+S` to lock the vault, or `Ctrl/Cmd+Z` to throw it back in the moat._'
        );
    }
}
