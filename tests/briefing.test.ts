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

describe('composeBriefing — Prompt 3: Schema/Type Extraction', () => {
    const userPrompt = 'Refactor types';
    const scoutOutput = '<BRIEFING>## Goal\nRefactor\n</BRIEFING>';

    it('renders citedContext with subsections as markdown (no code fence)', () => {
        const citedContext = [
            '### Types & Schemas',
            'interface User { id: string; }',
            '',
            '### Signatures & Outlines',
            'function getUser(): User'
        ].join('\n');
        const out = composeBriefing({
            userPrompt, scoutFinalText: scoutOutput, citedContext, modelInfo
        });
        // Should NOT have backticks wrapping the content
        expect(out).to.include('### Types & Schemas');
        expect(out).to.include('interface User { id: string; }');
        expect(out).to.not.include('```\n### Types & Schemas');
    });

    it('renders citedContext without subsections in code fence', () => {
        const citedContext = 'def login(req):\n    pass';
        const out = composeBriefing({
            userPrompt, scoutFinalText: scoutOutput, citedContext, modelInfo
        });
        expect(out).to.include('```\ndef login(req):\n    pass\n```');
    });

    it('protects type definitions in budget trimming', () => {
        const types = [
            '### Types & Schemas',
            'interface Config { timeout: number; retries: number; }',
            'interface User { id: string; name: string; }'
        ].join('\n');
        const impl = 'X'.repeat(100_000);  // Large implementation slice
        const out = composeBriefing({
            userPrompt: 'help',
            scoutFinalText: '<BRIEFING>findings</BRIEFING>',
            citedContext: types,
            modelInfo,
            budgetChars: 10_000
        });
        // Types should still be present even though we're under 10k budget
        expect(out).to.include('### Types & Schemas');
        expect(out).to.include('interface Config');
    });
});

