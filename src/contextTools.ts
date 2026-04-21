import * as vscode from 'vscode';

/**
 * Phase 2 — Context Gathering Tools
 *
 * Native VS Code API only. Each tool returns a token-efficient string
 * suitable for splicing directly into an LLM context window.
 *
 * NOTE on text search: `vscode.workspace.findTextInFiles` is a *proposed*
 * API (not available in stable extensions without `enabledApiProposals`).
 * To stay on the stable surface, `searchWorkspace` performs the search
 * manually with `findFiles` + `fs.readFile` + a streaming regex scan.
 * The signature/output match what a Scout agent would expect.
 */

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/** Glob fragments excluded from every workspace traversal. */
const EXCLUDE_DIRS = [
    'node_modules',
    '.git',
    'dist',
    'out',
    'build',
    '.next',
    '.nuxt',
    '.svelte-kit',
    '.turbo',
    '.cache',
    '.venv',
    'venv',
    '__pycache__',
    '.pytest_cache',
    '.mypy_cache',
    '.tox',
    'target',          // Rust / Java
    'bin',
    'obj',             // .NET
    'coverage',
    '.nyc_output',
    '.idea',
    '.vscode-test',
    '.deprecated'
];

/** Single glob pattern usable as the `exclude` arg to `findFiles`. */
const EXCLUDE_GLOB = `**/{${EXCLUDE_DIRS.join(',')}}/**`;

