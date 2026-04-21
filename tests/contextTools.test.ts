import { expect } from 'chai';
import { generateRepoMap, searchWorkspace, readWorkspaceFiles } from '../src/contextTools';
import { vscodeMock, resetVscodeMock } from './vscodeMock';

const { workspace, Uri } = vscodeMock;
const ROOT = '/repo';

function setRoot(): void {
    workspace.workspaceFolders = [{ uri: Uri.file(ROOT), name: 'repo', index: 0 }];
}

function uri(rel: string) {
    return Uri.file(`${ROOT}/${rel}`);
}

function bytesOf(s: string): Uint8Array {
    return new TextEncoder().encode(s);
}

beforeEach(() => {
    resetVscodeMock();
    setRoot();
});

// ---------------------------------------------------------------------------
// generateRepoMap
// ---------------------------------------------------------------------------

describe('generateRepoMap', () => {
    it('returns a no-workspace message when no folder is open', async () => {
        workspace.workspaceFolders = undefined;
        const out = await generateRepoMap();
        expect(out).to.match(/no workspace folder/i);
    });

    it('passes a single combined exclude glob to findFiles that ignores common build dirs', async () => {
        workspace.findFiles.resolves([uri('src/index.ts')]);
        await generateRepoMap();

        expect(workspace.findFiles.callCount).to.equal(1);
        const [include, exclude] = workspace.findFiles.getCall(0).args;
        expect(include).to.equal('**/*');
        expect(exclude).to.be.a('string');
        const ex = exclude as string;
        // Critical exclusions enumerated in the requirements.
        expect(ex).to.include('node_modules');
        expect(ex).to.include('.git');
        expect(ex).to.include('dist');
        expect(ex).to.include('out');
        expect(ex).to.include('build');
    });

    it('renders a hierarchical tree from findFiles results', async () => {
        workspace.findFiles.resolves([
            uri('src/extension.ts'),
            uri('src/scout.ts'),
            uri('src/contextTools.ts'),
            uri('package.json'),
            uri('tests/parser.test.ts')
        ]);
        const out = await generateRepoMap();

        expect(out.split('\n')[0]).to.equal('repo/');
        expect(out).to.include('src/');
        expect(out).to.include('extension.ts');
        expect(out).to.include('scout.ts');
        expect(out).to.include('contextTools.ts');
        expect(out).to.include('package.json');
        expect(out).to.include('tests/');
        expect(out).to.include('parser.test.ts');
        // Box-drawing branches present.
        expect(out).to.match(/[├└]── /);
    });

    it('sorts entries deterministically', async () => {
        workspace.findFiles.resolves([
            uri('z.ts'),
            uri('a.ts'),
            uri('m.ts')
        ]);
        const out = await generateRepoMap();
        const aPos = out.indexOf('a.ts');
        const mPos = out.indexOf('m.ts');
        const zPos = out.indexOf('z.ts');
        expect(aPos).to.be.lessThan(mPos);
        expect(mPos).to.be.lessThan(zPos);
    });

    it('reports truncation when result count hits the cap', async () => {
        const many = Array.from({ length: 5 }, (_, i) => uri(`f${i}.ts`));
        workspace.findFiles.resolves(many);
        const out = await generateRepoMap(5);
        expect(out).to.match(/truncated at 5 files/);
    });
});

// ---------------------------------------------------------------------------
// searchWorkspace
// ---------------------------------------------------------------------------

