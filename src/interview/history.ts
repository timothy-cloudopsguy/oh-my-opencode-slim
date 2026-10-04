import { locateInterviewStateBlocks, parseInterviewStateJson } from './parser';

export const INTERVIEW_SUMMARY_STUB =
  'Previous spec omitted. The current spec is on disk.';

type TextPart = { text: string };

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

/**
 * Replace every assistant `<interview_state>` summary except the latest with
 * a one-line stub. User prompts are left alone so the format example stays
 * intact. Mutates the message objects that will be sent to the model.
 */
export function collapseInterviewHistory(
  messages: Array<{
    info?: { role?: string };
    parts?: Array<{ text?: string }>;
  }>,
): void {
  const locations: BlockLocation[] = [];
  for (const message of messages) {
    if (message.info?.role !== 'assistant') {
      continue;
    }
    for (const part of message.parts ?? []) {
      if (
        typeof part.text !== 'string' ||
        !part.text.includes('<interview_state')
      ) {
        continue;
      }
      locations.push(...collectBlocks(part as TextPart));
    }
  }
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
