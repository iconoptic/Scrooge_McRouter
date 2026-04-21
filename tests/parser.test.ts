import { expect } from 'chai';
import { parseCommanderText, applyCommanderPaste } from '../src/applyEdits';
import { vscodeMock, resetVscodeMock } from './vscodeMock';

const { workspace, Uri } = vscodeMock;

describe('parseCommanderText', () => {
    it('parses a single full-file block with `File:` header', () => {
        const text = [
            'File: src/foo.ts',
            '```ts',
            'export const x = 1;',
            'console.log(x);',
            '```'
        ].join('\n');
        const blocks = parseCommanderText(text);
        expect(blocks).to.have.lengthOf(1);
        expect(blocks[0].path).to.equal('src/foo.ts');
        expect(blocks[0].edit.kind).to.equal('fullFile');
        if (blocks[0].edit.kind === 'fullFile') {
            expect(blocks[0].edit.content).to.equal('export const x = 1;\nconsole.log(x);');
        }
    });

    it('accepts `Path:` and case-insensitive header variants', () => {
        const text = 'PATH: a/b.py\n```\nprint(1)\n```';
        const blocks = parseCommanderText(text);
        expect(blocks).to.have.lengthOf(1);
        expect(blocks[0].path).to.equal('a/b.py');
    });

    it('accepts `### path/to/file.ext` markdown-heading header', () => {
        const text = '### src/header.ts\n```\nconst y = 2;\n```';
        const blocks = parseCommanderText(text);
        expect(blocks).to.have.lengthOf(1);
        expect(blocks[0].path).to.equal('src/header.ts');
    });

    it('accepts a bare backticked-path header line', () => {
        const text = '`src/bare.ts`\n```\nz\n```';
        const blocks = parseCommanderText(text);
        expect(blocks).to.have.lengthOf(1);
        expect(blocks[0].path).to.equal('src/bare.ts');
    });

    it('parses multiple files in one paste', () => {
        const text = [
            'File: a.ts',
            '```',
            'A',
            '```',
            'File: b.ts',
            '```',
            'B',
            '```'
        ].join('\n');
        const blocks = parseCommanderText(text);
        expect(blocks).to.have.lengthOf(2);
        expect(blocks.map(b => b.path)).to.deep.equal(['a.ts', 'b.ts']);
    });

    it('parses a SEARCH/REPLACE block inside a fence', () => {
        const text = [
            'File: src/foo.ts',
            '```',
            '<<<<<<< SEARCH',
            'old line',
            '=======',
            'new line',
            '>>>>>>> REPLACE',
            '```'
        ].join('\n');
        const blocks = parseCommanderText(text);
        expect(blocks).to.have.lengthOf(1);
        expect(blocks[0].edit.kind).to.equal('searchReplace');
        if (blocks[0].edit.kind === 'searchReplace') {
            expect(blocks[0].edit.search).to.equal('old line');
            expect(blocks[0].edit.replace).to.equal('new line');
        }
    });

    it('parses a bare SEARCH/REPLACE block (no fence)', () => {
        const text = [
            'File: src/foo.ts',
            '<<<<<<< SEARCH',
            'a',
            'b',
            '=======',
            'c',
            '>>>>>>> REPLACE'
        ].join('\n');
        const blocks = parseCommanderText(text);
        expect(blocks).to.have.lengthOf(1);
        if (blocks[0].edit.kind === 'searchReplace') {
            expect(blocks[0].edit.search).to.equal('a\nb');
            expect(blocks[0].edit.replace).to.equal('c');
        }
    });

    it('parses multiple SEARCH/REPLACE blocks bound to the same file', () => {
        const text = [
            'File: src/foo.ts',
            '<<<<<<< SEARCH',
            'one',
            '=======',
            'ONE',
            '>>>>>>> REPLACE',
            '<<<<<<< SEARCH',
            'two',
            '=======',
            'TWO',
            '>>>>>>> REPLACE'
        ].join('\n');
        const blocks = parseCommanderText(text);
        expect(blocks).to.have.lengthOf(2);
        expect(blocks.every(b => b.path === 'src/foo.ts')).to.equal(true);
    });

    it('tolerates marker lengths >= 3', () => {
        const text = [
            'File: x.ts',
            '<<< SEARCH',
            'old',
            '===',
            'new',
            '>>> REPLACE'
        ].join('\n');
        const blocks = parseCommanderText(text);
        expect(blocks).to.have.lengthOf(1);
    });

    it('ignores fenced blocks that have no preceding header (commentary)', () => {
        const text = [
            'Some explanation here.',
            '```',
            'console.log("not a file edit")',
            '```',
            'File: real.ts',
            '```',
            'real',
            '```'
        ].join('\n');
        const blocks = parseCommanderText(text);
        expect(blocks).to.have.lengthOf(1);
        expect(blocks[0].path).to.equal('real.ts');
    });

    it('returns [] for empty / whitespace input', () => {
        expect(parseCommanderText('')).to.deep.equal([]);
        expect(parseCommanderText('   \n   \n')).to.deep.equal([]);
    });

    it('returns [] for prose with no headers or fences', () => {
        expect(parseCommanderText('Just some text without any code.')).to.deep.equal([]);
    });

    it('drops malformed SEARCH block (no divider before EOF)', () => {
        const text = [
            'File: x.ts',
            '<<<<<<< SEARCH',
            'never closed'
        ].join('\n');
        expect(parseCommanderText(text)).to.deep.equal([]);
    });

    it('drops malformed SEARCH block (REPLACE marker before divider)', () => {
        const text = [
            'File: x.ts',
            '<<<<<<< SEARCH',
            'oops',
            '>>>>>>> REPLACE'
        ].join('\n');
        expect(parseCommanderText(text)).to.deep.equal([]);
    });

    it('drops malformed SEARCH block (divider but no closing REPLACE)', () => {
        const text = [
            'File: x.ts',
            '<<<<<<< SEARCH',
            'old',
            '=======',
            'new'
        ].join('\n');
        expect(parseCommanderText(text)).to.deep.equal([]);
    });

    it('handles an unterminated fence by absorbing remaining lines', () => {
        const text = [
            'File: x.ts',
            '```',
            'line 1',
            'line 2'
        ].join('\n');
        const blocks = parseCommanderText(text);
        expect(blocks).to.have.lengthOf(1);
        if (blocks[0].edit.kind === 'fullFile') {
            expect(blocks[0].edit.content).to.equal('line 1\nline 2');
        }
    });

    it('strips quotes/backticks from header path', () => {
        expect(parseCommanderText('File: "a/b.ts"\n```\nx\n```')[0].path).to.equal('a/b.ts');
        expect(parseCommanderText("File: 'a/b.ts'\n```\nx\n```")[0].path).to.equal('a/b.ts');
        expect(parseCommanderText('File: `a/b.ts`\n```\nx\n```')[0].path).to.equal('a/b.ts');
    });
});

