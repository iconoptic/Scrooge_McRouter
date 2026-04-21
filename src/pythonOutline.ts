import * as vscode from 'vscode';

/**
 * Phase B — Python-aware structural outline.
 *
 * Given a list of workspace-relative `.py` paths, return a compact text
 * outline: imports + every top-level / nested class / def signature, each
 * paired with its immediately-following one-line docstring (if any).
 *
 * No AST dependency. Regex-only — outline-quality is "good enough for
 * Launchpad to point Scrooge at the right files", not "code generation".
 *
 * Pure helpers (`outlinePythonText`) are exported for unit testing without
 * touching the workspace.
 */

const SIG_RX = /^(\s*)(class|def|async\s+def)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\([^)]*\))?\s*(->[^:]+)?\s*:/;
const IMPORT_RX = /^\s*(from\s+[\w.]+\s+import\s+[^\n]+|import\s+[^\n]+)/;
const DOCSTRING_OPEN_RX = /^\s*(?:[rR]?[bB]?|[bB]?[rR]?)?("""|''')(.*)$/;

interface Signature {
    indent: number;
    line: number;       // 1-based
    text: string;       // full signature line, minus indent
    docstring?: string; // first line of the immediately-following docstring
}

/**
 * For each line, return whether the line *starts* inside an open triple-quoted
 * string literal. This lets us suppress false-positive `def` / `class` /
 * `import` matches inside module docstrings or string-embedded example code.
 *
 * The scanner walks each line character-by-character so it correctly skips
 * over single-line `'...'` / `"..."` strings (which may contain `#` or
 * triple-quote prefixes) and over `#` comments.
 */
export function scanTripleStringLines(lines: string[]): boolean[] {
    const inside = new Array<boolean>(lines.length).fill(false);
    let openQuote: '"""' | "'''" | null = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (openQuote) {
            inside[i] = true;
        }
        let pos = 0;
        while (pos < line.length) {
            if (openQuote) {
                const idx = line.indexOf(openQuote, pos);
                if (idx === -1) {
                    break;
                }
                pos = idx + 3;
                openQuote = null;
            } else {
                // Find the next triple-opener while skipping single-line
                // strings and `#` comments.
                let p = pos;
                let inSingle = false;
                let singleChar = '';
                let foundOpen = -1;
                let foundKind: '"""' | "'''" | null = null;
                while (p < line.length) {
                    const c = line[p];
                    if (inSingle) {
                        if (c === '\\') {
                            p += 2;
                            continue;
                        }
                        if (c === singleChar) {
                            inSingle = false;
                        }
                        p++;
                        continue;
                    }
                    if (c === '#') {
                        break;
                    }
                    if (line.startsWith('"""', p)) {
                        foundOpen = p;
                        foundKind = '"""';
                        break;
                    }
                    if (line.startsWith("'''", p)) {
                        foundOpen = p;
                        foundKind = "'''";
                        break;
                    }
                    if (c === '"' || c === "'") {
                        inSingle = true;
                        singleChar = c;
                        p++;
                        continue;
                    }
                    p++;
                }
                if (foundOpen === -1) {
                    break;
                }
                openQuote = foundKind!;
                pos = foundOpen + 3;
            }
        }
    }
    return inside;
}

/**
 * Pure function: extract structural outline from raw Python source text.
 */
