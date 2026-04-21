import { expect } from 'chai';
import { composeBriefing, extractBriefingBody, TREASURE_MAP_BUDGET } from '../src/scout';

const modelInfo = { vendor: 'anthropic', family: 'claude-haiku-4.5' };

describe('extractBriefingBody', () => {
    it('extracts content inside <BRIEFING>…</BRIEFING>', () => {
        const text = 'preamble\n<BRIEFING>\n## Goal\nDo X\n</BRIEFING>\ntrailing';
        expect(extractBriefingBody(text)).to.equal('## Goal\nDo X');
    });

    it('is case-insensitive for the wrapper tag', () => {
        expect(extractBriefingBody('<briefing>inner</briefing>')).to.equal('inner');
    });

    it('falls back to the entire trimmed text when no wrapper is present', () => {
        expect(extractBriefingBody('   raw scout output   ')).to.equal('raw scout output');
    });

    it('captures multi-line bodies including blank lines', () => {
        const body = '## Goal\n\nfirst para\n\nsecond para';
        expect(extractBriefingBody(`<BRIEFING>\n${body}\n</BRIEFING>`)).to.equal(body);
    });
});

describe('composeBriefing', () => {
    const userPrompt = 'Refactor the auth module to support OAuth.';
    const scoutOutput = [
        '<BRIEFING>',
        '## Goal',
        'Add OAuth.',
        '## Relevant Files',
        '- src/auth.py',
        '## Key Findings',
        '- src/auth.py:42 has the login handler',
        '## Open Questions',
        '- Which provider?',
        '</BRIEFING>'
    ].join('\n');
    const citedContext = '===== src/auth.py:L40-L60 =====\ndef login(req):\n    ...';
    const partialTreeText = 'src/\n├── auth.py\n└── routes.py';

    it('returns a non-empty string', () => {
        const out = composeBriefing({ userPrompt, scoutFinalText: scoutOutput, modelInfo });
        expect(out).to.be.a('string').and.have.length.above(0);
    });

    it('includes the standard header sections in order', () => {
        const out = composeBriefing({ userPrompt, scoutFinalText: scoutOutput, modelInfo });
        const aboutAt = out.indexOf('## About this prompt');
        const scroogeAt = out.indexOf('## What Scrooge is being asked to do');
        const requestAt = out.indexOf('## Original User Request');
        const findingsAt = out.indexOf('## Launchpad\'s Findings');
        expect(aboutAt).to.be.greaterThan(-1);
        expect(scroogeAt).to.be.greaterThan(aboutAt);
        expect(requestAt).to.be.greaterThan(scroogeAt);
        expect(findingsAt).to.be.greaterThan(requestAt);
    });

    it('names the routing model in the About section', () => {
        const out = composeBriefing({ userPrompt, scoutFinalText: scoutOutput, modelInfo });
        expect(out).to.include('anthropic/claude-haiku-4.5');
    });

    it('block-quotes the original user request verbatim', () => {
        const multiline = 'line one\nline two';
        const out = composeBriefing({ userPrompt: multiline, scoutFinalText: scoutOutput, modelInfo });
        expect(out).to.include('> line one\n> line two');
    });

    it('warns Scrooge about the 80,000 character budget', () => {
        const out = composeBriefing({ userPrompt, scoutFinalText: scoutOutput, modelInfo });
        expect(out).to.match(/80,?000/);
    });

    it('preserves the briefing body without truncation when under budget', () => {
        const out = composeBriefing({ userPrompt, scoutFinalText: scoutOutput, modelInfo });
        expect(out).to.include('## Goal');
        expect(out).to.include('Add OAuth.');
        expect(out).to.include('src/auth.py:42 has the login handler');
        expect(out).to.include('- Which provider?');
    });

    it('omits the BRIEFING wrapper tags', () => {
        const out = composeBriefing({ userPrompt, scoutFinalText: scoutOutput, modelInfo });
        expect(out).to.not.include('<BRIEFING>');
        expect(out).to.not.include('</BRIEFING>');
    });

    it('includes the cited context section when provided', () => {
        const out = composeBriefing({
            userPrompt, scoutFinalText: scoutOutput, citedContext, modelInfo
        });
        expect(out).to.include('## Cited Context');
        expect(out).to.include('def login(req)');
    });

    it('includes the partial tree section when provided', () => {
        const out = composeBriefing({
            userPrompt, scoutFinalText: scoutOutput, partialTreeText, modelInfo
        });
        expect(out).to.include('## Workspace Subtree');
        expect(out).to.include('├── auth.py');
    });

    it('does NOT include a full repository map section', () => {
        const out = composeBriefing({ userPrompt, scoutFinalText: scoutOutput, modelInfo });
        expect(out).to.not.include('## Repository Map');
    });

    it('emits the total-chars footer with budget', () => {
        const out = composeBriefing({ userPrompt, scoutFinalText: scoutOutput, modelInfo });
        expect(out).to.match(/Total: \d+ chars \(budget 78000\)/);
    });

    it('falls back gracefully when the scout omitted the wrapper', () => {
        const out = composeBriefing({
            userPrompt, scoutFinalText: 'naked scout text', modelInfo
        });
        expect(out).to.include('naked scout text');
    });
});

describe('composeBriefing — budget enforcement', () => {
    it('respects custom budgetChars (truncates oversized cited context)', () => {
        const huge = 'X'.repeat(50_000);
        const out = composeBriefing({
            userPrompt: 'do thing',
            scoutFinalText: '<BRIEFING>findings</BRIEFING>',
            citedContext: huge,
            modelInfo,
            budgetChars: 5_000
        });
        expect(out.length).to.be.at.most(5_500);
        expect(out).to.match(/\[truncated:/);
    });

    it('TREASURE_MAP_BUDGET is the documented 78000', () => {
        expect(TREASURE_MAP_BUDGET).to.equal(78_000);
    });

    it('preserves the user request and findings when trimming oversize cited context', () => {
        const out = composeBriefing({
            userPrompt: 'KEEP_THIS_PROMPT',
            scoutFinalText: '<BRIEFING>KEEP_THESE_FINDINGS</BRIEFING>',
            citedContext: 'X'.repeat(200_000),
            partialTreeText: 'Y'.repeat(50_000),
            modelInfo
        });
        expect(out).to.include('KEEP_THIS_PROMPT');
        expect(out).to.include('KEEP_THESE_FINDINGS');
        expect(out.length).to.be.at.most(TREASURE_MAP_BUDGET + 600);
    });
});
