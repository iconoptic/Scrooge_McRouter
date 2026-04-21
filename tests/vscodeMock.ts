/**
 * Lightweight stub of the `vscode` module sufficient to load and exercise
 * the parts of our extension that depend on it from a plain Node process.
 *
 * We register this stub into Node's module cache under the key `vscode`
 * BEFORE any production source file is `require()`d. See `tests/_setup.ts`.
 *
 * Sinon spies are exposed via `vscodeMock.workspace.findFiles` etc., so
 * tests can `.callsFake(...)` and `.resetHistory()` on them.
 */

import * as path from 'path';
import * as sinon from 'sinon';

// --- Uri ----------------------------------------------------------------

class Uri {
    static file(fsPath: string): Uri {
        return new Uri('file', '', fsPath, '', '');
    }
    static parse(value: string): Uri {
        const m = value.match(/^([a-z][a-z0-9+.-]*):\/\/([^/]*)(\/[^?#]*)?/i);
        if (!m) {
            throw new Error(`Cannot parse URI: ${value}`);
        }
        return new Uri(m[1], m[2] ?? '', m[3] ?? '', '', '');
    }
    static joinPath(base: Uri, ...segments: string[]): Uri {
        const joined = path.posix.join(base.path, ...segments);
        return new Uri(base.scheme, base.authority, joined, base.query, base.fragment);
    }
    static from(parts: { scheme: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
        return new Uri(parts.scheme, parts.authority ?? '', parts.path ?? '', parts.query ?? '', parts.fragment ?? '');
    }
    constructor(
        public readonly scheme: string,
        public readonly authority: string,
        public readonly path: string,
        public readonly query: string,
        public readonly fragment: string
    ) {}
    get fsPath(): string { return this.path; }
    toString(): string { return `${this.scheme}://${this.authority}${this.path}`; }
}

// --- Position / Range ---------------------------------------------------

class Position {
    constructor(public readonly line: number, public readonly character: number) {}
}
class Range {
    constructor(public readonly start: Position, public readonly end: Position) {}
}

// --- FileSystemError ----------------------------------------------------

class FileSystemError extends Error {
    constructor(message: string, public readonly code: string) {
        super(message);
    }
    static FileNotFound(uri?: Uri): FileSystemError {
        return new FileSystemError(`FileNotFound: ${uri?.fsPath ?? ''}`, 'FileNotFound');
    }
}

// --- Language model parts (minimal classes for instanceof checks) -------

class LanguageModelTextPart {
    constructor(public readonly value: string) {}
}
class LanguageModelToolCallPart {
    constructor(
        public readonly callId: string,
        public readonly name: string,
        public readonly input: unknown
    ) {}
}
class LanguageModelToolResultPart {
    constructor(
        public readonly callId: string,
        public readonly content: unknown[]
    ) {}
}
class LanguageModelToolResult {
    constructor(public readonly content: unknown[]) {}
}

class LanguageModelChatMessage {
    constructor(public readonly role: string, public readonly content: unknown) {}
    static User(content: unknown): LanguageModelChatMessage {
        return new LanguageModelChatMessage('user', content);
    }
    static Assistant(content: unknown): LanguageModelChatMessage {
        return new LanguageModelChatMessage('assistant', content);
    }
}

class LanguageModelError extends Error {
    constructor(message: string, public readonly code: string) {
        super(message);
    }
}

// --- WorkspaceEdit ------------------------------------------------------

interface RecordedEdit {
    op: 'replace' | 'insert' | 'createFile' | 'deleteFile';
    uri: Uri;
    range?: Range;
    position?: Position;
    text?: string;
    options?: unknown;
}
class WorkspaceEdit {
    public readonly edits: RecordedEdit[] = [];
    replace(uri: Uri, range: Range, text: string): void {
        this.edits.push({ op: 'replace', uri, range, text });
    }
    insert(uri: Uri, position: Position, text: string): void {
        this.edits.push({ op: 'insert', uri, position, text });
    }
    createFile(uri: Uri, options?: unknown): void {
        this.edits.push({ op: 'createFile', uri, options });
    }
    deleteFile(uri: Uri, options?: unknown): void {
        this.edits.push({ op: 'deleteFile', uri, options });
    }
}

// --- workspace ----------------------------------------------------------

const workspace = {
    workspaceFolders: undefined as { uri: Uri; name: string; index: number }[] | undefined,

    findFiles: sinon.stub<[string, string?, number?], Promise<Uri[]>>().resolves([]),

    fs: {
        readFile: sinon.stub<[Uri], Promise<Uint8Array>>().resolves(new Uint8Array()),
        stat: sinon.stub<[Uri], Promise<{ type: number }>>().resolves({ type: 1 })
    },

    openTextDocument: sinon.stub<[Uri], Promise<unknown>>(),

    applyEdit: sinon.stub<[WorkspaceEdit], Promise<boolean>>().resolves(true),

    asRelativePath(uriOrPath: Uri | string, _includeWorkspaceFolder?: boolean): string {
        const root = workspace.workspaceFolders?.[0];
        const p = typeof uriOrPath === 'string' ? uriOrPath : uriOrPath.fsPath;
        if (root && p.startsWith(root.uri.fsPath + '/')) {
            return p.slice(root.uri.fsPath.length + 1);
        }
        return p;
    },

    getConfiguration(_section?: string): { get<T>(key: string, defaultValue: T): T } {
        return {
            get<T>(_key: string, defaultValue: T): T {
                return defaultValue;
            }
        };
    },

    registerTextDocumentContentProvider: sinon.stub().returns({ dispose() {} })
};

// --- chat / lm (placeholders; not used by unit tests) -------------------

const chat = {
    createChatParticipant: sinon.stub()
};
const lm = {
    selectChatModels: sinon.stub().resolves([]),
    tools: [] as { name: string; description: string; inputSchema?: unknown }[],
    invokeTool: sinon.stub<[string, unknown, unknown?], Promise<LanguageModelToolResult>>()
        .resolves(new LanguageModelToolResult([new LanguageModelTextPart('')]))
};

export const vscodeMock = {
    Uri,
    Position,
    Range,
    FileSystemError,
    WorkspaceEdit,
    LanguageModelTextPart,
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
    LanguageModelToolResult,
    LanguageModelChatMessage,
    LanguageModelError,
    workspace,
    chat,
    lm
};

/** Reset all sinon stubs back to their default behavior between tests. */
export function resetVscodeMock(): void {
    workspace.findFiles.reset();
    workspace.findFiles.resolves([]);
    workspace.fs.readFile.reset();
    workspace.fs.readFile.resolves(new Uint8Array());
    workspace.fs.stat.reset();
    workspace.fs.stat.resolves({ type: 1 });
    workspace.openTextDocument.reset();
    workspace.applyEdit.reset();
    workspace.applyEdit.resolves(true);
    workspace.workspaceFolders = undefined;
    chat.createChatParticipant.reset();
    lm.selectChatModels.reset();
    lm.selectChatModels.resolves([]);
    lm.invokeTool.reset();
    lm.invokeTool.resolves(new LanguageModelToolResult([new LanguageModelTextPart('')]));
    lm.tools.length = 0;
}