describe('searchWorkspace', () => {
    it('returns an empty-query message for "" input', async () => {
        const out = await searchWorkspace('');
        expect(out).to.match(/empty search query/i);
    });

    it('returns no-workspace message when no folder is open', async () => {
        workspace.workspaceFolders = undefined;
        const out = await searchWorkspace('foo');
        expect(out).to.match(/no workspace folder/i);
    });

    it('finds literal matches and formats them as path:line: code', async () => {
        workspace.findFiles.resolves([uri('src/a.ts'), uri('src/b.ts')]);
        workspace.fs.readFile.callsFake(async (u: { fsPath: string }) => {
            if (u.fsPath.endsWith('a.ts')) {
                return bytesOf('const foo = 1;\nconst bar = 2;\nfoo + bar;');
            }
            if (u.fsPath.endsWith('b.ts')) {
                return bytesOf('// no matches here\n');
            }
            return new Uint8Array();
        });

        const out = await searchWorkspace('foo');
        expect(out).to.include('src/a.ts:1: const foo = 1;');
        expect(out).to.include('src/a.ts:3: foo + bar;');
        expect(out).to.not.include('src/b.ts');
        expect(out).to.match(/2 matches in 1 files/);
    });

    it('honors caseSensitive=false by default', async () => {
        workspace.findFiles.resolves([uri('a.ts')]);
        workspace.fs.readFile.resolves(bytesOf('FOO\nfoo\nFoo'));
        const out = await searchWorkspace('foo');
        // Three matches across three lines.
        expect(out).to.match(/3 matches in 1 files/);
    });

    it('honors caseSensitive=true', async () => {
        workspace.findFiles.resolves([uri('a.ts')]);
        workspace.fs.readFile.resolves(bytesOf('FOO\nfoo\nFoo'));
        const out = await searchWorkspace('foo', { caseSensitive: true });
        expect(out).to.match(/1 matches in 1 files/);
    });

    it('treats query as regex when isRegex=true', async () => {
        workspace.findFiles.resolves([uri('a.ts')]);
        workspace.fs.readFile.resolves(bytesOf('id_123\nid_999\nidx'));
        const out = await searchWorkspace('id_\\d+', { isRegex: true });
        expect(out).to.match(/2 matches/);
    });

    it('returns a clear message for an invalid regex', async () => {
        const out = await searchWorkspace('(unclosed', { isRegex: true });
        expect(out).to.match(/invalid regex/i);
    });

    it('skips binary files (NUL byte sniff)', async () => {
        workspace.findFiles.resolves([uri('binary.bin')]);
        workspace.fs.readFile.resolves(new Uint8Array([102, 111, 111, 0, 102, 111, 111])); // foo\0foo
        const out = await searchWorkspace('foo');
        expect(out).to.match(/no matches/);
    });

    it('respects maxMatches and reports truncation', async () => {
        workspace.findFiles.resolves([uri('a.ts')]);
        const lines = Array.from({ length: 50 }, () => 'foo').join('\n');
        workspace.fs.readFile.resolves(bytesOf(lines));
        const out = await searchWorkspace('foo', { maxMatches: 3 });
        expect(out).to.match(/truncated at 3/);
    });
});

// ---------------------------------------------------------------------------
// readWorkspaceFiles
// ---------------------------------------------------------------------------

describe('readWorkspaceFiles', () => {
    it('returns a "no paths" message for an empty array', async () => {
        const out = await readWorkspaceFiles([]);
        expect(out).to.match(/no file paths/i);
    });

    it('reads multiple files and labels each with a header', async () => {
        workspace.fs.readFile.callsFake(async (u: { fsPath: string }) => {
            if (u.fsPath.endsWith('a.ts')) { return bytesOf('AAA'); }
            if (u.fsPath.endsWith('b.ts')) { return bytesOf('BBB'); }
            return new Uint8Array();
        });
        const out = await readWorkspaceFiles(['src/a.ts', 'src/b.ts']);
        expect(out).to.include('===== src/a.ts =====');
        expect(out).to.include('AAA');
        expect(out).to.include('===== src/b.ts =====');
        expect(out).to.include('BBB');
    });

    it('reports per-file errors inline without aborting the batch', async () => {
        workspace.fs.readFile.callsFake(async (u: { fsPath: string }) => {
            if (u.fsPath.endsWith('missing.ts')) {
                throw new vscodeMock.FileSystemError('not found', 'FileNotFound');
            }
            return bytesOf('OK');
        });
        const out = await readWorkspaceFiles(['missing.ts', 'good.ts']);
        expect(out).to.include('===== missing.ts =====');
        expect(out).to.match(/error reading file:/);
        expect(out).to.include('===== good.ts =====');
        expect(out).to.include('OK');
    });

    it('skips binary files with a clear note', async () => {
        workspace.fs.readFile.resolves(new Uint8Array([1, 2, 0, 4, 5]));
        const out = await readWorkspaceFiles(['blob.bin']);
        expect(out).to.match(/skipped: binary file/);
    });

    it('truncates oversized files and notes the truncation', async () => {
        const big = bytesOf('x'.repeat(300 * 1024));
        workspace.fs.readFile.resolves(big);
        const out = await readWorkspaceFiles(['huge.txt']);
        expect(out).to.match(/truncated: file is/);
    });

    it('handles absolute paths as well as workspace-relative paths', async () => {
        workspace.fs.readFile.resolves(bytesOf('abs'));
        const out = await readWorkspaceFiles(['/etc/hosts']);
        expect(out).to.include('===== /etc/hosts =====');
        expect(out).to.include('abs');
    });
});
