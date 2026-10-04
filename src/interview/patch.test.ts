import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractSpecOutline, rewriteInterviewDocument } from './document';
import firstTurn from './fixtures/first-applied-turn.json';
import { applyUnifiedDiff, InterviewPatchApplyError } from './patch';
import type { InterviewRecord } from './types';

const SOURCE = [
  '# Introduction',
  '',
  'alpha',
  '',
  '## 1. Purpose & Scope',
  '',
  'keep',
].join('\n');

describe('applyUnifiedDiff', () => {
  test('replaces a matching line and keeps the surrounding spec', () => {
    const patch = [
      '--- a/spec',
      '+++ b/spec',
      '@@ -1,7 +1,7 @@',
      ' # Introduction',
      ' ',
      '-alpha',
      '+beta',
      ' ',
      ' ## 1. Purpose & Scope',
      ' ',
      ' keep',
    ].join('\n');

    const applied = applyUnifiedDiff(SOURCE, patch);
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.text).toContain('beta');
      expect(applied.text).not.toContain('alpha');
      expect(applied.text).toContain('## 1. Purpose & Scope');
    }
  });

  test('returns the failed hunk when context is missing', () => {
    const patch = ['@@ -1,3 +1,3 @@', ' missing', '-nope', '+yep'].join('\n');
    const applied = applyUnifiedDiff(SOURCE, patch);
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.failedHunk).toContain('-nope');
    }
  });

  test('rejects a payload that is not a unified diff', () => {
    const applied = applyUnifiedDiff(SOURCE, 'just the whole spec again');
    expect(applied.ok).toBe(false);
  });
});

describe('rewriteInterviewDocument', () => {
  test('applies a patch onto the current spec and leaves Q&A history alone', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'interview-patch-'),
    );
    const record: InterviewRecord = {
      id: 'interview-1',
      sessionID: 'session-1',
      idea: 'Patch idea',
      markdownPath: path.join(directory, 'spec.md'),
      createdAt: new Date().toISOString(),
      status: 'active',
      baseMessageCount: 0,
    };

    await rewriteInterviewDocument(record, SOURCE, 'patch-idea');
    const patched = await rewriteInterviewDocument(
      record,
      'Updated the introduction.',
      undefined,
      ['@@ -3,1 +3,1 @@', '-alpha', '+beta'].join('\n'),
    );

    expect(patched).toContain('beta');
    expect(patched).not.toContain('\nalpha\n');
    expect(patched).toContain('## Q&A history');
    expect(patched).not.toContain('Updated the introduction.');
    await fs.rm(directory, { recursive: true, force: true });
  });

  test('does not write a short status when the patch fails', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'interview-patch-'),
    );
    const record: InterviewRecord = {
      id: 'interview-2',
      sessionID: 'session-2',
      idea: 'Patch idea',
      markdownPath: path.join(directory, 'spec.md'),
      createdAt: new Date().toISOString(),
      status: 'active',
      baseMessageCount: 0,
    };
    await rewriteInterviewDocument(record, SOURCE);

    await expect(
      rewriteInterviewDocument(
        record,
        'status only',
        undefined,
        '@@ -1,1 +1,1 @@\n-missing\n+nope',
      ),
    ).rejects.toBeInstanceOf(InterviewPatchApplyError);

    const saved = await fs.readFile(record.markdownPath, 'utf8');
    expect(saved).toContain('alpha');
    expect(saved).not.toContain('status only');
    await fs.rm(directory, { recursive: true, force: true });
  });

  test('keeps the current spec when patch is explicitly empty', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'interview-patch-'),
    );
    const record: InterviewRecord = {
      id: 'interview-3',
      sessionID: 'session-3',
      idea: 'Patch idea',
      markdownPath: path.join(directory, 'spec.md'),
      createdAt: new Date().toISOString(),
      status: 'active',
      baseMessageCount: 0,
    };
    await rewriteInterviewDocument(record, SOURCE);
    const next = await rewriteInterviewDocument(
      record,
      'No spec change.',
      undefined,
      '',
    );
    expect(next).toContain('alpha');
    expect(next).not.toContain('No spec change.');
    expect(extractSpecOutline(SOURCE)).toContain('## 1. Purpose & Scope');
    await fs.rm(directory, { recursive: true, force: true });
  });
});

describe('already applied hunks', () => {
  test('a miss stays a miss when the added lines are absent', () => {
    const applied = applyUnifiedDiff(
      'other\n',
      '@@ -1,1 +1,1 @@\n-missing\n+added-run',
    );
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.contextWindow.split('\n').length).toBeLessThanOrEqual(20);
    }
  });

  test('a miss is success when deletions are gone and additions are contiguous', () => {
    const patch = [
      '@@ -1,3 +1,3 @@',
      ' # Introduction',
      ' ',
      '-alpha',
      '+beta',
    ].join('\n');
    const once = applyUnifiedDiff(SOURCE, patch);
    expect(once.ok).toBe(true);
    if (!once.ok) {
      return;
    }
    const twice = applyUnifiedDiff(once.text, patch);
    expect(twice.ok).toBe(true);
    if (twice.ok) {
      expect(twice.text).toContain('beta');
      expect(twice.text).not.toContain('alpha');
    }
  });

  test('reports about 20 lines around the mismatch', () => {
    const lines = Array.from({ length: 80 }, (_, index) => `line-${index}`);
    const applied = applyUnifiedDiff(
      lines.join('\n'),
      '@@ -1,1 +1,1 @@\n-missing\n+nope',
    );
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      const windowLines = applied.contextWindow.split('\n');
      expect(windowLines.length).toBeLessThanOrEqual(20);
      expect(applied.contextWindow).toContain('line-0');
      expect(applied.contextWindow).not.toContain('line-40');
    }
  });

  test('the session first multi-hunk patch applies once, then again', () => {
    const once = applyUnifiedDiff(firstTurn.summary, firstTurn.patch);
    expect(once.ok).toBe(true);
    if (!once.ok) {
      return;
    }
    expect(once.text).toContain(
      'If more than one properties file exists for the same env',
    );
    expect(once.text).not.toContain(
      'The precedence or error policy is still TBD',
    );
    const pyyaml = once.text
      .split('\n')
      .filter((line) => line.includes('PyYAML as a required dependency'));
    expect(pyyaml).toHaveLength(1);
    const twice = applyUnifiedDiff(once.text, firstTurn.patch);
    expect(twice.ok).toBe(true);
    if (twice.ok) {
      expect(twice.text).toBe(once.text);
    }
  });
});
