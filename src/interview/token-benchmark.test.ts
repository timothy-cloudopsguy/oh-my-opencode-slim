import { describe, expect, test } from 'bun:test';
import { formatTokenTable, measureInterviewContracts } from './token-benchmark';

describe('interview token benchmark', () => {
  test('round 8 input is at least 70% smaller under the patch contract', () => {
    const rows = measureInterviewContracts();
    console.log(`\n${formatTokenTable(rows)}\n`);

    const round8 = rows.find((row) => row.label === '8');
    expect(round8).toBeDefined();
    if (!round8) {
      return;
    }
    expect(round8.oldInput).toBeGreaterThan(round8.newInput);
    expect(1 - round8.newInput / round8.oldInput).toBeGreaterThanOrEqual(0.7);
    expect(round8.newOutput).toBeLessThan(round8.oldOutput / 2);
  });
});
