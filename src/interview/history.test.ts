import { describe, expect, test } from 'bun:test';
import { collapseInterviewHistory, INTERVIEW_SUMMARY_STUB } from './history';

type SubmitPart = {
  type: string;
  tool: string;
  callID: string;
  state: {
    status: string;
    input: { state: Record<string, unknown> };
    output: string;
  };
};

function toolTurn(id: string, summary: string, patch?: string) {
  const state: Record<string, unknown> = {
    title: 'spec',
    summary,
    questions: [],
  };
  if (patch !== undefined) {
    state.patch = patch;
  }
  const part: SubmitPart = {
    type: 'tool',
    tool: 'interview_submit_state',
    callID: id,
    state: {
      status: 'completed',
      input: { state },
      output: 'ok',
    },
  };
  return { info: { role: 'assistant' }, parts: [part] };
}

function submitParts(messages: Array<{ parts?: unknown[] }>): SubmitPart[] {
  const result: SubmitPart[] = [];
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (
        part &&
        typeof part === 'object' &&
        (part as SubmitPart).tool === 'interview_submit_state'
      ) {
        result.push(part as SubmitPart);
      }
    }
  }
  return result;
}

describe('collapseInterviewHistory', () => {
  test('stubs older assistant specs and leaves the latest plus user prompts', () => {
    const kickoff = {
      info: { role: 'user' },
      parts: [
        {
          type: 'text',
          text: 'Format example <interview_state>{"summary":"Full specification markdown","questions":[]}</interview_state>',
        },
      ],
    };
    const first = {
      info: { role: 'assistant' },
      parts: [
        {
          type: 'text',
          text: '<interview_state>{"summary":"FULL SPEC ONE","questions":[]}</interview_state>',
        },
      ],
    };
    const second = {
      info: { role: 'assistant' },
      parts: [
        {
          type: 'text',
          text: '<interview_state>{"summary":"short status","patch":"@@ -1 +1 @@\\n-a\\n+b","questions":[]}</interview_state>',
        },
      ],
    };

    collapseInterviewHistory([kickoff, first, second]);

    expect(kickoff.parts[0].text).toContain('Full specification markdown');
    expect(first.parts[0].text).toContain(INTERVIEW_SUMMARY_STUB);
    expect(first.parts[0].text).not.toContain('FULL SPEC ONE');
    expect(second.parts[0].text).toContain('short status');
    expect(second.parts[0].text).toContain('patch');
  });

  test('stubs older interview_submit_state inputs and keeps the latest full', () => {
    const first = toolTurn('c1', 'FULL SPEC ONE', '@@ -1 +1 @@\n-a\n+b');
    const second = toolTurn('c2', 'status two', '@@ -2 +2 @@\n-c\n+d');
    const third = toolTurn('c3', 'status three', '@@ -3 +3 @@\n-e\n+f');

    collapseInterviewHistory([first, second, third]);

    const parts = submitParts([first, second, third]);
    expect(parts.map((part) => part.state.input.state.summary)).toEqual([
      INTERVIEW_SUMMARY_STUB,
      INTERVIEW_SUMMARY_STUB,
      'status three',
    ]);
    expect('patch' in parts[0].state.input.state).toBe(false);
    expect('patch' in parts[1].state.input.state).toBe(false);
    expect(parts[2].state.input.state.patch).toBe('@@ -3 +3 @@\n-e\n+f');
    // Non-stubbed fields survive on older calls.
    expect(parts[0].state.input.state.title).toBe('spec');
    expect(parts[0].state.input.state.questions).toEqual([]);
  });

  test('is idempotent when applied repeatedly', () => {
    const messages = [
      toolTurn('c1', 'FULL SPEC ONE', '@@ -1 +1 @@\n-a\n+b'),
      toolTurn('c2', 'status two', '@@ -2 +2 @@\n-c\n+d'),
      toolTurn('c3', 'status three', '@@ -3 +3 @@\n-e\n+f'),
    ];

    collapseInterviewHistory(messages);
    const once = JSON.stringify(messages);
    collapseInterviewHistory(messages);
    expect(JSON.stringify(messages)).toBe(once);
  });

  test('leaves non-interview tool parts untouched', () => {
    const readPart = {
      type: 'tool',
      tool: 'read',
      callID: 'r1',
      state: {
        status: 'completed',
        input: { filePath: '/tmp/spec.md' },
        output: '{"ok":true}',
      },
    };
    const taskPart = {
      type: 'tool',
      tool: 'task',
      callID: 't1',
      state: {
        status: 'completed',
        input: { description: 'do work', subagent_type: 'fixer' },
        output: 'done',
      },
    };
    const before = JSON.stringify([readPart, taskPart]);

    collapseInterviewHistory([
      { info: { role: 'assistant' }, parts: [readPart, taskPart] },
    ]);

    expect(JSON.stringify([readPart, taskPart])).toBe(before);
  });

  test('ignores malformed interview_submit_state input shapes', () => {
    const stringInput = {
      type: 'tool',
      tool: 'interview_submit_state',
      callID: 'bad1',
      state: { status: 'completed', input: 'not-an-object', output: 'x' },
    };
    const noState = {
      type: 'tool',
      tool: 'interview_submit_state',
      callID: 'bad2',
      state: { status: 'pending' },
    };
    const arrState = {
      type: 'tool',
      tool: 'interview_submit_state',
      callID: 'bad3',
      state: { status: 'completed', input: { state: [1, 2, 3] } },
    };
    const before = JSON.stringify([stringInput, noState, arrState]);

    collapseInterviewHistory([
      {
        info: { role: 'assistant' },
        parts: [stringInput, noState, arrState],
      },
    ]);

    expect(JSON.stringify([stringInput, noState, arrState])).toBe(before);
  });
});

