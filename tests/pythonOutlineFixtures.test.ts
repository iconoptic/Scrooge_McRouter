import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { outlinePythonText, renderPythonOutline, scanTripleStringLines } from '../src/pythonOutline';

/**
 * Fixture-driven stress test for the Python outliner.
 *
 * The fixture corpus lives under `tests/fixtures/python/` and is .gitignore'd.
 * Run `bash scripts/fetch-python-fixtures.sh` to download it. If the corpus is
 * absent (e.g. on CI without internet) this entire suite is skipped.
 *
 * Goal: prove that the outliner doesn't throw, doesn't fabricate signatures
 * inside docstrings, and yields a plausible amount of structure for every
 * file in a broad real-world sample (CPython stdlib, Django, Flask, FastAPI,
 * pydantic, numpy, sphinx, etc.).
 */

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'python');

function listFixtures(): string[] {
    if (!fs.existsSync(FIXTURE_DIR)) {
        return [];
    }
    return fs
        .readdirSync(FIXTURE_DIR)
        .filter(f => f.endsWith('.py'))
        .map(f => path.join(FIXTURE_DIR, f));
}

const FIXTURES = listFixtures();

(FIXTURES.length === 0 ? describe.skip : describe)('outlinePythonText — real-world fixtures', function () {
    this.timeout(15_000);

    for (const fixturePath of FIXTURES) {
        const name = path.basename(fixturePath);

        it(`parses ${name} without throwing and yields plausible structure`, () => {
            const source = fs.readFileSync(fixturePath, 'utf-8');

            // Must not throw on any real-world file.
            const result = outlinePythonText(source);

            // Every signature line must (a) be inside the file and (b) not be
            // inside a triple-quoted string region.
            const lineCount = source.split(/\r?\n/).length;
            const insideString = scanTripleStringLines(source.split(/\r?\n/));
            for (const sig of result.signatures) {
                expect(sig.line, `${name}: line out of range`).to.be.within(1, lineCount);
                expect(insideString[sig.line - 1], `${name}: signature on line ${sig.line} is inside a triple-quoted string`).to.equal(false);
            }
            for (const imp of result.imports) {
                expect(imp.length, `${name}: empty import captured`).to.be.greaterThan(0);
            }

            // Every fixture in this corpus is a substantive module with at
            // least one class or def. (If we add tiny fixtures later, gate
            // this with a per-file allow-list.)
            expect(
                result.signatures.length,
                `${name}: expected at least one class/def signature, got 0`
            ).to.be.greaterThan(0);
        });

        it(`renders ${name} into a non-empty outline string`, () => {
            const source = fs.readFileSync(fixturePath, 'utf-8');
            const out = renderPythonOutline(name, source);
            expect(out).to.include(`===== ${name} =====`);
            expect(out.length).to.be.greaterThan(50);
            // The render must not mention the placeholder for "no signatures
            // found" — every fixture has at least one class/def.
            expect(out).to.not.include('(no class/def signatures found)');
        });
    }

    it('summary: outlines every fixture quickly enough to be usable as a tool call', function () {
        const start = Date.now();
        let totalSignatures = 0;
        let totalImports = 0;
        for (const fixturePath of FIXTURES) {
            const source = fs.readFileSync(fixturePath, 'utf-8');
            const { imports, signatures } = outlinePythonText(source);
            totalSignatures += signatures.length;
            totalImports += imports.length;
        }
        const elapsed = Date.now() - start;
        // 25 real-world files should outline in well under a second.
        expect(elapsed, `outlining took ${elapsed}ms`).to.be.lessThan(2_000);
        expect(totalSignatures).to.be.greaterThan(500);
        expect(totalImports).to.be.greaterThan(100);
    });
});
