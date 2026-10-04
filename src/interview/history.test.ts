import { describe, expect, test } from 'bun:test';
import { collapseInterviewHistory, INTERVIEW_SUMMARY_STUB } from './history';

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
});
