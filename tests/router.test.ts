import { expect } from 'chai';
import { parseModeDecision, isPureEditsPaste } from '../src/router';

describe('parseModeDecision', () => {
    it('parses well-formed JSON', () => {
        const d = parseModeDecision('{"mode":"IMPLEMENT","rationale":"clear small task"}');
        expect(d.mode).to.equal('IMPLEMENT');
        expect(d.rationale).to.equal('clear small task');
    });

    it('strips fenced code wrappers', () => {
        const d = parseModeDecision('```json\n{"mode":"ANSWER","rationale":"hello"}\n```');
        expect(d.mode).to.equal('ANSWER');
    });

    it('finds the JSON object inside surrounding prose', () => {
        const d = parseModeDecision('Sure thing — {"mode":"ESCALATE","rationale":"ambiguous"}');
        expect(d.mode).to.equal('ESCALATE');
    });

    it('uppercases the mode field', () => {
        const d = parseModeDecision('{"mode":"implement","rationale":"x"}');
        expect(d.mode).to.equal('IMPLEMENT');
    });

    it('accepts FOLLOW_INSTRUCTIONS', () => {
        const d = parseModeDecision('{"mode":"FOLLOW_INSTRUCTIONS","rationale":"prose paste"}');
        expect(d.mode).to.equal('FOLLOW_INSTRUCTIONS');
    });

    it('falls back to ESCALATE on garbage', () => {
        expect(parseModeDecision('').mode).to.equal('ESCALATE');
        expect(parseModeDecision('not json at all').mode).to.equal('ESCALATE');
        expect(parseModeDecision('{"mode":"WAT"}').mode).to.equal('ESCALATE');
        expect(parseModeDecision('{broken json').mode).to.equal('ESCALATE');
    });

    it('truncates very long rationale', () => {
        const long = 'x'.repeat(500);
        const d = parseModeDecision(`{"mode":"ANSWER","rationale":"${long}"}`);
        expect(d.rationale.length).to.be.at.most(240);
    });
});

describe('isPureEditsPaste', () => {
    it('returns false for empty / whitespace input', () => {
        expect(isPureEditsPaste('')).to.equal(false);
        expect(isPureEditsPaste('   \n  ')).to.equal(false);
    });

    it('returns false for plain prose', () => {
        expect(isPureEditsPaste('please refactor the auth module')).to.equal(false);
    });

    it('returns true for a single SEARCH/REPLACE block with header', () => {
        const text = [
            'File: src/foo.py',
            '<<<<<<< SEARCH',
            'old line',
            '=======',
            'new line',
            '>>>>>>> REPLACE'
        ].join('\n');
        expect(isPureEditsPaste(text)).to.equal(true);
    });

    it('returns true for full-file fence with header', () => {
        const text = [
            'File: src/new.py',
            '```python',
            'def foo():',
            '    return 1',
            '```'
        ].join('\n');
        expect(isPureEditsPaste(text)).to.equal(true);
    });

    it('accepts multiple back-to-back SR blocks', () => {
        const text = [
            'File: src/a.py',
            '<<<<<<< SEARCH',
            'old1',
            '=======',
            'new1',
            '>>>>>>> REPLACE',
            'File: src/b.py',
            '<<<<<<< SEARCH',
            'old2',
            '=======',
            'new2',
            '>>>>>>> REPLACE'
        ].join('\n');
        expect(isPureEditsPaste(text)).to.equal(true);
    });

    it('returns false when prose dominates even if blocks parse', () => {
        const prose = Array(40).fill('this is just commentary line').join('\n');
        const text = prose + '\n\nFile: src/foo.py\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n';
        expect(isPureEditsPaste(text)).to.equal(false);
    });

    it('returns false when no blocks parse, regardless of prose', () => {
        expect(isPureEditsPaste('File: src/foo.py\n(no edits at all)')).to.equal(false);
    });
});
