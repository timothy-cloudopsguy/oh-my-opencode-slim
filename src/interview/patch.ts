export class InterviewPatchApplyError extends Error {
  constructor(
    readonly failedHunk: string,
    readonly contextWindow: string,
  ) {
    super('Interview spec patch did not apply');
    this.name = 'InterviewPatchApplyError';
  }
}

type HunkLine = { kind: ' ' | '+' | '-'; text: string };

type Hunk = {
  raw: string;
  oldStart: number;
  lines: HunkLine[];
};

export type PatchApplyResult =
  | { ok: true; text: string }
  | { ok: false; failedHunk: string; contextWindow: string };

const CONTEXT_RADIUS = 10;

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split('\n');
  if (text.endsWith('\n')) {
    lines.pop();
  }
  return lines;
}

function parseHunks(patch: string): Hunk[] | { failedHunk: string } {
  const rawLines = patch.replace(/\r\n/g, '\n').split('\n');
  const hunks: Hunk[] = [];
  let current: { header: string; oldStart: number; body: string[] } | null =
    null;

  const flush = (): { failedHunk: string } | null => {
    if (!current) {
      return null;
    }
    const lines: HunkLine[] = [];
    for (const line of current.body) {
      if (line.length === 0 || line.startsWith('\\')) {
        continue;
      }
      const kind = line[0];
      if (kind !== ' ' && kind !== '+' && kind !== '-') {
        return {
          failedHunk: [current.header, ...current.body].join('\n'),
        };
      }
      lines.push({ kind, text: line.slice(1) });
    }
    if (lines.length > 0) {
      hunks.push({
        raw: [current.header, ...current.body].join('\n'),
        oldStart: current.oldStart,
        lines,
      });
    }
    current = null;
    return null;
  };

  for (const line of rawLines) {
    const header = line.match(HUNK_HEADER);
    if (header) {
      const failed = flush();
      if (failed) {
        return failed;
      }
      current = { header: line, oldStart: Number(header[1]), body: [] };
      continue;
    }
    if (current) {
      current.body.push(line);
    }
  }
  const failed = flush();
  if (failed) {
    return failed;
  }
  return hunks;
}

function matchesAt(lines: string[], needle: string[], index: number): boolean {
  if (index < 0 || index + needle.length > lines.length) {
    return false;
  }
  for (let offset = 0; offset < needle.length; offset += 1) {
    if (lines[index + offset] !== needle[offset]) {
      return false;
    }
  }
  return true;
}

function contextAround(lines: string[], center: number): string {
  const start = Math.max(0, Math.min(center, lines.length) - CONTEXT_RADIUS);
  const end = Math.min(lines.length, start + CONTEXT_RADIUS * 2);
  return lines.slice(start, end).join('\n');
}

function deletedLines(hunk: Hunk): string[] {
  return hunk.lines
    .filter((line) => line.kind === '-')
    .map((line) => line.text);
}

function addedRuns(hunk: Hunk): string[][] {
  const runs: string[][] = [];
  let current: string[] = [];
  for (const line of hunk.lines) {
    if (line.kind === '+') {
      current.push(line.text);
    } else if (current.length > 0) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    runs.push(current);
  }
  return runs;
}

/**
 * A miss is the already-applied case when every deleted line is gone and
 * every added run is already contiguous in the file.
 */
function hunkAlreadyApplied(lines: string[], hunk: Hunk): boolean {
  const deleted = deletedLines(hunk);
  const runs = addedRuns(hunk);
  if (deleted.length === 0 && runs.length === 0) {
    return false;
  }
  if (deleted.some((line) => lines.includes(line))) {
    return false;
  }
  return runs.every((run) => findSequence(lines, run, 0, 0) >= 0);
}

function findSequence(
  lines: string[],
  needle: string[],
  hint: number,
  min: number,
): number {
  if (needle.length === 0) {
    return Math.min(Math.max(hint, min), lines.length);
  }
  if (matchesAt(lines, needle, hint)) {
    return hint;
  }
  const last = lines.length - needle.length;
  for (let index = min; index <= last; index += 1) {
    if (index !== hint && matchesAt(lines, needle, index)) {
      return index;
    }
  }
  return -1;
}

/** Apply a unified diff to the current spec body. Frontmatter is not part of `source`. */
export function applyUnifiedDiff(
  source: string,
  patch: string,
): PatchApplyResult {
  const parsed = parseHunks(patch);
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      failedHunk: parsed.failedHunk,
      contextWindow: '',
    };
  }
  if (parsed.length === 0) {
    return {
      ok: false,
      failedHunk: patch.trim() || '(empty patch)',
      contextWindow: '',
    };
  }

  const trailingNewline = source.endsWith('\n');
  let lines = splitLines(source);
  let searchFrom = 0;

  for (const hunk of parsed) {
    const oldLines = hunk.lines
      .filter((line) => line.kind !== '+')
      .map((line) => line.text);
    const newLines = hunk.lines
      .filter((line) => line.kind !== '-')
      .map((line) => line.text);
    const hinted = Math.max(0, hunk.oldStart - 1);
    let index = findSequence(lines, oldLines, hinted, searchFrom);
    if (index < 0) {
      index = findSequence(lines, oldLines, 0, 0);
    }
    if (index < 0 || hunkAlreadyApplied(lines, hunk)) {
      if (hunkAlreadyApplied(lines, hunk)) {
        const firstRun = addedRuns(hunk)[0];
        const located = firstRun
          ? findSequence(lines, firstRun, Math.max(index, 0), searchFrom)
          : Math.max(index, searchFrom);
        searchFrom =
          located >= 0 ? located + (firstRun?.length ?? 0) : searchFrom;
        continue;
      }
      return {
        ok: false,
        failedHunk: hunk.raw,
        contextWindow: contextAround(lines, hinted),
      };
    }
    lines = [
      ...lines.slice(0, index),
      ...newLines,
      ...lines.slice(index + oldLines.length),
    ];
    searchFrom = index + newLines.length;
  }

  const text = lines.join('\n');
  return {
    ok: true,
    text: trailingNewline && text.length > 0 ? `${text}\n` : text,
  };
}