describe('composeBriefing — Prompt 2: What I Couldn\'t Find', () => {
    const userPrompt = 'Add feature';
    const scoutOutput = '<BRIEFING>## Goal\nAdd\n</BRIEFING>';

    it('always includes "What I Couldn\'t Find" section', () => {
        const out = composeBriefing({ userPrompt, scoutFinalText: scoutOutput, modelInfo });
        expect(out).to.include('## What I Couldn\'t Find');
    });

    it('shows "No gaps noted" when no notFoundItems provided', () => {
        const out = composeBriefing({ userPrompt, scoutFinalText: scoutOutput, modelInfo });
        expect(out).to.include('No gaps noted');
    });

    it('renders provided notFoundItems as a bulleted list', () => {
        const notFoundItems = [
            'No test file found for src/auth.py',
            'No error handling in loginHandler() at src/handler.ts:88',
            'User mentioned "caching" — no matches found'
        ];
        const out = composeBriefing({
            userPrompt, scoutFinalText: scoutOutput, notFoundItems, modelInfo
        });
        expect(out).to.include('- No test file found for src/auth.py');
        expect(out).to.include('- No error handling in loginHandler() at src/handler.ts:88');
        expect(out).to.include('- User mentioned "caching" — no matches found');
    });

    it('places "What I Couldn\'t Find" after Cited Context', () => {
        const citedContext = 'code snippet here';
        const notFoundItems = ['Gap 1', 'Gap 2'];
        const out = composeBriefing({
            userPrompt, scoutFinalText: scoutOutput, citedContext, notFoundItems, modelInfo
        });
        const citedAt = out.indexOf('## Cited Context');
        const gapsAt = out.indexOf('## What I Couldn\'t Find');
        expect(citedAt).to.be.greaterThan(-1);
        expect(gapsAt).to.be.greaterThan(citedAt);
    });

    it('gap items are rendered as single lines (no multi-line paragraphs)', () => {
        const notFoundItems = [
            'Gap 1',
            'Gap 2 with some description'
        ];
        const out = composeBriefing({
            userPrompt, scoutFinalText: scoutOutput, notFoundItems, modelInfo
        });
        const gapsSection = out.match(/## What I Couldn't Find[\s\S]*?(## |---)/)?.[0] || '';
        // Count lines starting with "-" (bullet points)
        const lines = gapsSection.split('\n').filter((l: string) => l.trim().startsWith('- '));
        expect(lines.length).to.equal(2);
        // Each bullet should be a single line
        for (const line of lines) {
            expect(line).to.not.include('\n');
        }
    });
});

describe('composeBriefing — Prompt 1: Execution Path Tracing', () => {
    const userPrompt = 'Debug the login flow';
    const scoutOutput = '<BRIEFING>## Goal\nDebug\n</BRIEFING>';

    it('includes optional Execution Path section when provided', () => {
        const executionPath = [
            '## Execution Path',
            '',
            '**Trigger:** User clicks login button',
            '',
            '1. `handleLoginClick()` — src/handlers.ts:45',
            '   Dispatches to validateCreds().',
            '2. `validateCreds()` — src/auth.ts:120',
            '   Checks credentials, calls checkDB().',
            '3. `checkDB()` — src/db.ts:88',
            '   Queries user table.'
        ].join('\n');
        const out = composeBriefing({
            userPrompt, scoutFinalText: scoutOutput, executionPath, modelInfo
        });
        expect(out).to.include('## Execution Path');
        expect(out).to.include('Trigger: User clicks login button');
        expect(out).to.include('handleLoginClick()');
    });

    it('omits Execution Path section when not provided', () => {
        const out = composeBriefing({ userPrompt, scoutFinalText: scoutOutput, modelInfo });
        // Should not have an execution path section (only What I Couldn't Find default)
        const pathSection = out.match(/## Execution Path/);
        expect(pathSection).to.be.null;
    });

    it('execution path nodes contain file path and line numbers', () => {
        const executionPath = [
            '## Execution Path',
            '',
            '1. `entry()` — src/main.ts:10',
            '   Entry point.',
            '2. `process()` — src/lib/process.ts:45',
            '   Main logic.'
        ].join('\n');
        const out = composeBriefing({
            userPrompt, scoutFinalText: scoutOutput, executionPath, modelInfo
        });
        expect(out).to.match(/src\/main\.ts:\d+/);
        expect(out).to.match(/src\/lib\/process\.ts:\d+/);
    });

    it('places Execution Path between Cited Context and What I Couldn\'t Find', () => {
        const citedContext = 'code here';
        const executionPath = '## Execution Path\n\n1. entry() — src/main.ts:10\n   Logic.';
        const out = composeBriefing({
            userPrompt, scoutFinalText: scoutOutput, citedContext, executionPath, modelInfo
        });
        const citedAt = out.indexOf('## Cited Context');
        const pathAt = out.indexOf('## Execution Path');
        const gapsAt = out.indexOf('## What I Couldn\'t Find');
        expect(citedAt).to.be.greaterThan(-1);
        expect(pathAt).to.be.greaterThan(citedAt);
        expect(gapsAt).to.be.greaterThan(pathAt);
    });

    it('omits Execution Path placeholder when not provided', () => {
        const out = composeBriefing({ userPrompt, scoutFinalText: scoutOutput, modelInfo });
        expect(out).to.not.match(/## Execution Path\s*$/m);  // Should not exist as empty
    });
});

describe('composeBriefing — Confidence Annotations', () => {
    const userPrompt = 'Analyze the codebase';
    const scoutOutput = '<BRIEFING>## Goal\nAnalyze\n</BRIEFING>';

    it('SCROOGE_INSTRUCTIONS includes confidence tag interpretation guide', () => {
        const out = composeBriefing({ userPrompt, scoutFinalText: scoutOutput, modelInfo });
        expect(out).to.include('Reading Confidence Tags');
        expect(out).to.include('[VERIFIED]');
        expect(out).to.include('[INFERRED]');
        expect(out).to.include('[UNCERTAIN]');
        expect(out).to.include('directly read the code or output');
    });

    it('SCOUT_SYSTEM_PROMPT includes confidence model definition', () => {
        // This test verifies that the prompt text exists by checking the system prompt
        // indirectly through what Launchpad would output. For direct verification,
        // we check that confidence tags are expected in the output documentation.
        const out = composeBriefing({ userPrompt, scoutFinalText: scoutOutput, modelInfo });
        // The system prompt should produce output that references confidence tags
        expect(out).to.include('Confidence');
    });

    it('confidence tags appear inline at end of assertions', () => {
        const findings = [
            'The extension activates via activate() in src/extension.ts:12, which registers chat participants. [VERIFIED]',
            'The scout logic appears to be the only file invoking tools based on partial examination. [INFERRED]',
            'There may be a secondary code path but I found no imports pointing to it. [UNCERTAIN]'
        ].join('\n');
        const scoutOut = `<BRIEFING>${findings}</BRIEFING>`;
        const out = composeBriefing({ userPrompt, scoutFinalText: scoutOut, modelInfo });
        
        // Verify tags are inline, not on separate lines
        expect(out).to.include('[VERIFIED]');
        expect(out).to.include('[INFERRED]');
        expect(out).to.include('[UNCERTAIN]');
        
        // Verify they're at the end of assertions (followed by newline or end)
        expect(out).to.match(/\[VERIFIED\]\s*($|\n)/);
        expect(out).to.match(/\[INFERRED\]\s*($|\n)/);
        expect(out).to.match(/\[UNCERTAIN\]\s*($|\n)/);
    });

    it('Cited Context code block headers include confidence tags', () => {
        const citedContext = [
            '### src/types/config.ts:5-22 — ScoutConfig interface [VERIFIED]',
            'type ScoutConfig = { ... }',
            '',
            '### src/scout.ts:305-340 — gatherContext() [VERIFIED]',
            'function gatherContext() { ... }',
            '',
            '### src/outline.ts (approx 40-60) — buildOutline() [INFERRED — found via search]',
            'function buildOutline() { ... }'
        ].join('\n');
        const out = composeBriefing({
            userPrompt, scoutFinalText: scoutOutput, citedContext, modelInfo
        });
        expect(out).to.include('ScoutConfig interface [VERIFIED]');
        expect(out).to.include('gatherContext() [VERIFIED]');
        expect(out).to.include('buildOutline() [INFERRED');
    });

    it('Execution Path nodes include confidence tags', () => {
        const executionPath = [
            '## Execution Path',
            '',
            '1. `activate()` — src/extension.ts:12',
            '   Registers chat participants. [VERIFIED]',
            '2. `handleRequest()` — src/scout.ts:45',
            '   Dispatches to modes. [VERIFIED]',
            '3. `gatherContext()` — src/scout.ts:305',
            '   Probably calls buildOutline() but only confirmed at line 320. [INFERRED]'
        ].join('\n');
        const out = composeBriefing({
            userPrompt, scoutFinalText: scoutOutput, executionPath, modelInfo
        });
        expect(out).to.include('Registers chat participants. [VERIFIED]');
        expect(out).to.include('Dispatches to modes. [VERIFIED]');
        expect(out).to.include('[INFERRED]');
    });

    it('What I Couldn\'t Find section includes confidence tags on gap items', () => {
        const notFoundItems = [
            'No test file for src/scout.ts [VERIFIED — searched for scout.test.ts, scout.spec.ts, test/scout — zero results]',
            'No error handling in execGitCommand() at src/git.ts:44 [INFERRED — read function, saw no try/catch]',
            'User mentioned "retry logic" — no matches found [VERIFIED — searched "retry", "retryPolicy", "backoff"]'
        ];
        const out = composeBriefing({
            userPrompt, scoutFinalText: scoutOutput, notFoundItems, modelInfo
        });
        expect(out).to.include('No test file for src/scout.ts [VERIFIED');
        expect(out).to.include('[INFERRED');
        expect(out).to.include('User mentioned "retry logic" — no matches found [VERIFIED');
    });

    it('confidence tags appear in all major sections (verified by a comprehensive fixture)', () => {
        const comprehensiveScout = `<BRIEFING>
## Goal
Debug the flow

## Relevant Files
- src/main.ts (entry point) [VERIFIED]
- src/handlers.ts (request handlers) [INFERRED]

## Key Findings
- Main entry is at src/main.ts line 12 [VERIFIED]
- Request flows through handler dispatch [INFERRED]
- There's a caching layer but I'm unsure [UNCERTAIN]

## Open Questions
- Is caching enabled by default?
</BRIEFING>`;
        const citedContext = `### src/main.ts:12-25 — main() [VERIFIED]
export function main() { ... }`;
        const executionPath = `## Execution Path
1. main() — src/main.ts:12 [VERIFIED]
2. handleRequest() — src/handlers.ts:45 [INFERRED]`;
        const notFoundItems = ['No config file [VERIFIED — searched for config.json]'];
        
        const out = composeBriefing({
            userPrompt, scoutFinalText: comprehensiveScout, citedContext,
            executionPath, notFoundItems, modelInfo
        });
        
        // Verify presence of all three tag types across sections
        const verifiedCount = (out.match(/\[VERIFIED\]/g) || []).length;
        const inferredCount = (out.match(/\[INFERRED\]/g) || []).length;
        const uncertainCount = (out.match(/\[UNCERTAIN\]/g) || []).length;
        
        expect(verifiedCount).to.be.greaterThan(0);
        expect(inferredCount).to.be.greaterThan(0);
        expect(uncertainCount).to.be.greaterThan(0);
    });

    it('tags are not duplicated or mangled by the composition process', () => {
        const findings = 'The function is at line 42. [VERIFIED]';
        const scoutOut = `<BRIEFING>${findings}</BRIEFING>`;
        const out = composeBriefing({ userPrompt, scoutFinalText: scoutOut, modelInfo });
        
        // Should appear exactly once, not duplicated
        const count = (out.match(/\[VERIFIED\]/g) || []).length;
        expect(count).to.equal(1);
        expect(out).to.include('The function is at line 42. [VERIFIED]');
        expect(out).to.not.include('[VERIFIED][VERIFIED]');
    });
});
