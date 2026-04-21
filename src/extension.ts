import * as vscode from 'vscode';
import {
    handleAnswer,
    handleEscalate,
    handleImplement,
    handleFollowInstructions,
    handleSecondOpinion,
    detectNeedsEscalation
} from './scout';
import {
    decideMode,
    isPureEditsPaste,
    Mode
} from './router';
import { applyCommanderPaste, renderApplyOutcome } from './applyEdits';
import { registerSnapshotProvider } from './snapshots';

const PARTICIPANT_ID = 'scrooge-mcrouter.router';

// ---------------------------------------------------------------------------
// Conversation history
// ---------------------------------------------------------------------------

/**
 * Convert prior @router turns from the chat context into LM messages so each
 * new turn sees the conversation so far (deposit outcomes, prior briefings,
 * Scrooge's prose pastes, etc.). Caps at the last `maxTurns` exchanges to
 * keep the prompt budget under control.
 */
function buildHistoryMessages(
    context: vscode.ChatContext,
    maxTurns = 8
): vscode.LanguageModelChatMessage[] {
    const out: vscode.LanguageModelChatMessage[] = [];
    const turns = context.history.slice(-maxTurns * 2);
    for (const turn of turns) {
        if (turn instanceof vscode.ChatRequestTurn) {
            if (turn.participant && turn.participant !== PARTICIPANT_ID) continue;
            const slash = turn.command ? `/${turn.command} ` : '';
            const body = `${slash}${turn.prompt}`.trim();
            if (body) {
                out.push(vscode.LanguageModelChatMessage.User(body));
            }
        } else if (turn instanceof vscode.ChatResponseTurn) {
            if (turn.participant !== PARTICIPANT_ID) continue;
            const parts: string[] = [];
            for (const r of turn.response) {
                if (r instanceof vscode.ChatResponseMarkdownPart) {
                    parts.push(r.value.value);
                }
            }
            const text = parts.join('').trim();
            if (text) {
                out.push(vscode.LanguageModelChatMessage.Assistant(text));
            }
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

async function pickModel(
    request: vscode.ChatRequest
): Promise<vscode.LanguageModelChat | undefined> {
    if (request.model) {
        return request.model;
    }

    const anthropic = await vscode.lm.selectChatModels({ vendor: 'anthropic' });
    if (anthropic.length > 0) {
        const haiku = anthropic.find(m => /haiku/i.test(m.family) || /haiku/i.test(m.id));
        if (haiku) return haiku;
        const claude = anthropic.find(m => /claude/i.test(m.family) || /claude/i.test(m.id));
        return claude ?? anthropic[0];
    }

    const copilot = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
    if (copilot.length > 0) return copilot[0];

    const any = await vscode.lm.selectChatModels();
    return any[0];
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> => {
    // ── /deposit: explicit pure-local apply (no LM) ─────────────────────────
    if (request.command === 'deposit') {
        stream.progress('Cracking open the vault and sorting Scrooge\'s edits…');
        try {
            const outcome = await applyCommanderPaste(request.prompt);
            renderApplyOutcome(stream, outcome);
            return {
                metadata: {
                    route: 'deposit',
                    parsedBlocks: outcome.parsedBlocks,
                    appliedFiles: outcome.appliedFiles,
                    createdFiles: outcome.createdFiles,
                    failureCount: outcome.failures.length
                }
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            stream.markdown(`\n\n❌ Deposit failed: ${msg}`);
            return { metadata: { route: 'deposit', error: msg } };
        }
    }

    // ── Auto-detect literal edit pastes (no LM call needed) ─────────────────
    if (!request.command && isPureEditsPaste(request.prompt)) {
        stream.progress('Auto-detected literal edits — depositing without a model call…');
        try {
            const outcome = await applyCommanderPaste(request.prompt);
            renderApplyOutcome(stream, outcome);
            return {
                metadata: {
                    route: 'auto-deposit',
                    parsedBlocks: outcome.parsedBlocks,
                    appliedFiles: outcome.appliedFiles,
                    createdFiles: outcome.createdFiles,
                    failureCount: outcome.failures.length
                }
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            stream.markdown(`\n\n❌ Auto-deposit failed: ${msg}`);
            return { metadata: { route: 'auto-deposit', error: msg } };
        }
    }

    const model = await pickModel(request);
    if (!model) {
        stream.markdown(
            '⚠️ The Money Bin is empty — no language models are available. ' +
            'Make sure you are signed into GitHub Copilot and have access to at least one chat model.'
        );
        return {};
    }

    // ── Resolve mode ────────────────────────────────────────────────────────
    const history = buildHistoryMessages(context);
    let mode: Mode;
    let rationale: string;
    const slash = request.command;
    if (slash === 'penny') {
        mode = 'ANSWER'; rationale = '/penny override';
    } else if (slash === 'dispatch') {
        mode = 'ESCALATE'; rationale = '/dispatch override';
    } else if (slash === 'implement') {
        mode = 'IMPLEMENT'; rationale = '/implement override';
    } else {
        stream.progress(`Routing via **${model.vendor}/${model.family}**…`);
        const decision = await decideMode(model, request.prompt, token, history);
        mode = decision.mode;
        rationale = decision.rationale;
    }

    stream.progress(`Mode: **${mode}** — ${rationale}`);

    // ── Dispatch ────────────────────────────────────────────────────────────
    let toolsUsed: string[] = [];
    let rounds = 0;
    let chars = 0;
    let escalated = false;
    const tit = request.toolInvocationToken;

    try {
        if (mode === 'ANSWER') {
            await handleAnswer(model, request.prompt, stream, token, history);
        } else if (mode === 'ESCALATE') {
            const r = await handleEscalate(model, request.prompt, stream, token, history, undefined, tit);
            toolsUsed = r.toolsUsed; rounds = r.rounds; chars = r.chars;
        } else {
            // IMPLEMENT or FOLLOW_INSTRUCTIONS
            const handler = mode === 'IMPLEMENT' ? handleImplement : handleFollowInstructions;
            const r = await handler(model, request.prompt, stream, token, history, tit);
            toolsUsed = r.toolsUsed; rounds = r.rounds;

            if (r.escalated) {
                const escalationReason = detectNeedsEscalation(r.finalText);
                const reason = escalationReason !== undefined
                    ? (escalationReason || 'Launchpad declared the task ambiguous.')
                    : r.finalText.trim().length === 0
                        ? 'Launchpad ran out of fuel without producing edits.'
                        : 'Launchpad emitted output but no parseable SEARCH/REPLACE blocks.';

                stream.markdown(
                    `\n⚠️ Launchpad bailed out (${mode}: ${reason}). ` +
                    `Trying a second opinion before bothering Scrooge…\n\n`
                );

                const bailedMode = mode as 'IMPLEMENT' | 'FOLLOW_INSTRUCTIONS';
                const second = await handleSecondOpinion(
                    model, request.prompt, bailedMode, reason,
                    stream, token, history, tit
                );
                toolsUsed = [...toolsUsed, ...second.toolsUsed];
                rounds += second.rounds;

                if (!second.escalated && second.outcome) {
                    stream.markdown('\n✅ Second opinion succeeded — applying edits.\n\n');
                    renderApplyOutcome(stream, second.outcome);
                } else if (!second.escalated) {
                    // Native-tool path — already applied.
                    stream.markdown('\n✅ Second opinion completed via native edit tools.\n\n');
                } else {
                    // Still bailed — escalate to a Treasure Map for Scrooge.
                    stream.markdown(
                        `\n⚠️ Second opinion also bailed. Falling back to a full scout run.\n\n`
                    );
                    if (second.finalText.startsWith('NEEDS_ESCALATION')) {
                        stream.markdown(`> ${second.finalText}\n\n`);
                    }
                    escalated = true;
                    const finalReason = detectNeedsEscalation(second.finalText) ||
                        'Second-opinion retry could not produce safe edits.';
                    const e = await handleEscalate(model, request.prompt, stream, token, history, {
                        mode,
                        toolsUsed: [...r.toolsUsed, ...second.toolsUsed],
                        reason: `${reason} | Retry: ${finalReason}`,
                        finalText: second.finalText || r.finalText
                    }, tit);
                    toolsUsed = [...toolsUsed, ...e.toolsUsed];
                    rounds += e.rounds;
                    chars = e.chars;
                }
            } else if (r.outcome) {
                renderApplyOutcome(stream, r.outcome);
            }
        }
    } catch (err) {
        if (err instanceof vscode.LanguageModelError) {
            stream.markdown(`\n\n❌ Language model error: \`${err.code}\` — ${err.message}`);
        } else if (err instanceof Error) {
            stream.markdown(`\n\n❌ Unexpected error: ${err.message}`);
        } else {
            stream.markdown('\n\n❌ Unknown error invoking the language model.');
        }
    }

    return {
        metadata: {
            modelVendor: model.vendor,
            modelFamily: model.family,
            modelId: model.id,
            mode,
            rationale,
            escalated,
            scoutRounds: rounds,
            scoutTools: toolsUsed,
            briefingChars: chars
        }
    };
};

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
    const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
    context.subscriptions.push(participant);
    registerSnapshotProvider(context);
}

export function deactivate(): void {
    // disposed via subscriptions
}
