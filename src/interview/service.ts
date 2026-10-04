import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PluginInput } from '@opencode-ai/plugin';
import type { InterviewConfig } from '../config';
import {
  createInternalAgentTextPart,
  isInternalInitiatorPart,
  log,
} from '../utils';
import { parseModelReference } from '../utils/session';
import {
  appendInterviewAnswers,
  claimInterviewDocument,
  createInterviewDirectoryPath,
  createInterviewFilePath,
  DEFAULT_OUTPUT_FOLDER,
  ensureInterviewFile,
  extractSpecOutline,
  extractSummarySection,
  extractTitle,
  hashInterviewState,
  InterviewDocumentOwnershipError,
  InterviewPatchApplyError,
  markInterviewDocumentComplete,
  normalizeOutputFolder,
  parseFrontmatter,
  parseSpecBlocks,
  readInterviewDocument,
  relativeInterviewPath,
  resolveExistingInterviewPath,
  rewriteInterviewDocument,
  rewriteInterviewDocumentWithFinalSpec,
  withInterviewDocumentLock,
} from './document';
import {
  buildFallbackState,
  findLatestAssistantState,
  flattenMessage,
  locateInterviewStateBlocks,
  normalizeAssistantState,
  parseAssistantState,
} from './parser';
import {
  buildAnswerPrompt,
  buildBlockCommentPrompt,
  buildChatPrompt,
  buildImplementMissingPrompt,
  buildImplementPrompt,
  buildImplementRefusalPrompt,
  buildKickoffPrompt,
  buildNudgePrompt,
  buildPatchRepairPrompt,
  buildResumePrompt,
  type SpecPromptContext,
  TOOL_FALLBACK_HINT,
  TOOL_NAME_HINT,
} from './prompts';
import {
  createV1InterviewSessionRuntime,
  type InterviewSessionRuntime,
} from './runtime';
import type {
  InterviewAnswer,
  InterviewAssistantState,
  InterviewFileItem,
  InterviewListItem,
  InterviewMessage,
  InterviewRecord,
  InterviewState,
} from './types';

const COMMAND_NAME = 'interview';
const IMPLEMENT_COMMAND = 'implement';
const DEFAULT_MAX_QUESTIONS = 2;

/**
 * Cap on retained abandoned interview records. Abandoned interviews are kept
 * briefly so a still-open browser tab can render their final state, but
 * without a bound the `interviewsById` and `browserOpened` collections grow
 * for the life of a long-running session/dashboard process.
 */
export const MAX_RETAINED_ABANDONED = 50;

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return value !== '0' && value.toLowerCase() !== 'false';
}

function isAutomatedRuntime(env: NodeJS.ProcessEnv): boolean {
  return (
    env.NODE_ENV === 'test' ||
    isTruthyEnvFlag(env.CI) ||
    isTruthyEnvFlag(env.BUN_TEST) ||
    isTruthyEnvFlag(env.VITEST) ||
    env.JEST_WORKER_ID !== undefined
  );
}

function shouldAutoOpenBrowser(
  config: InterviewConfig | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  const requested = config?.autoOpenBrowser ?? true;
  return requested && !isAutomatedRuntime(env);
}

/**
 * Open a URL in the default browser.
 * Supports macOS, Linux, and Windows. Failures are logged but not thrown.
 */
