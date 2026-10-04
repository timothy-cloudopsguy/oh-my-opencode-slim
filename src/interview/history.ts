import { locateInterviewStateBlocks, parseInterviewStateJson } from './parser';

export const INTERVIEW_SUMMARY_STUB =
  'Previous spec omitted. The current spec is on disk.';

const INTERVIEW_SUBMIT_TOOL = 'interview_submit_state';

type TextPart = { text: string };

type HistoryPart = {
  type?: string;
  text?: string;
  tool?: unknown;
  state?: unknown;
};

type HistoryMessage = {
  info?: { role?: string };
  parts?: HistoryPart[];
};

type BlockLocation = {
  part: TextPart;
  start: number;
  end: number;
  json: string;
};

function collectBlocks(part: TextPart): BlockLocation[] {
  return locateInterviewStateBlocks(part.text).map((block) => ({
    part,
    start: block.start,
    end: block.end,
    json: block.json,
  }));
}

function stubBlock(json: string): string {
  const parsed = parseInterviewStateJson(json);
  if (!parsed) {
    return `<interview_state>\n${json.trim()}\n</interview_state>`;
  }
  if (typeof parsed.summary === 'string') {
    parsed.summary = INTERVIEW_SUMMARY_STUB;
  }
  return `<interview_state>\n${JSON.stringify(parsed)}\n</interview_state>`;
}

function collapseTextBlocks(locations: BlockLocation[]): void {
  if (locations.length <= 1) {
    return;
  }

  const stale = locations.slice(0, -1);
  const byPart = new Map<TextPart, BlockLocation[]>();
  for (const location of stale) {
    const group = byPart.get(location.part) ?? [];
    group.push(location);
    byPart.set(location.part, group);
  }

  for (const [part, group] of byPart) {
    const ordered = [...group].sort((left, right) => right.start - left.start);
    for (const location of ordered) {
      part.text =
        part.text.slice(0, location.start) +
        stubBlock(location.json) +
        part.text.slice(location.end);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isInterviewSubmitPart(part: HistoryPart): boolean {
  return (
    part.type === 'tool' &&
    typeof part.tool === 'string' &&
    part.tool === INTERVIEW_SUBMIT_TOOL
  );
}

/**
 * Stub the `summary` and `patch` of an older `interview_submit_state` call.
 * `patch` is removed rather than blanked so a second pass finds nothing to
 * strip, keeping the transform idempotent. The title and questions are small
 * and stay intact.
 */
function stubToolState(part: HistoryPart): void {
  const toolState = asRecord(part.state);
  const input = toolState ? asRecord(toolState.input) : null;
  const args = input ? asRecord(input.state) : null;
  if (!args) {
    return;
  }
  if (typeof args.summary === 'string') {
    args.summary = INTERVIEW_SUMMARY_STUB;
  }
  if ('patch' in args) {
    delete args.patch;
  }
}

/**
 * Replace every assistant `<interview_state>` summary except the latest with
 * a one-line stub, and stub the `summary`/`patch` input of every older
 * `interview_submit_state` tool call. User prompts are left alone so the
 * format example stays intact. Mutates the message objects that will be sent
 * to the model. Deterministic and idempotent: a second pass is a no-op.
 */
export function collapseInterviewHistory(messages: HistoryMessage[]): void {
  const textLocations: BlockLocation[] = [];
  const toolParts: HistoryPart[] = [];

  for (const message of messages) {
    if (message.info?.role !== 'assistant') {
      continue;
    }
    for (const part of message.parts ?? []) {
      if (
        typeof part.text === 'string' &&
        part.text.includes('<interview_state')
      ) {
        textLocations.push(...collectBlocks(part as TextPart));
      }
      if (isInterviewSubmitPart(part)) {
        toolParts.push(part);
      }
    }
  }

  collapseTextBlocks(textLocations);

  for (const part of toolParts.slice(0, -1)) {
    stubToolState(part);
  }
}
