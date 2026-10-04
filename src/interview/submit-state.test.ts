import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { InterviewConfigSchema } from '../config/schema';
import { normalizeAssistantState, parseAssistantState } from './parser';
import type { InterviewSessionRuntime } from './runtime';
import { createInterviewService } from './service';
import type { InterviewMessage, InterviewState } from './types';

interface Harness {
  directory: string;
  messages: InterviewMessage[];
  notifyCalls: string[];
  continued: string[];
  service: ReturnType<typeof createInterviewService>;
}

async function createHarness(
  config?: Partial<Parameters<typeof createInterviewService>[1]>,
): Promise<Harness> {
  const directory = await fs.mkdtemp('/tmp/interview-submit-state-');
  const messages: InterviewMessage[] = [];
  const notifyCalls: string[] = [];
  const continued: string[] = [];
  const runtime: InterviewSessionRuntime = {
    messages: async () => messages,
    notify: async (_sessionID, text) => {
      notifyCalls.push(text);
    },
    continue: async (_sessionID, text) => {
      continued.push(text);
    },
    rename: async () => {},
  };
  const resolved = config ? InterviewConfigSchema.parse(config) : undefined;
  const service = createInterviewService({ directory } as never, resolved, {
    runtime,
    openBrowser: () => {},
  });
  service.setBaseUrlResolver(async () => 'http://127.0.0.1:43211');
  return { directory, messages, notifyCalls, continued, service };
}

async function startInterview(
  harness: Harness,
  sessionID = 'ses-submit',
  idea = 'Submit state app',
): Promise<string> {
  await harness.service.handleCommandExecuteBefore(
    { command: 'interview', sessionID, arguments: idea },
    { parts: [] },
  );
  const interviewId = harness.service.getActiveInterviewId(sessionID);
  expect(interviewId).not.toBeNull();
  // A stored assistant message keeps loadMessagesWithRetry from spinning in
  // tests; it carries no <interview_state> block on purpose.
  harness.messages.push({
    info: { role: 'assistant' },
    parts: [{ type: 'text', text: 'Working on it.' }],
  });
  return interviewId as string;
}

function blockText(json: string): string {
  return `Here is the state.\n<interview_state>\n${json}\n</interview_state>`;
}

describe('interview submitState (tool path)', () => {
  test('state captured via the tool equals parser output for the same fixture', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);

    const raw = {
      summary: 'A specification',
      title: 'spec-title',
      patch: undefined,
      questions: [
        {
          id: 'q-1',
          question: 'Platform?',
          options: ['Web', 'Mobile', 'Desktop', 'Tablet', 'Other'],
          suggested: 'Web',
        },
        { id: '', question: 'Scope?' },
      ],
    };

    const result = await harness.service.submitState(
      'ses-submit',
      raw as never,
    );
    expect(result.ok).toBe(true);

    const parserOutput = parseAssistantState(
      blockText(JSON.stringify(raw)),
      2,
    ).state;
    expect(parserOutput).not.toBeNull();

    const state = await harness.service.getInterviewState(interviewId);
    expect(state.summary).toBe(normalizeAssistantState(raw, 2).summary);
    expect(state.questions).toEqual(parserOutput?.questions);
    expect(state.document).toContain('A specification');
  });

  test('rejects with a short line and no document for no active interview', async () => {
    const harness = await createHarness();
    const result = await harness.service.submitState('ses-none', {
      summary: 'x',
      questions: [],
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('⎔ Interview state rejected');
  });
});