function openBrowser(url: string): void {
  const platform = process.platform;
  let command: string;
  let args: string[];

  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    // Linux and other Unix-like systems
    command = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(command, args, {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.on('error', (error) => {
      log('[interview] failed to open browser:', { error: error.message, url });
    });
    child.unref();
  } catch (error) {
    log('[interview] failed to spawn browser opener:', {
      error: error instanceof Error ? error.message : String(error),
      url,
    });
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createInterviewService(
  ctx: PluginInput,
  config?: InterviewConfig,
  deps?: {
    openBrowser?: (url: string) => void;
    env?: NodeJS.ProcessEnv;
    runtime?: InterviewSessionRuntime;
  },
): {
  setBaseUrlResolver: (resolver: () => Promise<string>) => void;
  setStatePushCallback: (
    callback: (interviewId: string, state: InterviewState) => void,
  ) => void;
  setOnInterviewCreated: (
    callback: (interview: InterviewRecord) => void,
  ) => void;
  getActiveInterviewId: (sessionID: string) => string | null;
  registerCommand: (
    config: Record<string, unknown>,
    enabled?: { interview?: boolean; implement?: boolean },
  ) => void;
  handleCommandExecuteBefore: (
    input: { command: string; sessionID: string; arguments: string },
    output: {
      parts: Array<{
        type: string;
        text?: string;
        synthetic?: boolean;
        metadata?: Record<string, unknown>;
      }>;
    },
  ) => Promise<void>;
  handleEvent: (input: {
    event: { type: string; properties?: Record<string, unknown> };
  }) => Promise<void>;
  getInterviewState: (interviewId: string) => Promise<InterviewState>;
  submitState: (
    sessionID: string,
    state: InterviewAssistantState,
    messageID?: string,
  ) => Promise<{ ok: boolean; message: string }>;
  notifyTurnStatus: (sessionID: string) => Promise<void>;
  completeInterviewText: (
    sessionID: string,
    text: string,
    messageID?: string,
  ) => Promise<string>;
  listInterviewFiles: () => Promise<InterviewFileItem[]>;
  listInterviews: () => InterviewListItem[];
  submitAnswers: (
    interviewId: string,
    answers: InterviewAnswer[],
  ) => Promise<void>;
  submitBlockComment: (
    interviewId: string,
    section: string,
    comment: string,
  ) => Promise<void>;
  submitChat: (interviewId: string, message: string) => Promise<void>;
  handleNudgeAction: (
    interviewId: string,
    action: 'more-questions' | 'confirm-complete',
  ) => Promise<void>;
  resetPatchMemoryForTests: () => void;
} {
  const maxQuestions = config?.maxQuestions ?? DEFAULT_MAX_QUESTIONS;
  const verbose = config?.verbose ?? false;
  const outputFolder = normalizeOutputFolder(
    config?.outputFolder ?? DEFAULT_OUTPUT_FOLDER,
  );
  const autoOpenBrowser = shouldAutoOpenBrowser(
    config,
    deps?.env ?? process.env,
  );
  const browserOpener = deps?.openBrowser ?? openBrowser;
  const sessionRuntime = deps?.runtime ?? createV1InterviewSessionRuntime(ctx);
  const activeInterviewIds = new Map<string, string>();
  const interviewsById = new Map<string, InterviewRecord>();
  const activeSyncs = new Map<string, Promise<InterviewState>>();
  const sessionBusy = new Map<string, boolean>();
  const sessionModel = new Map<string, string>();
  const browserOpened = new Set<string>(); // Track interviews that have opened browser
  let resolveBaseUrl: (() => Promise<string>) | null = null;
  let onStateChange:
    | ((interviewId: string, state: InterviewState) => void)
    | null = null;
  let onInterviewCreated: ((interview: InterviewRecord) => void) | null = null;
  let abandonedOrderCounter = 0;
  const finalizationPending = new Set<string>();
  const finalizationReady = new Set<string>();
  const patchRepairSent = new Set<string>();

  // Last state successfully applied to each interview's document. Lets the
  // polling path return it without error when stored text no longer carries
  // an <interview_state> block (tool path / stripped fallback) — REQ-010.
  // `messageID` records the assistant message the state was applied for so a
  // remembered state from an earlier turn cannot mask a newer parse error.
  const lastAppliedState = new Map<
    string,
    { state: InterviewAssistantState; hash: string; messageID?: string }
  >();
  // Question ids already answered in the browser for an interview whose last
  // applied state has not changed since. Cleared whenever a fresh state is
  // applied so a re-asked question is not filtered out (stale-answer guard).
  const answeredQuestions = new Map<string, Set<string>>();
  // State applied since the current turn's notice decision, keyed by session.
  const pendingNotice = new Map<
    string,
    { state: InterviewAssistantState; hash: string }
  >();
  // Hash of the last applied state already announced per interview (REQ-012).
  const lastNotifiedHash = new Map<string, string>();
  // One notice decision per turn; reset when a turn opens.
  const turnNoticeHandled = new Map<string, boolean>();
  const turnErrorNotified = new Map<string, boolean>();
  // Reason attached to the current turn's failure notice (REQ-013).
  const turnErrorReason = new Map<string, string>();
  // Set while a turn applied state through the tool; the tool wins over a
  // text block printed in the same turn (spec edge case).
  const toolAppliedTurn = new Map<string, boolean>();
  // A turn is open from the first `busy` after a handled idle until the
  // turn-end notice decision. v1 can emit `busy` once per loop step, so only
  // the first opens the turn and resets per-turn notice state; a later busy
  // must not wipe a mid-turn tool submit.
  const turnOpen = new Map<string, boolean>();
  // Assistant message id the submit tool applied for. Text-derived state from
  // that message (and any earlier one) is skipped so a printed block cannot
  // re-apply over the tool state on later polls (v2/verbose fallback).
  const toolAppliedMessage = new Map<string, string>();
  // Turns the interview service itself started (kickoff, answers, block
  // comments, chat, nudges, patch repair). Only those may post an error
  // notice; unrelated user turns (e.g. /implement) stay silent (REQ-013).
  const serviceInitiatedTurn = new Map<string, boolean>();
  // Single in-flight notice decision per session: v1 fires `session.status
  // idle` and `session.idle` back to back, which can run concurrently.
  const turnNoticeInFlight = new Map<string, Promise<void>>();

  function setBaseUrlResolver(resolver: () => Promise<string>): void {
    resolveBaseUrl = resolver;
  }

  function setStatePushCallback(
    callback: (interviewId: string, state: InterviewState) => void,
  ): void {
    onStateChange = callback;
  }

  function setOnInterviewCreated(
    callback: (interview: InterviewRecord) => void,
  ): void {
    onInterviewCreated = callback;
  }

  function getActiveInterviewId(sessionID: string): string | null {
    return activeInterviewIds.get(sessionID) ?? null;
  }

  async function ensureServer(): Promise<string> {
    if (!resolveBaseUrl) {
      throw new Error('Interview server is not attached');
    }
    return resolveBaseUrl();
  }

  function maybeOpenBrowser(interviewId: string, url: string): void {
    if (!autoOpenBrowser) {
      return;
    }
    if (browserOpened.has(interviewId)) {
      return;
    }
    browserOpened.add(interviewId);
    browserOpener(url);
  }

  async function loadMessages(sessionID: string): Promise<InterviewMessage[]> {
    return sessionRuntime.messages(sessionID);
  }

  async function loadMessagesWithRetry(
    sessionID: string,
  ): Promise<InterviewMessage[]> {
    for (let i = 0; i < 8; i++) {
      const messages = await loadMessages(sessionID);
      if (messages.length > 0) {
        const last = messages[messages.length - 1];
        if (last?.info?.role === 'assistant') {
          return messages;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return loadMessages(sessionID);
  }

  function isUserVisibleMessage(message: InterviewMessage): boolean {
    return !(message.parts ?? []).some((part) => isInternalInitiatorPart(part));
  }

  function getInterviewById(interviewId: string): InterviewRecord | null {
    return interviewsById.get(interviewId) ?? null;
  }

  function specContext(
    markdownPath: string,
    document: string,
  ): SpecPromptContext {
    return {
      relativePath: relativeInterviewPath(ctx.directory, markdownPath),
      title: extractTitle(document),
      outline: extractSpecOutline(extractSummarySection(document)),
    };
  }

  /**
   * Mark an interview abandoned and prune the oldest abandoned records so the
   * in-memory registry (and its browser-open tracking) stays bounded.
   */
  function abandonInterview(interview: InterviewRecord): void {
    if (interview.status !== 'abandoned') {
      interview.abandonedAt = nowIso();
      interview.abandonedOrder = ++abandonedOrderCounter;
    }
    interview.status = 'abandoned';
    answeredQuestions.delete(interview.id);
    pruneAbandonedInterviews();
  }

  function bindInterview(record: InterviewRecord): void {
    activeInterviewIds.set(record.sessionID, record.id);
    interviewsById.set(record.id, record);
    fileCache = null;
    if (onInterviewCreated) {
      onInterviewCreated(record);
    }
  }

  function pruneAbandonedInterviews(): void {
    const abandoned = [...interviewsById.values()].filter(
      (record) => record.status === 'abandoned',
    );
    const overflow = abandoned.length - MAX_RETAINED_ABANDONED;
    if (overflow <= 0) return;
    abandoned
      .sort((a, b) => {
        const timeDelta =
          new Date(a.abandonedAt ?? a.createdAt).getTime() -
          new Date(b.abandonedAt ?? b.createdAt).getTime();
        if (timeDelta !== 0) return timeDelta;
        return (a.abandonedOrder ?? 0) - (b.abandonedOrder ?? 0);
      })
      .slice(0, overflow)
      .forEach((record) => {
        interviewsById.delete(record.id);
        browserOpened.delete(record.id);
      });
  }

  async function createInterview(
    sessionID: string,
    idea: string,
  ): Promise<InterviewRecord> {
    const normalizedIdea = idea.trim();
    const activeId = activeInterviewIds.get(sessionID);
    if (activeId) {
      const active = interviewsById.get(activeId);
      if (active && active.status === 'active') {
        if (active.idea === normalizedIdea) {
          return active;
        }

        abandonInterview(active);
      }
    }

    const messages = await loadMessages(sessionID);
    const uniqueId = randomUUID();
    const record: InterviewRecord = {
      id: uniqueId,
      sessionID,
      idea: normalizedIdea,
      markdownPath: createInterviewFilePath(
        ctx.directory,
        outputFolder,
        idea,
        uniqueId,
      ),
      createdAt: nowIso(),
      status: 'active',
      baseMessageCount: messages.length,
    };

    await withInterviewDocumentLock(record.markdownPath, () =>
      ensureInterviewFile(record),
    );
    bindInterview(record);
    return record;
  }

  async function resumeInterview(
    sessionID: string,
    markdownPath: string,
  ): Promise<InterviewRecord> {
    const activeId = activeInterviewIds.get(sessionID);
    if (activeId) {
      const active = interviewsById.get(activeId);
      if (active && active.status === 'active') {
        if (active.markdownPath === markdownPath) {
          return active;
        }

        abandonInterview(active);
      }
    }

    const messages = await loadMessages(sessionID);
    const document = await claimInterviewDocument(
      markdownPath,
      sessionID,
      messages.length,
    );
    const title = extractTitle(document);
    const record: InterviewRecord = {
      id: randomUUID(),
      sessionID,
      idea: title || path.basename(markdownPath, '.md'),
      markdownPath,
      createdAt: nowIso(),
      status: 'active',
      completed: parseFrontmatter(document)?.status === 'complete',
      baseMessageCount: messages.length,
    };

    bindInterview(record);
    return record;
  }

  function syncInterview(
    interview: InterviewRecord,
    retryMessages = true,
  ): Promise<InterviewState> {
    const existing = activeSyncs.get(interview.id);
    if (existing) {
      return existing;
    }

    const sync = performSyncInterview(interview, retryMessages).finally(() => {
      activeSyncs.delete(interview.id);
    });
    activeSyncs.set(interview.id, sync);
    return sync;
  }

  /**
   * Shared apply step (REQ-003): dedupe `state` against the document's
   * `consumedState` hash and rewrite the document. Used by the tool path,
   * the v1 `text.complete` fallback, and polling.
   */
  async function applyStateToDocument(
    interview: InterviewRecord,
    state: InterviewAssistantState,
  ): Promise<{
    document: string;
    patchError: InterviewPatchApplyError | null;
    applied: boolean;
    hash: string;
  }> {
    return withInterviewDocumentLock(interview.markdownPath, async () => {
      const existingDocument = await readInterviewDocument(interview);
      const turnHash = hashInterviewState(state);
      const consumed = parseFrontmatter(existingDocument)?.consumedState;
      if (consumed === turnHash) {
        return {
          document: existingDocument,
          patchError: null,
          applied: false,
          hash: turnHash,
        };
      }

      try {
        const document = await rewriteInterviewDocument(
          interview,
          state.summary,
          state.title,
          state.patch,
          turnHash,
        );
        if (state.patch?.trim()) {
          patchRepairSent.delete(interview.id);
        }
        return { document, patchError: null, applied: true, hash: turnHash };
      } catch (error) {
        if (!(error instanceof InterviewPatchApplyError)) {
          throw error;
        }
        return {
          document: existingDocument,
          patchError: error,
          applied: false,
          hash: turnHash,
        };
      }
    });
  }

  /** Record an accepted state so the turn-end notice and polling reflect it. */
  function markStateApplied(
    interview: InterviewRecord,
    state: InterviewAssistantState,
    hash: string,
    messageID?: string,
  ): void {
    lastAppliedState.set(interview.id, { state, hash, messageID });
    // A fresh state supersedes any previously answered questions.
    answeredQuestions.delete(interview.id);
    pendingNotice.set(interview.sessionID, { state, hash });
    turnNoticeHandled.delete(interview.sessionID);
    turnErrorNotified.delete(interview.sessionID);
    turnErrorReason.delete(interview.sessionID);
  }

  function markTurnError(sessionID: string, reason: string): void {
    // First reason wins for a turn: a specific tool/parse failure must not be
    // overwritten by the generic missing-block fallback discovered on a later
    // turn-end sync (REQ-013).
    if (!turnErrorReason.has(sessionID)) {
      turnErrorReason.set(sessionID, reason);
    }
  }

  function countPatchHunks(patch: string | undefined): number {
    if (!patch) {
      return 0;
    }
    const matches = patch.match(/^@@ /gm);
    return matches ? matches.length : 0;
  }

  function stripInterviewStateBlocks(text: string): string {
    const blocks = locateInterviewStateBlocks(text);
    if (blocks.length === 0) {
      return text;
    }
    let result = text;
    for (const block of [...blocks].sort(
      (left, right) => right.start - left.start,
    )) {
      result = result.slice(0, block.start) + result.slice(block.end);
    }
    return result.trim();
  }

  function resetTurnNoticeState(sessionID: string): void {
    turnNoticeHandled.delete(sessionID);
    turnErrorNotified.delete(sessionID);
    turnErrorReason.delete(sessionID);
    toolAppliedTurn.delete(sessionID);
    pendingNotice.delete(sessionID);
  }

  function closeTurn(sessionID: string): void {
    turnOpen.set(sessionID, false);
    serviceInitiatedTurn.set(sessionID, false);
  }

  async function performSyncInterview(
    interview: InterviewRecord,
    retryMessages = true,
  ): Promise<InterviewState> {
    const allMessages = retryMessages
      ? await loadMessagesWithRetry(interview.sessionID)
      : await loadMessages(interview.sessionID);
    const interviewMessages = allMessages
      .slice(interview.baseMessageCount)
      .filter(isUserVisibleMessage);
    const latestAssistant = [...interviewMessages]
      .reverse()
      .find((message) => message.info?.role === 'assistant');
    const latestAssistantText = latestAssistant
      ? flattenMessage(latestAssistant)
      : '';
    const latestAssistantId =
      typeof latestAssistant?.info?.id === 'string'
        ? latestAssistant.info.id
        : undefined;
    // Edge (spec §9): a missing block must not change whether the response
    // counts as clean once blocks are stripped. `finalizationPending` is
    // currently never populated, but the check must not depend on the block.
    const isCleanFinalResponse =
      finalizationPending.has(interview.id) &&
      finalizationReady.has(interview.id) &&
      latestAssistantText.length > 0;
    const remembered = lastAppliedState.get(interview.id);
    const toolMessageID = toolAppliedMessage.get(interview.sessionID);
    // The assistant message the current state was applied for: the tool path
    // records it on submit, the v1 text fallback records it on apply.
    const appliedMessageID = remembered?.messageID ?? toolMessageID;
    const messageIndex = (id: string | undefined): number =>
      id === undefined
        ? -1
        : interviewMessages.findIndex((message) => message.info?.id === id);
    const appliedMessageIndex = messageIndex(appliedMessageID);
    const latestAssistantIndex = messageIndex(latestAssistantId);
    const toolMessageIndex = messageIndex(toolMessageID);

    // Assistant messages strictly newer than the applied one. When the applied
    // message cannot be located (v2 transcript retention, or a tool call with
    // no stored assistant message), every assistant message is a candidate so
    // a later malformed block still surfaces. A block printed in the applied
    // message itself or earlier is never re-applied (oracle defect #6).
    const newerAssistantMessages = interviewMessages.filter(
      (message, index) => {
        if (message.info?.role !== 'assistant') {
          return false;
        }
        if (appliedMessageID !== undefined && appliedMessageIndex >= 0) {
          return index > appliedMessageIndex;
        }
        return true;
      },
    );
    // "State-bearing" means the message carries a complete
    // <interview_state>...</interview_state> region at all, valid or
    // malformed (matching the parser's both-tags check). When none of the
    // newer messages does, the remembered state is still current and must not
    // read as a missing-block error (REQ-010).
    const hasNewerStateBearingText = newerAssistantMessages.some((message) => {
      const text = flattenMessage(message).toLowerCase();
      return (
        text.includes('<interview_state>') &&
        text.includes('</interview_state>')
      );
    });

    const parsed = isCleanFinalResponse
      ? { state: null, latestAssistantError: undefined }
      : findLatestAssistantState(newerAssistantMessages, maxQuestions);

    // REQ-010 fallback is only safe while no newer message carries a state
    // block. A malformed newer block must surface its parse error (oracle
    // defect #5) and a valid newer block must apply normally, so neither is
    // masked by the remembered state.
    const rememberedForLatest =
      remembered && !hasNewerStateBearingText ? remembered : undefined;

    // The submit tool is authoritative for its assistant message and every
    // earlier one; a block printed in that message must never re-apply over
    // the tool state on a later poll.
    const latestIsToolMessageOrEarlier =
      toolMessageID !== undefined &&
      latestAssistantId !== undefined &&
      (toolMessageID === latestAssistantId ||
        (toolMessageIndex >= 0 &&
          latestAssistantIndex >= 0 &&
          latestAssistantIndex <= toolMessageIndex));
    const toolWins =
      latestIsToolMessageOrEarlier ||
      (toolAppliedTurn.get(interview.sessionID) === true &&
        rememberedForLatest !== undefined);
    const stateFromText = toolWins ? null : parsed.state;
    // The remembered state is only a fallback. Questions already answered in
    // the browser must not be re-offered once a later turn produced no new
    // state; answeredQuestions is cleared whenever a fresh state is applied.
    const answeredQuestionIds = answeredQuestions.get(interview.id);
    const answeredFilteredState =
      rememberedForLatest && !stateFromText && answeredQuestionIds?.size
        ? {
            ...rememberedForLatest.state,
            questions: rememberedForLatest.state.questions.filter(
              (question) => !answeredQuestionIds.has(question.id),
            ),
          }
        : rememberedForLatest?.state;
    const effectiveState = stateFromText ?? answeredFilteredState ?? null;
    const latestAssistantError =
      stateFromText || rememberedForLatest || toolWins
        ? undefined
        : parsed.latestAssistantError;
    if (latestAssistantError) {
      markTurnError(interview.sessionID, latestAssistantError);
    }

    let document: string;
    let patchError: InterviewPatchApplyError | null = null;

    if (isCleanFinalResponse) {
      document = await withInterviewDocumentLock(interview.markdownPath, () =>
        rewriteInterviewDocumentWithFinalSpec(interview, latestAssistantText),
      );
      finalizationPending.delete(interview.id);
      lastAppliedState.delete(interview.id);
      pendingNotice.delete(interview.sessionID);
    } else if (stateFromText) {
      const outcome = await applyStateToDocument(interview, stateFromText);
      document = outcome.document;
      patchError = outcome.patchError;
      if (patchError) {
        markTurnError(interview.sessionID, patchError.message);
      } else if (outcome.applied) {
        markStateApplied(
          interview,
          stateFromText,
          outcome.hash,
          latestAssistantId,
        );
      } else {
        lastAppliedState.set(interview.id, {
          state: stateFromText,
          hash: outcome.hash,
          messageID: latestAssistantId,
        });
      }
    } else {
      document = await withInterviewDocumentLock(interview.markdownPath, () =>
        readInterviewDocument(interview),
      );
    }

    const fallbackState = buildFallbackState(interviewMessages);
    const state = effectiveState ?? {
      ...fallbackState,
      summary: extractSummarySection(document) || fallbackState.summary,
    };
    const repairExhausted =
      patchError !== null && patchRepairSent.has(interview.id);
    if (patchError && !repairExhausted) {
      patchRepairSent.add(interview.id);
      sessionBusy.set(interview.sessionID, true);
      serviceInitiatedTurn.set(interview.sessionID, true);
      const model = sessionModel.get(interview.sessionID);
      try {
        await sessionRuntime.continue(
          interview.sessionID,
          buildPatchRepairPrompt(
            patchError.failedHunk,
            patchError.contextWindow,
            maxQuestions,
            verbose,
          ),
          model ? (parseModelReference(model) ?? undefined) : undefined,
        );
      } catch (error) {
        sessionBusy.set(interview.sessionID, false);
        log('[interview] spec patch repair failed to send', {
          interviewId: interview.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const blocks = parseSpecBlocks(document);

    const interviewState: InterviewState = {
      interview,
      url: `${await ensureServer()}/interview/${interview.id}`,
      markdownPath: relativeInterviewPath(
        ctx.directory,
        interview.markdownPath,
      ),
      mode:
        interview.status === 'abandoned'
          ? 'abandoned'
          : interview.completed
            ? 'completed'
            : stateFromText && state.questions.length === 0
              ? 'completed'
              : sessionBusy.get(interview.sessionID) === true
                ? 'awaiting-agent'
                : state.questions.length > 0
                  ? 'awaiting-user'
                  : latestAssistantError
                    ? 'error'
                    : // An empty WHOLE-transcript read (impossible on v1
                      // runtimes; reachable on v2 only via bridge retention
                      // loss) must not read as 'completed' — the answer form
                      // would vanish for a live interview. Keyed on
                      // allMessages, NOT interviewMessages: an empty
                      // post-base slice legitimately awaits the first answer.
                      !stateFromText &&
                        allMessages.length > 0 &&
                        sessionBusy.get(interview.sessionID) === false
                      ? 'completed'
                      : 'awaiting-agent',
      lastParseError: repairExhausted
        ? 'The spec patch did not apply.'
        : latestAssistantError,
      isBusy: sessionBusy.get(interview.sessionID) === true,
      summary: state.summary,
      questions: state.questions,
      document,
      blocks,
    };

    // Push state to dashboard if callback is set (dashboard mode)
    if (onStateChange) {
      onStateChange(interview.id, interviewState);
    }

    return interviewState;
  }

  /**
   * Apply a state submitted through the `interview_submit_state` tool. Runs
   * the shared apply step without parsing message text (REQ-003).
   */
  async function submitState(
    sessionID: string,
    state: InterviewAssistantState,
    messageID?: string,
  ): Promise<{ ok: boolean; message: string }> {
    const interviewId = activeInterviewIds.get(sessionID);
    const interview = interviewId ? interviewsById.get(interviewId) : undefined;
    if (!interview) {
      return {
        ok: false,
        message: '⎔ Interview state rejected: no active interview',
      };
    }

    const normalized = normalizeAssistantState(
      state as unknown as Record<string, unknown>,
      maxQuestions,
    );
    try {
      const outcome = await applyStateToDocument(interview, normalized);
      if (outcome.patchError) {
        markTurnError(sessionID, outcome.patchError.message);
        return {
          ok: false,
          message: `⎔ Interview state rejected: ${outcome.patchError.message}`,
        };
      }
      toolAppliedTurn.set(sessionID, true);
      if (messageID) {
        toolAppliedMessage.set(sessionID, messageID);
      }
      markStateApplied(interview, normalized, outcome.hash, messageID);
      const hunks = countPatchHunks(normalized.patch);
      const count = normalized.questions.length;
      const questionLabel = count === 1 ? 'question' : 'questions';
      const message =
        hunks > 0
          ? `Interview state applied (patch: ${hunks} hunk${hunks === 1 ? '' : 's'}, ${count} ${questionLabel}).`
          : `Interview state applied (${count} ${questionLabel}).`;
      return { ok: true, message };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      markTurnError(sessionID, reason);
      return {
        ok: false,
        message: `⎔ Interview state rejected: ${reason}`,
      };
    }
  }

  /**
   * Post the one status/error notice for the turn that just ended (REQ-012,
   * REQ-013). Called on busy→idle only, never on `session.next.text.ended`.
   * Concurrent calls (v1 fires `session.status idle` and `session.idle` back
   * to back) share one in-flight decision so exactly one notice is posted.
   */
  function notifyTurnStatus(sessionID: string): Promise<void> {
    const existing = turnNoticeInFlight.get(sessionID);
    if (existing) {
      return existing;
    }
    const inFlight = performTurnNotice(sessionID).finally(() => {
      turnNoticeInFlight.delete(sessionID);
    });
    turnNoticeInFlight.set(sessionID, inFlight);
    return inFlight;
  }

  async function performTurnNotice(sessionID: string): Promise<void> {
    const interviewId = activeInterviewIds.get(sessionID);
    if (!interviewId) {
      closeTurn(sessionID);
      return;
    }
    const interview = interviewsById.get(interviewId);
    if (!interview) {
      closeTurn(sessionID);
      return;
    }

    // A completed or abandoned interview is no longer an active turn target:
    // /implement and later user turns in the same session must not post an
    // interview error notice (REQ-013).
    if (interview.completed || interview.status !== 'active') {
      closeTurn(sessionID);
      return;
    }

    // Apply any state still present in stored text (verbose mode, a missed
    // text.complete hook, or the v2 fallback) before choosing the notice.
    // Non-retrying: the turn is over, so a missing assistant message is real.
    if (!turnNoticeHandled.get(sessionID)) {
      try {
        await syncInterview(interview, false);
      } catch (error) {
        log('[interview] turn-end sync failed', {
          interviewId: interview.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (turnNoticeHandled.get(sessionID)) {
      closeTurn(sessionID);
      return;
    }

    let baseUrl: string;
    try {
      baseUrl = await ensureServer();
    } catch {
      return;
    }
    const url = `${baseUrl}/interview/${interview.id}`;

    const pending = pendingNotice.get(sessionID);
    if (pending) {
      pendingNotice.delete(sessionID);
      turnNoticeHandled.set(sessionID, true);
      toolAppliedTurn.delete(sessionID);
      closeTurn(sessionID);
      if (lastNotifiedHash.get(interview.id) === pending.hash) {
        return;
      }
      lastNotifiedHash.set(interview.id, pending.hash);
      const count = pending.state.questions.length;
      const questionLabel = count === 1 ? 'question' : 'questions';
      const docPath = relativeInterviewPath(
        ctx.directory,
        interview.markdownPath,
      );
      await sessionRuntime.notify(
        sessionID,
        `⎔ Spec updated · ${count} ${questionLabel} · UI: ${url} · Doc: ${docPath} [system status: continue without acknowledging this notification]`,
      );
      return;
    }

    const serviceInitiated = serviceInitiatedTurn.get(sessionID) === true;
    turnNoticeHandled.set(sessionID, true);
    toolAppliedTurn.delete(sessionID);
    closeTurn(sessionID);
    // Only a turn the interview service itself started (kickoff, answers,
    // block comment, chat, nudge, patch repair) may post the missing/failed
    // update notice. A plain user turn in an interview session stays silent.
    if (!serviceInitiated) {
      return;
    }
    if (turnErrorNotified.get(sessionID)) {
      return;
    }
    turnErrorNotified.set(sessionID, true);
    const reason =
      turnErrorReason.get(sessionID) ?? 'missing <interview_state> block';
    await sessionRuntime.notify(
      sessionID,
      `⎔ Interview update failed: ${reason} · UI: ${url} [system status: continue without acknowledging this notification]`,
    );
  }

  /**
   * v1 `experimental.text.complete` fallback (REQ-009): capture a printed
   * `<interview_state>` block through the shared apply step, then strip it.
   * Malformed or failed states leave the text unchanged so the existing
   * error/retry path (REQ-006) still runs. Verbose mode keeps the block.
   */
  async function completeInterviewText(
    sessionID: string,
    text: string,
    messageID?: string,
  ): Promise<string> {
    if (verbose) {
      return text;
    }
    const interviewId = activeInterviewIds.get(sessionID);
    if (!interviewId) {
      return text;
    }
    const interview = interviewsById.get(interviewId);
    if (!interview) {
      return text;
    }
    if (locateInterviewStateBlocks(text).length === 0) {
      return text;
    }
    // The submit tool is authoritative for its assistant message: a block
    // printed in the same message (or re-polled later) must not overwrite the
    // tool state. The per-turn flag covers hosts without a message id.
    const toolMessageID = toolAppliedMessage.get(sessionID);
    if (
      toolAppliedTurn.get(sessionID) ||
      (toolMessageID !== undefined && messageID === toolMessageID)
    ) {
      return stripInterviewStateBlocks(text);
    }

    const parsed = parseAssistantState(text, maxQuestions);
    if (!parsed.state) {
      return text;
    }
    try {
      const outcome = await applyStateToDocument(interview, parsed.state);
      if (outcome.patchError) {
        markTurnError(sessionID, outcome.patchError.message);
        return text;
      }
      if (outcome.applied) {
        markStateApplied(interview, parsed.state, outcome.hash, messageID);
      } else {
        lastAppliedState.set(interview.id, {
          state: parsed.state,
          hash: outcome.hash,
          messageID,
        });
      }
      return stripInterviewStateBlocks(text);
    } catch (error) {
      markTurnError(
        sessionID,
        error instanceof Error ? error.message : String(error),
      );
      return text;
    }
  }

  async function notifyInterviewUrl(
    sessionID: string,
    interview: InterviewRecord,
  ): Promise<string> {
    const baseUrl = await ensureServer();
    const url = `${baseUrl}/interview/${interview.id}`;

    // Auto-open browser on initial creation (not on every poll/refresh)
    maybeOpenBrowser(interview.id, url);

    await sessionRuntime.notify(
      sessionID,
      [
        '⎔ Interview UI ready',
        '',
        `Open: ${url}`,
        `Document: ${relativeInterviewPath(ctx.directory, interview.markdownPath)}`,
        '',
        '[system status: continue without acknowledging this notification]',
      ].join('\n'),
    );
    return url;
  }

  function registerCommand(
    opencodeConfig: Record<string, unknown>,
    enabled?: { interview?: boolean; implement?: boolean },
  ): void {
    const interviewOn = enabled?.interview !== false;
    const implementOn = enabled?.implement !== false;
    const configCommand = opencodeConfig.command as
      | Record<string, unknown>
      | undefined;
    if (!opencodeConfig.command) {
      opencodeConfig.command = {};
    }
    const commands = opencodeConfig.command as Record<string, unknown>;
    if (interviewOn && !configCommand?.[COMMAND_NAME]) {
      commands[COMMAND_NAME] = {
        template: 'Start an interview and write a live markdown spec',
        description:
          'Open a localhost interview UI linked to the current OpenCode session',
      };
    }
    if (implementOn && !configCommand?.[IMPLEMENT_COMMAND]) {
      commands[IMPLEMENT_COMMAND] = {
        template: 'Implement the completed interview spec',
        description: 'Read the completed interview markdown and implement it',
      };
    }
  }

  async function getInterviewState(
    interviewId: string,
  ): Promise<InterviewState> {
    const interview = getInterviewById(interviewId);
    if (!interview) {
      throw new Error('Interview not found');
    }
    return syncInterview(interview);
  }

  function listInterviews(): InterviewListItem[] {
    const result: InterviewListItem[] = [];
    for (const interview of interviewsById.values()) {
      if (interview.status !== 'active') continue;
      result.push({
        id: interview.id,
        idea: interview.idea,
        status: interview.status,
        createdAt: interview.createdAt,
      });
    }
    return result.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  async function submitAnswers(
    interviewId: string,
    answers: InterviewAnswer[],
  ): Promise<void> {
    const interview = getInterviewById(interviewId);
    if (!interview) {
      throw new Error('Interview not found');
    }
    if (interview.status === 'abandoned') {
      throw new Error('Interview session is no longer active.');
    }
    if (sessionBusy.get(interview.sessionID) === true) {
      throw new Error(
        'Interview session is busy. Wait for the current response.',
      );
    }

    // Acquire busy lock immediately before any async operations to prevent race
    sessionBusy.set(interview.sessionID, true);
    let promptSent = false;

    try {
      const state = await getInterviewState(interviewId);
      if (state.mode === 'error') {
        throw new Error('Interview is waiting for a valid agent update.');
      }

      const activeQuestionIds = new Set(
        state.questions.map((question) => question.id),
      );
      if (activeQuestionIds.size === 0) {
        throw new Error('There are no active interview questions to answer.');
      }
      if (answers.length !== activeQuestionIds.size) {
        throw new Error(
          'Answer every active interview question before submitting.',
        );
      }
      const invalidAnswer = answers.find(
        (answer) =>
          !activeQuestionIds.has(answer.questionId) || !answer.answer.trim(),
      );
      if (invalidAnswer) {
        throw new Error(
          'Answers do not match the current interview questions.',
        );
      }

      await withInterviewDocumentLock(interview.markdownPath, () =>
        appendInterviewAnswers(interview, state.questions, answers),
      );
      answeredQuestions.set(interview.id, activeQuestionIds);
      const prompt = buildAnswerPrompt(
        answers,
        state.questions,
        maxQuestions,
        specContext(interview.markdownPath, state.document),
        verbose,
      );

      const model = sessionModel.get(interview.sessionID);
      await sessionRuntime.continue(
        interview.sessionID,
        prompt,
        model ? (parseModelReference(model) ?? undefined) : undefined,
      );
      promptSent = true;
      serviceInitiatedTurn.set(interview.sessionID, true);
    } finally {
      if (!promptSent) {
        sessionBusy.set(interview.sessionID, false);
      }
    }
  }

  async function handleCommandExecuteBefore(
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Array<{ type: string; text?: string }> },
  ): Promise<void> {
    if (input.command === IMPLEMENT_COMMAND) {
      await handleImplement(input.sessionID, input.arguments, output);
      return;
    }
    if (input.command !== COMMAND_NAME) {
      return;
    }

    const idea = input.arguments.trim();
    output.parts.length = 0;

    if (!idea) {
      const activeId = activeInterviewIds.get(input.sessionID);
      const interview = activeId ? interviewsById.get(activeId) : null;
      if (interview?.status !== 'active') {
        output.parts.push(
          createInternalAgentTextPart(
            'The user ran /interview without an idea. Ask them for the product idea in one sentence.',
          ),
        );
        return;
      }

      await notifyInterviewUrl(input.sessionID, interview);
      serviceInitiatedTurn.set(input.sessionID, true);
      const reopenedInstruction = verbose
        ? `The interview UI was reopened for the current session. If your latest interview turn already contains unanswered questions, do not repeat them. Otherwise continue the interview with up to ${maxQuestions} clarifying questions and include the structured <interview_state> block.`
        : `The interview UI was reopened for the current session. If your latest interview turn already contains unanswered questions, do not repeat them. Otherwise continue the interview with up to ${maxQuestions} clarifying questions and submit the state with the interview_submit_state tool. ${TOOL_NAME_HINT} ${TOOL_FALLBACK_HINT} Do not print an <interview_state> block.`;
      output.parts.push(createInternalAgentTextPart(reopenedInstruction));
      return;
    }

    const resumePath = resolveExistingInterviewPath(
      ctx.directory,
      outputFolder,
      idea,
    );
    if (resumePath) {
      let interview: InterviewRecord;
      try {
        interview = await resumeInterview(input.sessionID, resumePath);
      } catch (error) {
        if (error instanceof InterviewDocumentOwnershipError) {
          output.parts.push(
            createInternalAgentTextPart(
              'This interview document is already owned by another OpenCode session and cannot be resumed here.',
            ),
          );
          return;
        }
        throw error;
      }
      const document = await fs.readFile(interview.markdownPath, 'utf8');
      await notifyInterviewUrl(input.sessionID, interview);
      serviceInitiatedTurn.set(input.sessionID, true);
      output.parts.push(
        createInternalAgentTextPart(
          buildResumePrompt(
            specContext(interview.markdownPath, document),
            maxQuestions,
            verbose,
          ),
        ),
      );
      return;
    }

    const interview = await createInterview(input.sessionID, idea);
    await notifyInterviewUrl(input.sessionID, interview);
    serviceInitiatedTurn.set(input.sessionID, true);
    output.parts.push(
      createInternalAgentTextPart(
        buildKickoffPrompt(idea, maxQuestions, verbose),
      ),
    );

    let sessionTitle = `Interview: ${idea}`;
    if (sessionTitle.length > 50) {
      sessionTitle = `${sessionTitle.slice(0, 49)}…`;
    }
    sessionRuntime.rename(input.sessionID, sessionTitle).catch(() => {});
  }

  async function handleEvent(input: {
    event: { type: string; properties?: Record<string, unknown> };
  }): Promise<void> {
    const { event } = input;
    const properties = event.properties ?? {};

    if (event.type === 'session.status') {
      const sessionID = properties.sessionID as string | undefined;
      const status = properties.status as { type?: string } | undefined;
      if (sessionID) {
        const isBusy = status?.type === 'busy';
        if (isBusy && activeInterviewIds.has(sessionID)) {
          // Open the turn only on the first busy after a handled idle. v1 can
          // emit busy once per loop step; resetting on every busy would wipe a
          // mid-turn tool submit. `sessionBusy` is deliberately not used as
          // the gate (submitAnswers sets it before the host emits busy).
          if (turnOpen.get(sessionID) !== true) {
            resetTurnNoticeState(sessionID);
            turnOpen.set(sessionID, true);
          }
        }
        sessionBusy.set(sessionID, isBusy);
        const interviewId = activeInterviewIds.get(sessionID);
        if (status?.type === 'idle') {
          turnOpen.set(sessionID, false);
          if (interviewId) {
            if (finalizationPending.has(interviewId)) {
              finalizationReady.add(interviewId);
            }
            await notifyTurnStatus(sessionID);
          }
        }
      }
      return;
    }

    if (event.type === 'session.idle') {
      const sessionID =
        (properties.sessionID as string | undefined) ??
        (properties.info as { id?: string } | undefined)?.id ??
        undefined;
      if (sessionID) {
        sessionBusy.set(sessionID, false);
        turnOpen.set(sessionID, false);
        const interviewId = activeInterviewIds.get(sessionID);
        if (interviewId && finalizationPending.has(interviewId)) {
          finalizationReady.add(interviewId);
        }
        if (interviewId) {
          await notifyTurnStatus(sessionID);
        }
      }
      return;
    }

    if (event.type === 'session.next.text.ended') {
      // Not a turn-end boundary (REQ-012): never post the notice here.
      const sessionID =
        (properties.sessionID as string | undefined) ??
        (properties.info as { id?: string } | undefined)?.id ??
        undefined;
      if (sessionID) {
        sessionBusy.set(sessionID, false);
        const interviewId = activeInterviewIds.get(sessionID);
        if (interviewId && finalizationPending.has(interviewId)) {
          finalizationReady.add(interviewId);
        }
      }
      return;
    }

    if (event.type === 'message.updated') {
      const info = properties as
        | {
            info?: {
              sessionID?: string;
              providerID?: string;
              modelID?: string;
            };
          }
        | undefined;
      const sessionID = info?.info?.sessionID;
      const providerID = info?.info?.providerID;
      const modelID = info?.info?.modelID;
      if (sessionID && providerID && modelID) {
        sessionModel.set(sessionID, `${providerID}/${modelID}`);
      }
      return;
    }

    if (event.type === 'session.deleted') {
      const deletedSessionId =
        ((properties.info as { id?: string } | undefined)?.id ??
          (properties.sessionID as string | undefined)) ||
        null;
      if (!deletedSessionId) {
        return;
      }

      sessionBusy.delete(deletedSessionId);
      sessionModel.delete(deletedSessionId);
      turnOpen.delete(deletedSessionId);
      toolAppliedMessage.delete(deletedSessionId);
      serviceInitiatedTurn.delete(deletedSessionId);
      const interviewId = activeInterviewIds.get(deletedSessionId);
      if (!interviewId) {
        return;
      }
      finalizationReady.delete(interviewId);

      const interview = interviewsById.get(interviewId);
      if (!interview) {
        return;
      }

      abandonInterview(interview);
      fileCache = null;
      activeInterviewIds.delete(deletedSessionId);
      log('[interview] session deleted, interview marked abandoned', {
        sessionID: deletedSessionId,
        interviewId,
      });
    }
  }

  let fileCache: { items: InterviewFileItem[]; at: number } | null = null;
  const FILE_CACHE_TTL = 10_000;

  async function listInterviewFiles(): Promise<InterviewFileItem[]> {
    if (fileCache && Date.now() - fileCache.at < FILE_CACHE_TTL) {
      return fileCache.items;
    }

    const outputDir = createInterviewDirectoryPath(ctx.directory, outputFolder);
    const activePaths = new Set(
      [...interviewsById.values()]
        .filter((i) => i.status === 'active')
        .map((i) => path.resolve(i.markdownPath)),
    );

    let entries: string[];
    try {
      entries = await fs.readdir(outputDir);
    } catch {
      return [];
    }

    const items: InterviewFileItem[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const fullPath = path.join(outputDir, entry);
      if (activePaths.has(path.resolve(fullPath))) continue;

      let content: string;
      try {
        content = await fs.readFile(fullPath, 'utf8');
      } catch {
        continue;
      }

      const title = extractTitle(content) || entry.replace(/\.md$/, '');
      const summary = extractSummarySection(content) || '';
      const baseName = entry.replace(/\.md$/, '');

      items.push({
        fileName: entry,
        resumeCommand: `/interview ${baseName}`,
        title,
        summary:
          summary.length > 120 ? `${summary.slice(0, 120)}\u2026` : summary,
      });
    }

    const sorted = items.sort((a, b) => a.title.localeCompare(b.title));
    fileCache = { items: sorted, at: Date.now() };
    return sorted;
  }

  async function submitBlockComment(
    interviewId: string,
    sectionTitle: string,
    comment: string,
  ): Promise<void> {
    const interview = getInterviewById(interviewId);
    if (!interview) {
      throw new Error('Interview not found');
    }
    if (interview.status === 'abandoned') {
      throw new Error('Interview session is no longer active.');
    }
    if (sessionBusy.get(interview.sessionID) === true) {
      throw new Error(
        'Interview session is busy. Wait for the current response.',
      );
    }

    sessionBusy.set(interview.sessionID, true);
    let promptSent = false;

    try {
      const state = await getInterviewState(interviewId);
      if (state.mode === 'error') {
        throw new Error('Interview is waiting for a valid agent update.');
      }

      const prompt = buildBlockCommentPrompt(
        sectionTitle,
        comment,
        maxQuestions,
        specContext(interview.markdownPath, state.document),
        verbose,
      );

      const model = sessionModel.get(interview.sessionID);
      await sessionRuntime.continue(
        interview.sessionID,
        prompt,
        model ? (parseModelReference(model) ?? undefined) : undefined,
      );
      promptSent = true;
      serviceInitiatedTurn.set(interview.sessionID, true);
    } finally {
      if (!promptSent) {
        sessionBusy.set(interview.sessionID, false);
      }
    }
  }

  async function submitChat(
    interviewId: string,
    message: string,
  ): Promise<void> {
    const interview = getInterviewById(interviewId);
    if (!interview) {
      throw new Error('Interview not found');
    }
    if (interview.status === 'abandoned') {
      throw new Error('Interview session is no longer active.');
    }
    if (sessionBusy.get(interview.sessionID) === true) {
      throw new Error(
        'Interview session is busy. Wait for the current response.',
      );
    }

    sessionBusy.set(interview.sessionID, true);
    let promptSent = false;

    try {
      const state = await getInterviewState(interviewId);
      if (state.mode === 'error') {
        throw new Error('Interview is waiting for a valid agent update.');
      }

      const prompt = buildChatPrompt(
        message,
        maxQuestions,
        specContext(interview.markdownPath, state.document),
        verbose,
      );

      const model = sessionModel.get(interview.sessionID);
      await sessionRuntime.continue(
        interview.sessionID,
        prompt,
        model ? (parseModelReference(model) ?? undefined) : undefined,
      );
      promptSent = true;
      serviceInitiatedTurn.set(interview.sessionID, true);
    } finally {
      if (!promptSent) {
        sessionBusy.set(interview.sessionID, false);
      }
    }
  }

  async function handleNudgeAction(
    interviewId: string,
    action: 'more-questions' | 'confirm-complete',
  ): Promise<void> {
    const interview = getInterviewById(interviewId);
    if (!interview) {
      throw new Error('Interview not found');
    }
    if (interview.status === 'abandoned') {
      throw new Error('Interview session is no longer active.');
    }
    if (sessionBusy.get(interview.sessionID) === true) {
      throw new Error(
        'Interview session is busy. Wait for the current response.',
      );
    }

    if (action === 'confirm-complete') {
      interview.completed = true;
      await markInterviewDocumentComplete(interview);
      const relativePath = relativeInterviewPath(
        ctx.directory,
        interview.markdownPath,
      );
      await sessionRuntime.notify(
        interview.sessionID,
        `The spec is complete. Follow ${relativePath}.`,
      );
      await getInterviewState(interviewId);
      return;
    }

    sessionBusy.set(interview.sessionID, true);
    let promptSent = false;

    try {
      const state = await getInterviewState(interviewId);

      const prompt = buildNudgePrompt(
        action,
        maxQuestions,
        specContext(interview.markdownPath, state.document),
        verbose,
      );

      const model = sessionModel.get(interview.sessionID);
      await sessionRuntime.continue(
        interview.sessionID,
        prompt,
        model ? (parseModelReference(model) ?? undefined) : undefined,
      );
      promptSent = true;
      serviceInitiatedTurn.set(interview.sessionID, true);
    } finally {
      if (!promptSent) {
        sessionBusy.set(interview.sessionID, false);
      }
    }
  }

  async function newestCompleteSpec(): Promise<string | null> {
    const outputDir = createInterviewDirectoryPath(ctx.directory, outputFolder);
    let entries: string[];
    try {
      entries = await fs.readdir(outputDir);
    } catch {
      return null;
    }
    let best: { filePath: string; mtime: number } | null = null;
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const filePath = path.join(outputDir, entry);
      try {
        const [content, stat] = await Promise.all([
          fs.readFile(filePath, 'utf8'),
          fs.stat(filePath),
        ]);
        if (parseFrontmatter(content)?.status !== 'complete') continue;
        if (!best || stat.mtimeMs > best.mtime) {
          best = { filePath, mtime: stat.mtimeMs };
        }
      } catch {}
    }
    return best?.filePath ?? null;
  }

  async function handleImplement(
    visibleSessionID: string,
    argument: string,
    output: { parts: Array<{ type: string; text?: string }> },
  ): Promise<void> {
    output.parts.length = 0;
    const requested = argument.trim();
    let markdownPath: string | null = null;
    if (requested) {
      markdownPath = resolveExistingInterviewPath(
        ctx.directory,
        outputFolder,
        requested,
      );
    } else {
      const activeId = activeInterviewIds.get(visibleSessionID);
      const active = activeId ? interviewsById.get(activeId) : undefined;
      markdownPath =
        active && active.status === 'active'
          ? active.markdownPath
          : await newestCompleteSpec();
    }
    if (!markdownPath) {
      output.parts.push(
        createInternalAgentTextPart(buildImplementMissingPrompt()),
      );
      return;
    }

    const active = [...interviewsById.values()].find(
      (record) =>
        record.status === 'active' &&
        path.resolve(record.markdownPath) === path.resolve(markdownPath),
    );
    if (active && !active.completed) {
      const state = await getInterviewState(active.id);
      const fileComplete =
        parseFrontmatter(state.document)?.status === 'complete';
      if (!fileComplete && state.questions.length > 0) {
        output.parts.push(
          createInternalAgentTextPart(buildImplementRefusalPrompt()),
        );
        return;
      }
      const body = extractSummarySection(state.document);
      if (
        !fileComplete &&
        (!body || body === 'Waiting for interview answers.')
      ) {
        output.parts.push(
          createInternalAgentTextPart(buildImplementMissingPrompt()),
        );
        return;
      }
    }

    output.parts.push(
      createInternalAgentTextPart(
        buildImplementPrompt(
          relativeInterviewPath(ctx.directory, markdownPath),
        ),
      ),
    );
  }

  return {
    setBaseUrlResolver,
    setStatePushCallback,
    setOnInterviewCreated,
    getActiveInterviewId,
    registerCommand,
    handleCommandExecuteBefore,
    handleEvent,
    getInterviewState,
    submitState,
    notifyTurnStatus,
    completeInterviewText,
    listInterviewFiles,
    listInterviews,
    submitAnswers,
    submitBlockComment,
    submitChat,
    handleNudgeAction,
    resetPatchMemoryForTests() {
      patchRepairSent.clear();
      lastAppliedState.clear();
      pendingNotice.clear();
      lastNotifiedHash.clear();
      turnNoticeHandled.clear();
      turnErrorNotified.clear();
      turnErrorReason.clear();
      toolAppliedTurn.clear();
      turnOpen.clear();
      toolAppliedMessage.clear();
      serviceInitiatedTurn.clear();
      turnNoticeInFlight.clear();
    },
  };
}
