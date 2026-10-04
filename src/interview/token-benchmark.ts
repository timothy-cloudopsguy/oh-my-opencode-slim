import { getEncoding } from 'js-tiktoken';
import { collapseInterviewHistory } from './history';
import {
  buildAnswerPrompt,
  buildBlockCommentPrompt,
  buildKickoffPrompt,
  SPECIFICATION_TEMPLATE_GUIDELINE,
  type SpecPromptContext,
} from './prompts';
import type { InterviewQuestion } from './types';

const encoding = getEncoding('o200k_base');

export const BENCHMARK_ROUNDS = 8;

const QUESTIONS: InterviewQuestion[] = [
  {
    id: 'audience',
    question: 'Who is the primary audience?',
    options: ['Operators', 'Developers'],
    suggested: 'Operators',
  },
];

const SECTION_TITLES = [
  '# Introduction',
  '## 1. Purpose & Scope',
  '## 2. Definitions',
  '## 3. Requirements, Constraints & Guidelines',
  '## 4. Interfaces & Data Contracts',
  '## 5. Acceptance Criteria',
  '## 6. Test Automation Strategy',
  '## 7. Rationale & Context',
  '## 8. Dependencies & External Integrations',
  '## 9. Examples & Edge Cases',
  '## 10. Validation Criteria',
  '## 11. Related Specifications / Further Reading',
];

export interface TokenRound {
  label: string;
  oldInput: number;
  newInput: number;
  oldOutput: number;
  newOutput: number;
}

type BenchMessage = {
  info: { role: string };
  parts: Array<{ type: string; text: string }>;
};

function countTokens(text: string): number {
  return encoding.encode(text).length;
}

function messageText(message: BenchMessage): string {
  return message.parts.map((part) => part.text).join('\n');
}

function transcriptTokens(messages: BenchMessage[], collapse: boolean): number {
  const copy = messages.map((message) => ({
    info: { ...message.info },
    parts: message.parts.map((part) => ({ ...part })),
  }));
  if (collapse) {
    collapseInterviewHistory(copy);
  }
  return countTokens(copy.map(messageText).join('\n'));
}

export function buildBenchmarkSpec(): string {
  return SECTION_TITLES.map((title, index) => {
    const sentence = `Section ${index + 1} records the interface, the constraint, the data contract, and the acceptance check for this specification. `;
    return `${title}\n\n${sentence.repeat(30)}`;
  }).join('\n\n');
}

function legacyAnswerPrompt(round: number): string {
  return [
    'Continue the same interview.',
    SPECIFICATION_TEMPLATE_GUIDELINE,
    'These were the active questions:',
    `1. ${QUESTIONS[0].question}`,
    'The user answered:',
    `${round}. audience: Operators`,
    'Now update the specification summary document and ask the next highest-value clarifying questions.',
    'Return 0 to 2 questions. If there are no more useful questions or the spec is complete, return zero questions.',
    'Return the same <interview_state> JSON block format as before.',
  ].join('\n\n');
}

function legacyCommentPrompt(document: string): string {
  return [
    'You are updating the active interview specification document at "interview/bench-spec.md".',
    'The current document content on disk is:',
    '```markdown',
    document,
    '```',
    'The user submitted specific feedback for the section "3. Requirements, Constraints & Guidelines".',
    'Feedback: Tighten REQ-001.',
    'Include the updated 11-section specification.',
    'Return the same <interview_state> JSON block format as before.',
  ].join('\n');
}

function assistantState(body: Record<string, unknown>): BenchMessage {
  return {
    info: { role: 'assistant' },
    parts: [
      {
        type: 'text',
        text: `<interview_state>\n${JSON.stringify(body)}\n</interview_state>`,
      },
    ],
  };
}

function userMessage(text: string): BenchMessage {
  return {
    info: { role: 'user' },
    parts: [{ type: 'text', text }],
  };
}

const CONTEXT: SpecPromptContext = {
  relativePath: 'interview/bench-spec.md',
  title: 'bench-spec',
  outline: SECTION_TITLES.join('\n'),
};

/**
 * Estimated tokens for one fixed 8-round interview under the old full-spec
 * contract and the patch contract. This is not billed provider usage.
 */
export function measureInterviewContracts(): TokenRound[] {
  const spec = buildBenchmarkSpec();
  const oldMessages: BenchMessage[] = [
    userMessage(buildKickoffPrompt('Benchmark specification', 2)),
  ];
  const newMessages: BenchMessage[] = [
    userMessage(buildKickoffPrompt('Benchmark specification', 2)),
  ];
  const rows: TokenRound[] = [];

  for (let round = 1; round <= BENCHMARK_ROUNDS; round += 1) {
    const oldOutput = assistantState({
      summary: spec,
      title: 'bench-spec',
      questions: QUESTIONS,
    });
    const newOutput =
      round === 1
        ? assistantState({
            summary: spec,
            title: 'bench-spec',
            questions: QUESTIONS,
          })
        : assistantState({
            summary: `Updated section 3 in round ${round}.`,
            patch: [
              '--- a/spec',
              '+++ b/spec',
              '@@ -8,1 +8,1 @@',
              '-Section 3 records the interface, the constraint, the data contract, and the acceptance check for this specification. ',
              `+Section 3 records round ${round} of the interface, the constraint, the data contract, and the acceptance check. `,
            ].join('\n'),
            questions: QUESTIONS,
          });

    rows.push({
      label: String(round),
      oldInput: transcriptTokens(oldMessages, false),
      newInput: transcriptTokens(newMessages, true),
      oldOutput: countTokens(messageText(oldOutput)),
      newOutput: countTokens(messageText(newOutput)),
    });

    oldMessages.push(oldOutput);
    newMessages.push(newOutput);
    if (round < BENCHMARK_ROUNDS) {
      oldMessages.push(userMessage(legacyAnswerPrompt(round)));
      newMessages.push(
        userMessage(
          buildAnswerPrompt(
            [{ questionId: 'audience', answer: 'Operators' }],
            QUESTIONS,
            2,
            CONTEXT,
          ),
        ),
      );
    }
  }

  const document = `# bench-spec\n\n## Current spec\n\n${spec}\n\n## Q&A history\n\nQ: Who is the primary audience?\nA: Operators\n`;
  oldMessages.push(userMessage(legacyCommentPrompt(document)));
  newMessages.push(
    userMessage(
      buildBlockCommentPrompt(
        '3. Requirements, Constraints & Guidelines',
        'Tighten REQ-001.',
        2,
        CONTEXT,
      ),
    ),
  );
  rows.push({
    label: 'comment',
    oldInput: transcriptTokens(oldMessages, false),
    newInput: transcriptTokens(newMessages, true),
    oldOutput: 0,
    newOutput: 0,
  });

  return rows;
}

export function formatTokenTable(rows: TokenRound[]): string {
  const header = [
    'round',
    'old input',
    'new input',
    'input saved',
    'old output',
    'new output',
  ].join(' | ');
  const lines = [
    'Estimated tokens, same fixture, o200k_base, not billed usage.',
    header,
    header.replace(/[^|]/g, '-'),
  ];
  for (const row of rows) {
    const saved =
      row.oldInput === 0
        ? '0%'
        : `${Math.round((1 - row.newInput / row.oldInput) * 100)}%`;
    lines.push(
      [
        row.label,
        String(row.oldInput),
        String(row.newInput),
        saved,
        String(row.oldOutput),
        String(row.newOutput),
      ].join(' | '),
    );
  }
  return lines.join('\n');
}