describe('interview text.complete fallback', () => {
  test('applies a valid block and removes it from the returned text', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);

    const text = blockText(
      JSON.stringify({
        summary: 'Fallback draft',
        questions: [{ id: 'q-1', question: 'What?' }],
      }),
    );
    const result = await harness.service.completeInterviewText(
      'ses-submit',
      text,
    );

    expect(result).not.toContain('<interview_state>');
    expect(result).not.toContain('"summary"');

    const state = await harness.service.getInterviewState(interviewId);
    expect(state.document).toContain('Fallback draft');
    expect(state.questions).toHaveLength(1);
    // REQ-010: no missing-block error once the strip removed the block.
    expect(state.lastParseError).toBeUndefined();
    expect(state.mode).toBe('awaiting-user');
  });

  test('leaves malformed text unchanged', async () => {
    const harness = await createHarness();
    await startInterview(harness);
    const text = blockText('{not valid json');
    expect(
      await harness.service.completeInterviewText('ses-submit', text),
    ).toBe(text);
  });

  test('leaves non-interview text unchanged', async () => {
    const harness = await createHarness();
    const text = blockText('{"summary":"x","questions":[]}');
    expect(
      await harness.service.completeInterviewText('other-session', text),
    ).toBe(text);
  });

  test('leaves text unchanged in verbose mode', async () => {
    const harness = await createHarness({
      maxQuestions: 2,
      outputFolder: 'interview',
      autoOpenBrowser: false,
      verbose: true,
    });
    await startInterview(harness);
    const text = blockText('{"summary":"verbose","questions":[]}');
    expect(
      await harness.service.completeInterviewText('ses-submit', text),
    ).toBe(text);
  });
});

describe('interview turn-end notice', () => {
  test('posts one status notice per successful turn, not on repeated idle', async () => {
    const harness = await createHarness();
    await startInterview(harness);
    harness.notifyCalls.length = 0;

    await harness.service.submitState('ses-submit', {
      summary: 'Updated spec',
      questions: [{ id: 'q-1', question: 'Q?' }],
    });
    await harness.service.notifyTurnStatus('ses-submit');

    expect(harness.notifyCalls).toHaveLength(1);
    expect(harness.notifyCalls[0]).toContain('⎔ Spec updated');
    expect(harness.notifyCalls[0]).toContain(
      'http://127.0.0.1:43211/interview/',
    );
    expect(harness.notifyCalls[0]).toContain('.md');
    expect(harness.notifyCalls[0]).toContain(
      '[system status: continue without acknowledging this notification]',
    );

    await harness.service.notifyTurnStatus('ses-submit');
    expect(harness.notifyCalls).toHaveLength(1);
  });

  test('posts exactly one error notice when a turn ends with no new state', async () => {
    const harness = await createHarness();
    await startInterview(harness);
    harness.notifyCalls.length = 0;

    await harness.service.notifyTurnStatus('ses-submit');
    expect(harness.notifyCalls).toHaveLength(1);
    expect(harness.notifyCalls[0]).toContain('⎔ Interview update failed');
    expect(harness.notifyCalls[0]).toContain(
      'http://127.0.0.1:43211/interview/',
    );

    await harness.service.notifyTurnStatus('ses-submit');
    expect(harness.notifyCalls).toHaveLength(1);
  });

  test('posts one error notice when the patch fails to apply', async () => {
    const harness = await createHarness();
    await startInterview(harness);
    harness.notifyCalls.length = 0;

    const result = await harness.service.submitState('ses-submit', {
      summary: 'Broken',
      patch: '@@ -1,1 +1,1 @@\n-not present\n+replacement',
      questions: [],
    });
    expect(result.ok).toBe(false);

    await harness.service.notifyTurnStatus('ses-submit');
    expect(harness.notifyCalls).toHaveLength(1);
    expect(harness.notifyCalls[0]).toContain('⎔ Interview update failed');
  });

  test('adds the notice as a new tail message without touching the transcript', async () => {
    const harness = await createHarness();
    await startInterview(harness);
    harness.notifyCalls.length = 0;
    const transcriptBefore = structuredClone(harness.messages);

    await harness.service.submitState('ses-submit', {
      summary: 'Tail notice',
      questions: [],
    });
    await harness.service.notifyTurnStatus('ses-submit');

    // Delivered through notify (a fresh trailing message), never through
    // continue() or by mutating earlier messages (CON-007).
    expect(harness.notifyCalls).toHaveLength(1);
    expect(harness.notifyCalls[0]).toContain('⎔ Spec updated');
    expect(harness.continued.some((t) => t.includes('⎔ Spec updated'))).toBe(
      false,
    );
    expect(harness.messages).toEqual(transcriptBefore);
  });

  test('fires a fresh notice for a later turn after busy resets the dedupe', async () => {
    const harness = await createHarness();
    await startInterview(harness);
    harness.notifyCalls.length = 0;

    await harness.service.submitState('ses-submit', {
      summary: 'First',
      questions: [{ id: 'q-1', question: 'One?' }],
    });
    await harness.service.notifyTurnStatus('ses-submit');
    expect(harness.notifyCalls).toHaveLength(1);

    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'busy' } },
      },
    });
    await harness.service.submitState('ses-submit', {
      summary: 'Second',
      questions: [{ id: 'q-2', question: 'Two?' }],
    });
    await harness.service.notifyTurnStatus('ses-submit');
    expect(harness.notifyCalls).toHaveLength(2);
    expect(harness.notifyCalls[1]).toContain('⎔ Spec updated');
  });
});

