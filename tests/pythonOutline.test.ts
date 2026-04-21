import { expect } from 'chai';
import { outlinePythonText, renderPythonOutline } from '../src/pythonOutline';

describe('outlinePythonText', () => {
    it('extracts top-level imports', () => {
        const src = [
            'import os',
            'from typing import List, Optional',
            'from .helpers import make_thing',
            '',
            'x = 1'
        ].join('\n');
        const { imports } = outlinePythonText(src);
        expect(imports).to.deep.equal([
            'import os',
            'from typing import List, Optional',
            'from .helpers import make_thing'
        ]);
    });

    it('extracts def and class signatures', () => {
        const src = [
            'def foo(a, b):',
            '    return a + b',
            '',
            'class Bar:',
            '    def method(self, x):',
            '        return x'
        ].join('\n');
        const { signatures } = outlinePythonText(src);
        expect(signatures).to.have.length(3);
        expect(signatures[0].text).to.match(/^def foo/);
        expect(signatures[1].text).to.match(/^class Bar/);
        expect(signatures[2].text).to.match(/^def method/);
        expect(signatures[2].indent).to.equal(4);
    });

    it('captures async def', () => {
        const src = 'async def fetch(url):\n    pass';
        const { signatures } = outlinePythonText(src);
        expect(signatures).to.have.length(1);
        expect(signatures[0].text).to.match(/^async def fetch/);
    });

    it('captures single-line docstrings', () => {
        const src = [
            'def foo():',
            '    """Greet the world."""',
            '    pass'
        ].join('\n');
        const { signatures } = outlinePythonText(src);
        expect(signatures[0].docstring).to.equal('Greet the world.');
    });

    it('captures the first line of multi-line docstrings', () => {
        const src = [
            'def foo():',
            '    """First line.',
            '',
            '    More detail.',
            '    """',
            '    pass'
        ].join('\n');
        const { signatures } = outlinePythonText(src);
        expect(signatures[0].docstring).to.equal('First line.');
    });

    it('captures multi-line docstrings with empty leading line', () => {
        const src = [
            'def foo():',
            '    """',
            '    Heads-up summary.',
            '    """'
        ].join('\n');
        const { signatures } = outlinePythonText(src);
        expect(signatures[0].docstring).to.equal('Heads-up summary.');
    });

    it('records 1-based line numbers', () => {
        const src = '\n\ndef foo():\n    pass';
        const { signatures } = outlinePythonText(src);
        expect(signatures[0].line).to.equal(3);
    });

    it('returns empty arrays for empty input', () => {
        const { imports, signatures } = outlinePythonText('');
        expect(imports).to.deep.equal([]);
        expect(signatures).to.deep.equal([]);
    });
});

describe('renderPythonOutline', () => {
    const src = [
        'import os',
        '',
        'def add(a, b):',
        '    """Add two ints."""',
        '    return a + b',
        '',
        'class Greeter:',
        '    """A greeter."""',
        '    def hello(self, name):',
        '        return f"hi {name}"'
    ].join('\n');

    it('includes a path header', () => {
        const out = renderPythonOutline('src/foo.py', src);
        expect(out).to.include('===== src/foo.py =====');
    });

    it('includes imports section with count', () => {
        const out = renderPythonOutline('src/foo.py', src);
        expect(out).to.include('imports (1):');
        expect(out).to.include('import os');
    });

    it('renders signatures with line numbers and docstrings', () => {
        const out = renderPythonOutline('src/foo.py', src);
        expect(out).to.match(/L3: def add/);
        expect(out).to.include('"""Add two ints."""');
        expect(out).to.match(/L7: class Greeter/);
        expect(out).to.match(/L9: def hello/);
    });

    it('reports when no signatures are present', () => {
        const out = renderPythonOutline('src/empty.py', 'x = 1\ny = 2');
        expect(out).to.include('(no class/def signatures found)');
    });
});