export function outlinePythonText(source: string): {
    imports: string[];
    signatures: Signature[];
} {
    const lines = source.split(/\r?\n/);
    const insideString = scanTripleStringLines(lines);
    const imports: string[] = [];
    const signatures: Signature[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (insideString[i]) {
            continue;
        }

        const importMatch = line.match(IMPORT_RX);
        if (importMatch) {
            imports.push(importMatch[1].trim());
            continue;
        }

        const sigMatch = line.match(SIG_RX);
        if (sigMatch) {
            const indent = sigMatch[1].length;
            const text = line.slice(indent).trimEnd();

            // Look ahead for a docstring on the next non-blank line.
            let docstring: string | undefined;
            for (let j = i + 1; j < lines.length && j < i + 6; j++) {
                const nextStripped = lines[j].trim();
                if (nextStripped.length === 0) {
                    continue;
                }
                const docOpen = lines[j].match(DOCSTRING_OPEN_RX);
                if (docOpen) {
                    const quote = docOpen[1];
                    const after = docOpen[2];
                    // Single-line docstring: """foo"""
                    const singleLineEnd = after.indexOf(quote);
                    if (singleLineEnd >= 0) {
                        docstring = after.slice(0, singleLineEnd).trim();
                    } else {
                        // Multi-line — first content line is what we want.
                        if (after.trim().length > 0) {
                            docstring = after.trim();
                        } else if (j + 1 < lines.length) {
                            docstring = lines[j + 1].trim();
                        }
                    }
                }
                break;
            }

            signatures.push({
                indent,
                line: i + 1,
                text,
                docstring: docstring && docstring.length > 0 ? docstring : undefined
            });
        }
    }

    return { imports, signatures };
}

/**
 * Render an outline into the compact text format we feed to the LLM.
 */
export function renderPythonOutline(
    relPath: string,
    source: string,
    maxImports = 30,
    maxSignatures = 200
): string {
    const { imports, signatures } = outlinePythonText(source);
    const parts: string[] = [];
    parts.push(`===== ${relPath} =====`);

    if (imports.length > 0) {
        const shown = imports.slice(0, maxImports);
        parts.push(`imports (${imports.length}):`);
        for (const imp of shown) {
            parts.push(`  ${imp}`);
        }
        if (imports.length > maxImports) {
            parts.push(`  … (${imports.length - maxImports} more)`);
        }
    }

    if (signatures.length === 0) {
        parts.push('(no class/def signatures found)');
    } else {
        const shown = signatures.slice(0, maxSignatures);
        for (const sig of shown) {
            const pad = ' '.repeat(Math.min(sig.indent, 12));
            const head = `${pad}L${sig.line}: ${sig.text}`;
            parts.push(head);
            if (sig.docstring) {
                const oneLine = sig.docstring.length > 120
                    ? sig.docstring.slice(0, 117) + '…'
                    : sig.docstring;
                parts.push(`${pad}    """${oneLine}"""`);
            }
        }
        if (signatures.length > maxSignatures) {
            parts.push(`(… ${signatures.length - maxSignatures} more signatures truncated)`);
        }
    }

    return parts.join('\n');
}

/**
 * Workspace-aware tool entry point. Reads the named `.py` files and returns
 * concatenated outlines. Non-Python files are reported inline so Launchpad
 * can react.
 */
export async function pythonOutline(paths: string[]): Promise<string> {
    if (!paths || paths.length === 0) {
        return '(no file paths provided)';
    }
    const root = vscode.workspace.workspaceFolders?.[0];
    if (!root) {
        return '(no workspace folder is open)';
    }

    const sections: string[] = [];
    for (const raw of paths) {
        const cleaned = raw.replace(/^[`"']|[`"']$/g, '').trim();
        if (!cleaned.toLowerCase().endsWith('.py')) {
            sections.push(`===== ${cleaned} =====\n(skipped: not a .py file)`);
            continue;
        }

        const uri = cleaned.startsWith('/') || /^[A-Za-z]:[\\/]/.test(cleaned)
            ? vscode.Uri.file(cleaned)
            : vscode.Uri.joinPath(root.uri, ...cleaned.split(/[\\/]/));

        let bytes: Uint8Array;
        try {
            bytes = await vscode.workspace.fs.readFile(uri);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            sections.push(`===== ${cleaned} =====\n(error reading file: ${msg})`);
            continue;
        }

        const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        sections.push(renderPythonOutline(cleaned, text));
    }

    return sections.join('\n\n');
}