describe('interview getInterviewState without a block', () => {
  test('returns the last applied state instead of a missing-block error', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);

    await harness.service.submitState('ses-submit', {
      summary: 'Tool applied state',
      questions: [{ id: 'q-1', question: 'Question?' }],
    });

    const state: InterviewState =
      await harness.service.getInterviewState(interviewId);
    expect(state.lastParseError).toBeUndefined();
    expect(state.questions).toEqual([
      { id: 'q-1', question: 'Question?', options: [], suggested: undefined },
    ]);
    expect(state.mode).toBe('awaiting-user');
  });
});

describe('interview verbose turn-end behavior', () => {
  test('posts a status notice for a printed block and still updates the document', async () => {
    const harness = await createHarness({
      maxQuestions: 2,
      outputFolder: 'interview',
      autoOpenBrowser: false,
      verbose: true,
    });
    const interviewId = await startInterview(harness);
    harness.messages.push({
      info: { role: 'assistant' },
      parts: [
        {
          type: 'text',
          text: blockText(
            JSON.stringify({
              summary: 'Verbose block spec',
              questions: [{ id: 'q-1', question: 'Verbose question?' }],
            }),
          ),
        },
      ],
    });
    harness.notifyCalls.length = 0;

    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'idle' } },
      },
    });

    expect(harness.notifyCalls).toHaveLength(1);
    expect(harness.notifyCalls[0]).toContain('⎔ Spec updated');
    const state = await harness.service.getInterviewState(interviewId);
    expect(state.document).toContain('Verbose block spec');
  });
});

describe('interview turn lifecycle', () => {
  test('a mid-turn busy does not wipe a tool submit for the same turn', async () => {
    const harness = await createHarness();
    await startInterview(harness);
    harness.notifyCalls.length = 0;

    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'busy' } },
      },
    });
    await harness.service.submitState('ses-submit', {
      summary: 'Mid-turn',
      questions: [{ id: 'q-1', question: 'Q?' }],
    });
    // v1 can emit `busy` once per loop step; the second must not reset the
    // turn and lose the tool state.
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'busy' } },
      },
    });
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'idle' } },
      },
    });

    expect(harness.notifyCalls).toHaveLength(1);
    expect(harness.notifyCalls[0]).toContain('⎔ Spec updated');
  });

  test('concurrent double idle posts exactly one notice', async () => {
    const harness = await createHarness();
    await startInterview(harness);
    harness.notifyCalls.length = 0;

    await harness.service.submitState('ses-submit', {
      summary: 'Concurrent',
      questions: [{ id: 'q-1', question: 'Q?' }],
    });

    await Promise.all([
      harness.service.handleEvent({
        event: {
          type: 'session.status',
          properties: { sessionID: 'ses-submit', status: { type: 'idle' } },
        },
      }),
      harness.service.handleEvent({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'ses-submit' },
        },
      }),
    ]);

    expect(harness.notifyCalls).toHaveLength(1);
    expect(harness.notifyCalls[0]).toContain('⎔ Spec updated');
  });

  test('a completed interview posts no error notice on a later turn', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);
    await harness.service.handleNudgeAction(interviewId, 'confirm-complete');
    harness.notifyCalls.length = 0;

    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'busy' } },
      },
    });
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'idle' } },
      },
    });

    expect(harness.notifyCalls).toHaveLength(0);
  });

  test('a later user turn does not post a spurious interview error', async () => {
    const harness = await createHarness();
    await startInterview(harness);
    harness.notifyCalls.length = 0;
    // The kickoff turn is service-initiated and posts its error notice.
    await harness.service.notifyTurnStatus('ses-submit');
    expect(harness.notifyCalls).toHaveLength(1);
    harness.notifyCalls.length = 0;

    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'busy' } },
      },
    });
    await harness.service.notifyTurnStatus('ses-submit');

    expect(harness.notifyCalls).toHaveLength(0);
  });
});