/** Hard ceilings to keep token usage bounded. */
const LIMITS = {
    repoMapFiles: 2000,
    searchMatches: 100,
    searchFilesScanned: 1500,
    readMaxBytesPerFile: 256 * 1024, // 256 KB
    readMaxTotalBytes: 1024 * 1024   // 1 MB across all requested files
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getWorkspaceRoot(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
}

function relPath(uri: vscode.Uri, root?: vscode.WorkspaceFolder): string {
    return root ? vscode.workspace.asRelativePath(uri, false) : uri.fsPath;
}

/** Crude binary sniff: any NUL byte in the first 8 KB → treat as binary. */
function looksBinary(bytes: Uint8Array): boolean {
    const n = Math.min(bytes.length, 8192);
    for (let i = 0; i < n; i++) {
        if (bytes[i] === 0) {
            return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// 1. generateRepoMap
// ---------------------------------------------------------------------------

/**
 * Build a hierarchical text representation of the workspace file tree,
 * skipping noisy build / dependency directories.
 *
 * @param maxFiles Optional override for the file cap (default: 2000).
 */
export async function generateRepoMap(maxFiles: number = LIMITS.repoMapFiles): Promise<string> {
    const root = getWorkspaceRoot();
    if (!root) {
        return '(no workspace folder is open)';
    }

    const uris = await vscode.workspace.findFiles('**/*', EXCLUDE_GLOB, maxFiles);
    if (uris.length === 0) {
        return `(workspace "${root.name}" contains no indexable files)`;
    }

    const truncated = uris.length >= maxFiles;

    // Build a nested tree. Each node maps name → child node (files have no children).
    type Node = Map<string, Node>;
    const tree: Node = new Map();

    const sortedPaths = uris
        .map(u => relPath(u, root))
        .sort((a, b) => a.localeCompare(b));

    for (const p of sortedPaths) {
        const parts = p.split(/[\\/]/);
        let cursor = tree;
        for (const part of parts) {
            let next = cursor.get(part);
            if (!next) {
                next = new Map();
                cursor.set(part, next);
            }
            cursor = next;
        }
    }

    const lines: string[] = [`${root.name}/`];
    const render = (node: Node, prefix: string): void => {
        const entries = [...node.entries()];
        entries.forEach(([name, child], idx) => {
            const last = idx === entries.length - 1;
            const branch = last ? '└── ' : '├── ';
            const isDir = child.size > 0;
            lines.push(`${prefix}${branch}${name}${isDir ? '/' : ''}`);
            if (isDir) {
                render(child, prefix + (last ? '    ' : '│   '));
            }
        });
    };
    render(tree, '');

    if (truncated) {
        lines.push('', `… (truncated at ${maxFiles} files)`);
    }
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 2. searchWorkspace
// ---------------------------------------------------------------------------

export interface SearchOptions {
    /** Treat `query` as a regex. Default: false (literal substring). */
    isRegex?: boolean;
    /** Case-sensitive match. Default: false. */
    caseSensitive?: boolean;
    /** Include glob (relative to workspace). Default: all files. */
    include?: string;
    /** Maximum number of matches to return. Default: 100. */
    maxMatches?: number;
}

/**
 * Search the workspace for `query`. Returns a formatted multi-line string:
 *
 *     path/to/file.ts:42: const foo = bar();
 *     path/to/file.ts:87:   foo.baz();
 *     other/file.py:3: foo = 1
 *
 * Plus a trailing summary line.
 */
export async function searchWorkspace(query: string, options: SearchOptions = {}): Promise<string> {
    if (!query || query.length === 0) {
        return '(empty search query)';
    }
    if (!getWorkspaceRoot()) {
        return '(no workspace folder is open)';
    }

    const {
        isRegex = false,
        caseSensitive = false,
        include = '**/*',
        maxMatches = LIMITS.searchMatches
    } = options;

    let pattern: RegExp;
    try {
        const source = isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        pattern = new RegExp(source, caseSensitive ? 'g' : 'gi');
    } catch (err) {
        return `(invalid regex: ${(err as Error).message})`;
    }

    const files = await vscode.workspace.findFiles(include, EXCLUDE_GLOB, LIMITS.searchFilesScanned);

    const out: string[] = [];
    let matchCount = 0;
    let filesWithMatches = 0;
    let truncated = false;

    outer: for (const uri of files) {
        let bytes: Uint8Array;
        try {
            bytes = await vscode.workspace.fs.readFile(uri);
        } catch {
            continue; // unreadable / permission denied
        }
        if (looksBinary(bytes)) {
            continue;
        }

        const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        const lines = text.split(/\r?\n/);
        const rel = relPath(uri);
        let fileHadMatch = false;

        for (let i = 0; i < lines.length; i++) {
            // Reset stateful regex between lines.
            pattern.lastIndex = 0;
            if (pattern.test(lines[i])) {
                const trimmed = lines[i].length > 240 ? lines[i].slice(0, 237) + '…' : lines[i];
                out.push(`${rel}:${i + 1}: ${trimmed}`);
                matchCount++;
                fileHadMatch = true;
                if (matchCount >= maxMatches) {
                    truncated = true;
                    break outer;
                }
            }
        }
        if (fileHadMatch) {
            filesWithMatches++;
        }
    }

    if (out.length === 0) {
        return `(no matches for ${isRegex ? 'regex' : 'query'} ${JSON.stringify(query)})`;
    }

    const summary = truncated
        ? `\n--- ${matchCount} matches in ${filesWithMatches} files (truncated at ${maxMatches}) ---`
        : `\n--- ${matchCount} matches in ${filesWithMatches} files ---`;
    return out.join('\n') + summary;
}

// ---------------------------------------------------------------------------
// 3. readWorkspaceFiles
// ---------------------------------------------------------------------------

/**
 * Read the text contents of one or more files. Paths may be:
 *   - workspace-relative (e.g. `src/extension.ts`), or
 *   - absolute file system paths.
 *
 * Output format (per file):
 *
 *     ===== src/extension.ts =====
 *     <contents…>
 *
 * Errors per file (missing, binary, oversize) are reported inline so the
 * model can react without the whole call failing.
 */
export async function readWorkspaceFiles(paths: string[]): Promise<string> {
    if (!paths || paths.length === 0) {
        return '(no file paths provided)';
    }
    const root = getWorkspaceRoot();
    const sections: string[] = [];
    let totalBytes = 0;

    for (const raw of paths) {
        const header = `===== ${raw} =====`;
        const uri = resolvePath(raw, root);
        if (!uri) {
            sections.push(`${header}\n(error: cannot resolve path; no workspace open)`);
            continue;
        }

        let bytes: Uint8Array;
        try {
            bytes = await vscode.workspace.fs.readFile(uri);
        } catch (err) {
            const msg = err instanceof vscode.FileSystemError ? err.code : (err as Error).message;
            sections.push(`${header}\n(error reading file: ${msg})`);
            continue;
        }

        if (looksBinary(bytes)) {
            sections.push(`${header}\n(skipped: binary file, ${bytes.length} bytes)`);
            continue;
        }

        let truncatedNote = '';
        let slice = bytes;
        if (bytes.length > LIMITS.readMaxBytesPerFile) {
            slice = bytes.subarray(0, LIMITS.readMaxBytesPerFile);
            truncatedNote = `\n(… truncated: file is ${bytes.length} bytes, showing first ${LIMITS.readMaxBytesPerFile})`;
        }

        if (totalBytes + slice.length > LIMITS.readMaxTotalBytes) {
            sections.push(`${header}\n(skipped: total read budget of ${LIMITS.readMaxTotalBytes} bytes exhausted)`);
            continue;
        }
        totalBytes += slice.length;

        const text = new TextDecoder('utf-8', { fatal: false }).decode(slice);
        sections.push(`${header}\n${text}${truncatedNote}`);
    }

    return sections.join('\n\n');
}

function resolvePath(raw: string, root: vscode.WorkspaceFolder | undefined): vscode.Uri | undefined {
    // Absolute path (POSIX or Windows).
    if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) {
        return vscode.Uri.file(raw);
    }
    // URI form (file://..., vscode-userdata://..., etc.).
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
        try {
            return vscode.Uri.parse(raw);
        } catch {
            return undefined;
        }
    }
    if (!root) {
        return undefined;
    }
    return vscode.Uri.joinPath(root.uri, ...raw.split(/[\\/]/));
}

// ---------------------------------------------------------------------------
// 4. readSlices — line-range slices instead of whole files
// ---------------------------------------------------------------------------

export interface SliceSpec {
    path: string;
    startLine: number; // 1-based, inclusive
    endLine: number;   // 1-based, inclusive
}

/**
 * Read explicit line ranges from one or more files. Output:
 *
 *     ===== src/foo.py:L42-L80 =====
 *     <line 42>
 *     …
 *     <line 80>
 *
 * Errors per slice are reported inline.
 */
export async function readSlices(slices: SliceSpec[]): Promise<string> {
    if (!slices || slices.length === 0) {
        return '(no slices provided)';
    }
    const root = getWorkspaceRoot();
    const sections: string[] = [];
    let totalBytes = 0;

    for (const spec of slices) {
        const header = `===== ${spec.path}:L${spec.startLine}-L${spec.endLine} =====`;
        const uri = resolvePath(spec.path, root);
        if (!uri) {
            sections.push(`${header}\n(error: cannot resolve path; no workspace open)`);
            continue;
        }

        let bytes: Uint8Array;
        try {
            bytes = await vscode.workspace.fs.readFile(uri);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            sections.push(`${header}\n(error reading file: ${msg})`);
            continue;
        }
        if (looksBinary(bytes)) {
            sections.push(`${header}\n(skipped: binary file)`);
            continue;
        }

        const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        const lines = text.split(/\r?\n/);
        const start = Math.max(1, Math.min(spec.startLine, lines.length));
        const end = Math.max(start, Math.min(spec.endLine, lines.length));
        const slice = lines.slice(start - 1, end).join('\n');

        if (totalBytes + slice.length > LIMITS.readMaxTotalBytes) {
            sections.push(`${header}\n(skipped: total slice budget exhausted)`);
            continue;
        }
        totalBytes += slice.length;
        sections.push(`${header}\n${slice}`);
    }

    return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// 5. partialTree — file tree restricted to specific subdirectories
// ---------------------------------------------------------------------------

/**
 * Render a file tree limited to one or more workspace-relative root
 * directories. Useful when Launchpad has narrowed the territory and only
 * needs to show Scrooge the relevant subtree (instead of the whole repo).
 */
export async function partialTree(
    roots: string[],
    maxDepth: number = 3,
    maxFiles: number = LIMITS.repoMapFiles
): Promise<string> {
    const wsRoot = getWorkspaceRoot();
    if (!wsRoot) {
        return '(no workspace folder is open)';
    }
    if (!roots || roots.length === 0) {
        return '(no subtree roots provided)';
    }

    const allLines: string[] = [];
    let totalFiles = 0;

    for (const r of roots) {
        if (totalFiles >= maxFiles) {
            allLines.push(`… (truncated at ${maxFiles} total files)`);
            break;
        }
        const cleaned = r.replace(/^[`"']|[`"']$/g, '').replace(/^\/+|\/+$/g, '').trim();
        if (cleaned.length === 0 || cleaned === '.') {
            // Treat as full tree (degenerate case) — let caller use generateRepoMap.
            continue;
        }

        // Glob: include only files within `cleaned/` whose relative-to-root
        // depth <= maxDepth.
        const include = `${cleaned}/**/*`;
        const remaining = maxFiles - totalFiles;
        const uris = await vscode.workspace.findFiles(include, EXCLUDE_GLOB, remaining);

        // Filter by depth (depth = number of path separators *below* the root).
        const accepted: string[] = [];
        for (const u of uris) {
            const rel = relPath(u, wsRoot);
            const tail = rel.startsWith(cleaned + '/') ? rel.slice(cleaned.length + 1) : rel;
            const depth = tail.split('/').length; // 1 for direct children
            if (depth <= maxDepth) {
                accepted.push(rel);
            }
        }
        accepted.sort((a, b) => a.localeCompare(b));
        totalFiles += accepted.length;

        // Build the same nested tree structure used by generateRepoMap.
        type Node = Map<string, Node>;
        const tree: Node = new Map();
        for (const p of accepted) {
            const parts = p.split('/');
            let cursor = tree;
            for (const part of parts) {
                let next = cursor.get(part);
                if (!next) {
                    next = new Map();
                    cursor.set(part, next);
                }
                cursor = next;
            }
        }

        if (accepted.length === 0) {
            allLines.push(`${cleaned}/  (no files within depth ${maxDepth})`);
            continue;
        }

        const lines: string[] = [`${cleaned}/`];
        const render = (node: Node, prefix: string): void => {
            const entries = [...node.entries()];
            // Skip the prefix-path entries down to `cleaned`'s contents.
            entries.forEach(([name, child], idx) => {
                const last = idx === entries.length - 1;
                const branch = last ? '└── ' : '├── ';
                const isDir = child.size > 0;
                lines.push(`${prefix}${branch}${name}${isDir ? '/' : ''}`);
                if (isDir) {
                    render(child, prefix + (last ? '    ' : '│   '));
                }
            });
        };
        // Walk into the cleaned-prefix node so we render only the subtree.
        const segs = cleaned.split('/');
        let sub: Node | undefined = tree;
        for (const s of segs) {
            sub = sub?.get(s);
            if (!sub) break;
        }
        if (sub) {
            render(sub, '');
        }
        allLines.push(...lines);
        allLines.push('');
    }

    if (allLines.length === 0) {
        return '(no matching files in the requested subtrees)';
    }
    return allLines.join('\n').trimEnd();
}