// A deterministic LCG so a generated history is reproducible from its seed.
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function buildGeneratedHistory(seed: number): unknown[] {
  const random = createRandom(seed);
  const messages: unknown[] = [];
  for (let turn = 0; turn < 10; turn += 1) {
    const roll = random();
    if (roll < 0.4) {
      messages.push(
        toolTurn(`t${seed}-${turn}`, `summary ${turn}`, `patch ${turn}`),
      );
    } else if (roll < 0.65) {
      messages.push({
        info: { role: 'assistant' },
        parts: [
          {
            type: 'text',
            text: `<interview_state>{"summary":"text summary ${turn}","questions":[]}</interview_state>`,
          },
        ],
      });
    } else if (roll < 0.8) {
      messages.push({
        info: { role: 'user' },
        parts: [{ type: 'text', text: `question ${turn}` }],
      });
    } else {
      messages.push({
        info: { role: 'assistant' },
        parts: [
          {
            type: 'tool',
            tool: 'read',
            callID: `r${seed}-${turn}`,
            state: {
              status: 'completed',
              input: { filePath: `/tmp/${turn}.md` },
              output: 'ok',
            },
          },
        ],
      });
    }
  }
  return messages;
}

describe('collapseInterviewHistory properties', () => {
  test('is deterministic and idempotent across generated histories', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const left = buildGeneratedHistory(seed);
      const right = buildGeneratedHistory(seed);

      collapseInterviewHistory(left);
      collapseInterviewHistory(right);
      expect(JSON.stringify(left)).toBe(JSON.stringify(right));

      const once = JSON.stringify(left);
      collapseInterviewHistory(left);
      expect(JSON.stringify(left)).toBe(once);

      // At most the latest submit call keeps a patch; every other one is
      // stubbed, so no full spec is re-sent.
      const submits = submitParts(left as Array<{ parts?: unknown[] }>);
      for (const [index, part] of submits.entries()) {
        const args = part.state.input.state;
        if (index === submits.length - 1) {
          expect(typeof args.patch).toBe('string');
        } else {
          expect(args.summary).toBe(INTERVIEW_SUMMARY_STUB);
          expect('patch' in args).toBe(false);
        }
      }
    }
  });
});
