/**
 * The lines a scenario is scored on: its judge criteria, then its code tests. The runner scores
 * them in this order, and the gate, the reports and the summary read the scores in it.
 */

import type { Scenario } from './types.js';

/** The label of a test line starts with it, so a test line can be told apart from a criterion. */
export const TEST_LINE_PREFIX = '[test] ';

/** The judge criteria, then one line per test, labelled `[test] <name>`. */
export function scoredLines(scenario: Scenario): string[] {
  return [...scenario.criteria, ...scenario.tests.map((name) => `${TEST_LINE_PREFIX}${name}`)];
}