describe('interview remembered/tool state scoping', () => {
  test('an earlier applied state does not mask a malformed latest block', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);

    await harness.service.submitState(
      'ses-submit',
      {
        summary: 'Applied earlier',
        questions: [{ id: 'q-old', question: 'Old?' }],
      },
      'msg-tool',
    );
    harness.messages.push({
      info: { role: 'assistant', id: 'msg-latest' },
      parts: [{ type: 'text', text: blockText('{not valid json') }],
    });

    const state = await harness.service.getInterviewState(interviewId);
    expect(state.mode).toBe('error');
    expect(state.lastParseError).toBe('Failed to parse interview state');
    expect(state.questions.map((question) => question.id)).not.toContain(
      'q-old',
    );
  });

  test('a later poll does not re-apply a block printed over the tool state', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);
    harness.messages.push({
      info: { role: 'assistant', id: 'msg-1' },
      parts: [
        {
          type: 'text',
          text: blockText(
            JSON.stringify({
              summary: 'From text',
              questions: [{ id: 'q-text', question: 'Text?' }],
            }),
          ),
        },
      ],
    });

    const result = await harness.service.submitState(
      'ses-submit',
      {
        summary: 'From tool',
        questions: [{ id: 'q-tool', question: 'Tool?' }],
      },
      'msg-1',
    );
    expect(result.ok).toBe(true);

    const state = await harness.service.getInterviewState(interviewId);
    expect(state.document).toContain('From tool');
    expect(state.document).not.toContain('From text');
    expect(state.questions.map((question) => question.id)).toEqual(['q-tool']);
  });

  test('text.complete skips a block printed in the tool-applied message', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);

    await harness.service.submitState(
      'ses-submit',
      {
        summary: 'Tool state',
        questions: [{ id: 'q-tool', question: 'Tool?' }],
      },
      'msg-1',
    );

    const text = blockText(
      JSON.stringify({
        summary: 'Printed block',
        questions: [{ id: 'q-text', question: 'Text?' }],
      }),
    );
    const stripped = await harness.service.completeInterviewText(
      'ses-submit',
      text,
      'msg-1',
    );
    expect(stripped).not.toContain('<interview_state>');

    const state = await harness.service.getInterviewState(interviewId);
    expect(state.document).toContain('Tool state');
    expect(state.document).not.toContain('Printed block');
  });
});

