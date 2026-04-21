import * as vscode from 'vscode';

/**
 * In-memory snapshots of pre-edit file contents, surfaced via a custom URI
 * scheme so chat can offer "Diff" buttons that open VS Code's native
 * `vscode.diff` against the dirty buffer.
 *
 * URIs look like:  scrooge-pre:/<id>/<original-path>
 *
 * The path tail is preserved purely so the diff title is readable; the `id`
 * is what we look up.
 */

export const SNAPSHOT_SCHEME = 'scrooge-pre';

const store = new Map<string, string>();

let counter = 0;
function nextId(): string {
    counter += 1;
    return `${Date.now().toString(36)}-${counter}`;
}

/**
 * Stash a snapshot and return a URI that, when opened, yields its contents
 * via the registered TextDocumentContentProvider.
 */
export function recordSnapshot(originalUri: vscode.Uri, text: string): vscode.Uri {
    const id = nextId();
    store.set(id, text);
    // Cap store size — keep the last ~200 snapshots, drop the rest.
    if (store.size > 200) {
        const oldest = store.keys().next().value;
        if (oldest !== undefined) {
            store.delete(oldest);
        }
    }
    const tail = originalUri.path.replace(/^\/+/, '');
    return vscode.Uri.from({ scheme: SNAPSHOT_SCHEME, path: `/${id}/${tail}` });
}

class SnapshotProvider implements vscode.TextDocumentContentProvider {
    provideTextDocumentContent(uri: vscode.Uri): string {
        // Path is "/<id>/<original-tail>"; pull the id out.
        const m = uri.path.match(/^\/([^/]+)\//);
        if (!m) return '';
        return store.get(m[1]) ?? '';
    }
}

export function registerSnapshotProvider(context: vscode.ExtensionContext): void {
    const provider = new SnapshotProvider();
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, provider)
    );
}
