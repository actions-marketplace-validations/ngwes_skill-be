import { describe, expect, it } from 'vitest';
import { armPrompts, contractParagraph } from '../src/code-tests/contract.js';
import { fillTemplate } from '../src/runner.js';
import type { Scenario } from '../src/types.js';

const TEMPLATE = 'SKILL<{{skill}}>\nTASK<{{task}}>';

const scenario = (output: Record<string, string> | null): Scenario => ({
  id: 's1',
  critical: false,
  prompt: 'Write the thing.',
  criteria: [],
  output,
  tests: [],
});

const CONTRACT = { result: 'the computed value', reason: 'one sentence on why' };

describe('contractParagraph', () => {
  it('writes one line per field, in contract order', () => {
    expect(contractParagraph(CONTRACT)).toBe(
      'Answer format: reply with exactly one TypeScript code block. ' +
        'The code must be a complete ES module that exports these names:\n' +
        '- `result`: the computed value\n' +
        '- `reason`: one sentence on why',
    );
  });

  it('keeps the contract order, not alphabetical order', () => {
    const lines = contractParagraph({ zeta: 'last letter', alpha: 'first letter' }).split('\n');
    expect(lines.slice(1)).toEqual(['- `zeta`: last letter', '- `alpha`: first letter']);
  });
});

describe('armPrompts', () => {
  it('ends both arms with the same paragraph', () => {
    const paragraph = contractParagraph(CONTRACT);
    const { baseline, withSkill } = armPrompts(TEMPLATE, 'the skill', scenario(CONTRACT));

    expect(baseline).toBe(`Write the thing.\n\n${paragraph}`);
    expect(withSkill).toBe(`SKILL<the skill>\nTASK<Write the thing.>\n\n${paragraph}`);
    expect(baseline.endsWith(paragraph)).toBe(true);
    expect(withSkill.endsWith(paragraph)).toBe(true);
  });

  it("sends today's prompts when the scenario has no contract", () => {
    const task = scenario(null);

    expect(armPrompts(TEMPLATE, 'the skill', task)).toEqual({
      baseline: task.prompt,
      withSkill: fillTemplate(TEMPLATE, 'the skill', task.prompt),
    });
  });

  it('never puts the paragraph inside the skill text', () => {
    const paragraph = contractParagraph(CONTRACT);
    const { withSkill } = armPrompts('{{task}}\n---\n{{skill}}', 'the skill', scenario(CONTRACT));

    expect(withSkill).toBe(`Write the thing.\n---\nthe skill\n\n${paragraph}`);
    expect(withSkill.indexOf(paragraph)).toBe(withSkill.lastIndexOf(paragraph));
    expect(withSkill.indexOf(paragraph)).toBeGreaterThan(withSkill.indexOf('the skill'));
  });
});
