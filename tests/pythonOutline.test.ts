import { expect } from 'chai';
import { outlinePythonText, renderPythonOutline, scanTripleStringLines } from '../src/pythonOutline';

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

describe('scanTripleStringLines', () => {
    it('flags lines inside a multi-line triple-double-quoted string', () => {
        const lines = [
            '"""Module',
            'docstring',
            'here."""',
            'x = 1'
        ];
        const inside = scanTripleStringLines(lines);
        expect(inside).to.deep.equal([false, true, true, false]);
    });

    it('handles single-line triple-quoted strings', () => {
        const lines = [
            'x = """one-liner"""',
            'y = 2'
        ];
        const inside = scanTripleStringLines(lines);
        expect(inside).to.deep.equal([false, false]);
    });

    it('treats triple-single-quotes the same as triple-double', () => {
        const lines = [
            "EXAMPLE = '''",
            'def f(): pass',
            "'''",
            'real = 1'
        ];
        const inside = scanTripleStringLines(lines);
        expect(inside).to.deep.equal([false, true, true, false]);
    });

    it('does not get confused by single-line strings containing triple-quote chars', () => {
        const lines = [
            'a = "hello"',
            'b = \'world\'',
            'def real(): pass'
        ];
        const inside = scanTripleStringLines(lines);
        expect(inside.every(v => v === false)).to.equal(true);
    });

    it('ignores triple-quotes that appear inside `#` comments', () => {
        const lines = [
            '# Example: """foo"""',
            'def real(): pass'
        ];
        const inside = scanTripleStringLines(lines);
        expect(inside).to.deep.equal([false, false]);
    });

    it('handles raw / byte string prefixes on the opener', () => {
        const lines = [
            'msg = r"""raw',
            'multiline',
            '"""',
            'x = 1'
        ];
        const inside = scanTripleStringLines(lines);
        expect(inside).to.deep.equal([false, true, true, false]);
    });

    it('handles escaped quotes inside single-line strings', () => {
        const lines = [
            'shout = "He said \\"hi\\""',
            'def real(): pass'
        ];
        const inside = scanTripleStringLines(lines);
        expect(inside).to.deep.equal([false, false]);
    });
});

describe('outlinePythonText — adversarial cases', () => {
    it('does not extract `def` lines hidden inside a module docstring', () => {
        const src = [
            '"""Module docstring.',
            '',
            'Example:',
            '    def example():',
            '        pass',
            '"""',
            '',
            'def real_function():',
            '    pass'
        ].join('\n');
        const { signatures } = outlinePythonText(src);
        expect(signatures).to.have.length(1);
        expect(signatures[0].text).to.match(/^def real_function/);
    });

    it('does not extract `class` lines hidden inside a triple-quoted string', () => {
        const src = [
            'EXAMPLE = """',
            'class Fake:',
            '    pass',
            '"""',
            '',
            'class Real:',
            '    pass'
        ].join('\n');
        const { signatures } = outlinePythonText(src);
        expect(signatures.map(s => s.text)).to.deep.equal(['class Real:']);
    });

    it('does not extract `import` lines hidden inside a docstring', () => {
        const src = [
            '"""',
            'Usage:',
            '    import foo',
            '    from bar import baz',
            '"""',
            '',
            'import real_module',
            'from real.pkg import thing'
        ].join('\n');
        const { imports } = outlinePythonText(src);
        expect(imports).to.deep.equal(['import real_module', 'from real.pkg import thing']);
    });

    it('keeps imports whose lines also contain quoted text', () => {
        const src = [
            "from typing import Literal  # 'pinned'",
            'import os'
        ].join('\n');
        const { imports } = outlinePythonText(src);
        expect(imports).to.have.length(2);
        expect(imports[0]).to.match(/^from typing import Literal/);
    });

    it('handles triple-single-quoted module docstrings', () => {
        const src = [
            "'''Single-quoted module doc.",
            '',
            'def fake_in_doc(): pass',
            "'''",
            '',
            'def real(): pass'
        ].join('\n');
        const { signatures } = outlinePythonText(src);
        expect(signatures).to.have.length(1);
        expect(signatures[0].text).to.match(/^def real/);
    });

    it('still captures decorated functions (decorators just sit above the def)', () => {
        const src = [
            '@property',
            '@cache',
            'def value(self):',
            '    return self._v'
        ].join('\n');
        const { signatures } = outlinePythonText(src);
        expect(signatures).to.have.length(1);
        expect(signatures[0].text).to.equal('def value(self):');
    });

    it('captures classes with multiple base classes and metaclass kwargs', () => {
        const src = [
            'class Foo(Bar, Baz, metaclass=ABCMeta):',
            '    pass'
        ].join('\n');
        const { signatures } = outlinePythonText(src);
        expect(signatures[0].text).to.match(/^class Foo\(Bar, Baz, metaclass=ABCMeta\):/);
    });

    it('captures defs with return-type annotations', () => {
        const src = 'def add(a: int, b: int) -> int:\n    return a + b';
        const { signatures } = outlinePythonText(src);
        expect(signatures).to.have.length(1);
        expect(signatures[0].text).to.match(/^def add/);
    });

    it('does not match commented-out signatures', () => {
        const src = [
            '# def foo():',
            '#     pass',
            'def real(): pass'
        ].join('\n');
        const { signatures } = outlinePythonText(src);
        expect(signatures).to.have.length(1);
        expect(signatures[0].text).to.equal('def real(): pass');
    });

    it('handles CRLF line endings', () => {
        const src = 'import os\r\n\r\ndef foo():\r\n    pass\r\n';
        const { imports, signatures } = outlinePythonText(src);
        expect(imports).to.deep.equal(['import os']);
        expect(signatures).to.have.length(1);
        expect(signatures[0].line).to.equal(3);
    });

    it('does not crash on an unterminated triple-quoted string', () => {
        const src = [
            '"""Unterminated docstring',
            'def hidden(): pass',
            'and the file just ends'
        ].join('\n');
        const { signatures } = outlinePythonText(src);
        // Everything after the opener is "inside" — nothing should be captured.
        expect(signatures).to.deep.equal([]);
    });

    it('handles a one-line docstring on the same line as the opener and closer', () => {
        const src = [
            'def foo():',
            '    """Greet."""',
            '    pass',
            '',
            'def bar():',
            '    pass'
        ].join('\n');
        const { signatures } = outlinePythonText(src);
        expect(signatures).to.have.length(2);
        expect(signatures[0].docstring).to.equal('Greet.');
    });
});