describe('interview trailing assistant messages after a tool submit', () => {
  test('uses the remembered tool state when every later message has no block', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);

    // Turn 1: the model calls the tool from message M1 ...
    harness.messages.push({
      info: { role: 'assistant', id: 'msg-tool' },
      parts: [{ type: 'text', text: '' }],
    });
    const result = await harness.service.submitState(
      'ses-submit',
      {
        summary: 'Tool spec',
        questions: [{ id: 'q-1', question: 'Platform?' }],
      },
      'msg-tool',
    );
    expect(result.ok).toBe(true);
    // ... then emits trailing prose M2 with no state block.
    harness.messages.push({
      info: { role: 'assistant', id: 'msg-prose' },
      parts: [{ type: 'text', text: 'All set, please answer in the UI.' }],
    });
    // Turn end clears the same-turn tool precedence; the fallback must hold.
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'idle' } },
      },
    });

    const state = await harness.service.getInterviewState(interviewId);
    expect(state.mode).toBe('awaiting-user');
    expect(state.lastParseError).toBeUndefined();
    expect(state.questions).toEqual([
      { id: 'q-1', question: 'Platform?', options: [], suggested: undefined },
    ]);

    await harness.service.submitAnswers(interviewId, [
      { questionId: 'q-1', answer: 'Web' },
    ]);
    expect(harness.continued).toHaveLength(1);
  });

  test('a prose mention of the opening tag does not mask the remembered state', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);

    harness.messages.push({
      info: { role: 'assistant', id: 'msg-tool' },
      parts: [{ type: 'text', text: '' }],
    });
    await harness.service.submitState(
      'ses-submit',
      {
        summary: 'Tool spec',
        questions: [{ id: 'q-1', question: 'Platform?' }],
      },
      'msg-tool',
    );
    harness.messages.push({
      info: { role: 'assistant', id: 'msg-prose' },
      parts: [
        {
          type: 'text',
          text: 'I will not print an <interview_state> block this time.',
        },
      ],
    });

    const state = await harness.service.getInterviewState(interviewId);
    expect(state.mode).toBe('awaiting-user');
    expect(state.lastParseError).toBeUndefined();
    expect(state.questions.map((question) => question.id)).toEqual(['q-1']);
  });

  test('reports a malformed trailing block instead of the remembered state', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);

    harness.messages.push({
      info: { role: 'assistant', id: 'msg-tool' },
      parts: [{ type: 'text', text: '' }],
    });
    await harness.service.submitState(
      'ses-submit',
      {
        summary: 'Tool spec',
        questions: [{ id: 'q-1', question: 'Platform?' }],
      },
      'msg-tool',
    );
    harness.messages.push({
      info: { role: 'assistant', id: 'msg-prose' },
      parts: [{ type: 'text', text: blockText('{not valid json') }],
    });

    const state = await harness.service.getInterviewState(interviewId);
    expect(state.mode).toBe('error');
    expect(state.lastParseError).toBe('Failed to parse interview state');
  });

  test('applies a valid newer block from a later turn', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);

    harness.messages.push({
      info: { role: 'assistant', id: 'msg-tool' },
      parts: [{ type: 'text', text: '' }],
    });
    await harness.service.submitState(
      'ses-submit',
      {
        summary: 'Tool spec',
        questions: [{ id: 'q-tool', question: 'Tool?' }],
      },
      'msg-tool',
    );

    // A later turn resets the same-turn tool precedence and prints a valid
    // block instead of calling the tool.
    await harness.service.handleEvent({
      event: {
        type: 'session.status',
        properties: { sessionID: 'ses-submit', status: { type: 'busy' } },
      },
    });
    harness.messages.push({
      info: { role: 'assistant', id: 'msg-later' },
      parts: [
        {
          type: 'text',
          text: blockText(
            JSON.stringify({
              summary: 'Later text spec',
              questions: [{ id: 'q-later', question: 'Later?' }],
            }),
          ),
        },
      ],
    });

    const state = await harness.service.getInterviewState(interviewId);
    expect(state.document).toContain('Later text spec');
    expect(state.questions.map((question) => question.id)).toEqual(['q-later']);
  });

  test('does not re-offer questions answered before a stateless follow-up turn', async () => {
    const harness = await createHarness();
    const interviewId = await startInterview(harness);

    harness.messages.push({
      info: { role: 'assistant', id: 'msg-tool' },
      parts: [{ type: 'text', text: '' }],
    });
    await harness.service.submitState(
      'ses-submit',
      {
        summary: 'Tool spec',
        questions: [{ id: 'q-1', question: 'Platform?' }],
      },
      'msg-tool',
    );
    harness.messages.push({
      info: { role: 'assistant', id: 'msg-prose' },
      parts: [{ type: 'text', text: 'Answer in the UI.' }],
    });
    await harness.service.submitAnswers(interviewId, [
      { questionId: 'q-1', answer: 'Web' },
    ]);

    // The follow-up turn produces only prose, no new state.
    harness.messages.push({
      info: { role: 'assistant', id: 'msg-followup' },
      parts: [{ type: 'text', text: 'No further questions.' }],
    });

    const state = await harness.service.getInterviewState(interviewId);
    expect(state.questions).toHaveLength(0);
    expect(state.lastParseError).toBeUndefined();
  });
});