describe('applyCommanderPaste', () => {
    beforeEach(() => {
        resetVscodeMock();
        workspace.workspaceFolders = [
            { uri: Uri.file('/repo'), name: 'repo', index: 0 }
        ];
    });

    it('reports zero parsed blocks for prose-only input', async () => {
        const outcome = await applyCommanderPaste('hello, no edits here');
        expect(outcome.parsedBlocks).to.equal(0);
        expect(outcome.appliedFiles).to.deep.equal([]);
        expect(outcome.failures).to.deep.equal([]);
    });

    it('fails every block when no workspace is open', async () => {
        workspace.workspaceFolders = undefined;
        const text = 'File: a.ts\n```\nx\n```';
        const outcome = await applyCommanderPaste(text);
        expect(outcome.failures).to.have.lengthOf(1);
        expect(outcome.failures[0].path).to.equal('a.ts');
    });

    it('creates a new file when target does not exist + full-file content', async () => {
        workspace.fs.stat.rejects(new Error('not found'));
        const text = 'File: src/new.ts\n```\nexport const NEW = 1;\n```';

        const outcome = await applyCommanderPaste(text);

        expect(outcome.createdFiles).to.deep.equal(['src/new.ts']);
        expect(outcome.appliedFiles).to.deep.equal([]);
        expect(outcome.failures).to.deep.equal([]);

        // Inspect the WorkspaceEdit handed to applyEdit.
        const editArg = workspace.applyEdit.getCall(0).args[0] as { edits: { op: string }[] };
        const ops = editArg.edits.map(e => e.op);
        expect(ops).to.include('createFile');
        expect(ops).to.include('insert');

        // applyEdit must have been called, but `save()` must NEVER be called.
        expect(workspace.applyEdit.callCount).to.equal(1);
    });

    it('refuses SEARCH/REPLACE on a non-existent target', async () => {
        workspace.fs.stat.rejects(new Error('not found'));
        const text = [
            'File: src/missing.ts',
            '<<<<<<< SEARCH',
            'old',
            '=======',
            'new',
            '>>>>>>> REPLACE'
        ].join('\n');
        const outcome = await applyCommanderPaste(text);
        expect(outcome.failures).to.have.lengthOf(1);
        expect(outcome.failures[0].reason).to.match(/does not exist/);
    });

    it('applies SEARCH/REPLACE to an existing document and leaves it dirty', async () => {
        workspace.fs.stat.resolves({ type: 1 });

        // Mock the TextDocument the production code opens.
        const docText = 'line one\nline two\nline three\n';
        const fakeDoc = makeFakeDocument(docText);
        workspace.openTextDocument.resolves(fakeDoc);

        const text = [
            'File: src/foo.ts',
            '<<<<<<< SEARCH',
            'line two',
            '=======',
            'LINE TWO!',
            '>>>>>>> REPLACE'
        ].join('\n');
        const outcome = await applyCommanderPaste(text);

        expect(outcome.appliedFiles).to.deep.equal(['src/foo.ts']);
        expect(outcome.failures).to.deep.equal([]);
        expect(workspace.applyEdit.callCount).to.equal(1);

        // Critical Phase-4 invariant: file is left unsaved. Our fake doc
        // exposes a `save` spy; it must NOT have been called.
        expect(fakeDoc.save.callCount).to.equal(0);

        // The edit replaced exactly the SEARCH range.
        const editArg = workspace.applyEdit.getCall(0).args[0] as { edits: { op: string; text?: string }[] };
        expect(editArg.edits).to.have.lengthOf(1);
        expect(editArg.edits[0].op).to.equal('replace');
        expect(editArg.edits[0].text).to.equal('LINE TWO!');
    });

    it('reports a clear failure when SEARCH text is not found', async () => {
        workspace.fs.stat.resolves({ type: 1 });
        workspace.openTextDocument.resolves(makeFakeDocument('completely unrelated\n'));

        const text = [
            'File: src/foo.ts',
            '<<<<<<< SEARCH',
            'this string does not exist',
            '=======',
            'irrelevant',
            '>>>>>>> REPLACE'
        ].join('\n');
        const outcome = await applyCommanderPaste(text);
        expect(outcome.failures).to.have.lengthOf(1);
        expect(outcome.failures[0].reason).to.match(/SEARCH text not found/);
    });

    it('groups multiple blocks on the same file into a single applyEdit call', async () => {
        workspace.fs.stat.resolves({ type: 1 });
        workspace.openTextDocument.resolves(makeFakeDocument('alpha\nbeta\n'));

        const text = [
            'File: src/foo.ts',
            '<<<<<<< SEARCH',
            'alpha',
            '=======',
            'ALPHA',
            '>>>>>>> REPLACE',
            '<<<<<<< SEARCH',
            'beta',
            '=======',
            'BETA',
            '>>>>>>> REPLACE'
        ].join('\n');
        await applyCommanderPaste(text);

        expect(workspace.applyEdit.callCount).to.equal(1);
        const editArg = workspace.applyEdit.getCall(0).args[0] as { edits: unknown[] };
        expect(editArg.edits).to.have.lengthOf(2);
    });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

import * as sinon from 'sinon';

function makeFakeDocument(text: string) {
    const lines = text.split('\n');
    return {
        getText: () => text,
        lineCount: lines.length,
        lineAt: (i: number) => {
            const line = lines[i] ?? '';
            return {
                text: line,
                range: new vscodeMock.Range(
                    new vscodeMock.Position(i, 0),
                    new vscodeMock.Position(i, line.length)
                )
            };
        },
        positionAt: (offset: number) => {
            let remaining = offset;
            for (let i = 0; i < lines.length; i++) {
                const len = lines[i].length + 1; // +1 for newline
                if (remaining < len) {
                    return new vscodeMock.Position(i, remaining);
                }
                remaining -= len;
            }
            return new vscodeMock.Position(lines.length - 1, lines[lines.length - 1].length);
        },
        save: sinon.spy(async () => true)
    };
}
