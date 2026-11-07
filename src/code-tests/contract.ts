/**
 * The answer-format paragraph both arms receive when a scenario has an `output` contract, and the
 * prompts that carry it. The paragraph is the same text in both arms and it follows the whole
 * prompt: it never enters the skill text.
 */

import { Option } from '@ngwes/mini-fp';
import { fillTemplate } from '../runner.js';
import type { Scenario } from '../types.js';

/**
 * The paragraph that tells the model how to answer: one TypeScript code block, a complete ES
 * module exporting the contract's names. One line per field, in contract order.
 */
export function contractParagraph(output: Record<string, string>): string {
  const fields = Object.entries(output).map(
    ([name, description]) => `- \`${name}\`: ${description}`,
  );
  return [
    'Answer format: reply with exactly one TypeScript code block. ' +
      'The code must be a complete ES module that exports these names:',
    ...fields,
  ].join('\n');
}

/**
 * The prompts both arms send: the scenario's task alone (baseline) and the task inside the
 * with-skill template (with skill). A scenario with a contract gets the paragraph after each,
 * after the filled template as a whole; one without gets exactly the prompt it has always had.
 */
export function armPrompts(
  withSkillTemplate: string,
  skillText: string,
  scenario: Scenario,
): { baseline: string; withSkill: string } {
  const baseline = scenario.prompt;
  const withSkill = fillTemplate(withSkillTemplate, skillText, scenario.prompt);
  return Option.from(scenario.output).match(
    (output) => {
      const paragraph = contractParagraph(output);
      return { baseline: `${baseline}\n\n${paragraph}`, withSkill: `${withSkill}\n\n${paragraph}` };
    },
    () => ({ baseline, withSkill }),
  );
}
