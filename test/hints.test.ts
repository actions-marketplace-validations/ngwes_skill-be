import { describe, expect, it } from 'vitest';
import { contractHints } from '../src/code-tests/hints.js';
import type { Scenario, SkillSuite } from '../src/types.js';

const scenario = (overrides: Partial<Scenario> = {}): Scenario => ({
  id: 's1',
  critical: false,
  prompt: 'Write a function that parses the input.',
  criteria: [],
  output: { result: 'the value, built with matchAsync' },
  tests: [],
  ...overrides,
});

const suite = (scenarios: Scenario[], skillText = '# A skill'): SkillSuite => ({
  name: 'box',
  skillPath: '/skills/box/SKILL.md',
  skillText,
  evalPath: '/evals/box.json',
  scenarios,
  testFiles: {},
  codeFiles: [],
  packageList: null,
});

const warning = (field: string, word: string, id = 's1'): string =>
  `skill "box" / scenario "${id}": output.${field} names "${word}", ` +
  'which the task prompt does not use. The baseline sees the output contract too, ' +
  'so this hints it.';

describe('contractHints', () => {
  it('warns on an API name the prompt does not use', () => {
    const hints = contractHints(suite([scenario()]), ['matchAsync'], []);

    expect(hints).toEqual([warning('result', 'matchAsync')]);
  });

  it('stays quiet when the prompt already uses the word', () => {
    const task = scenario({ prompt: 'Handle both cases with matchAsync.' });

    expect(contractHints(suite([task]), ['matchAsync'], [])).toEqual([]);
  });

  it('respects the allow list', () => {
    const hints = contractHints(suite([scenario()]), ['matchAsync'], ['matchAsync']);

    expect(hints).toEqual([]);
  });

  it('matches whole words only', () => {
    const task = scenario({
      output: { result: 'the combined result', other: 'one that does combine' },
    });

    const hints = contractHints(suite([task]), ['combine'], []);

    expect(hints).toEqual([warning('other', 'combine')]);
  });

  it('is case sensitive', () => {
    const task = scenario({ output: { result: 'Validate the shape' } });

    expect(contractHints(suite([task]), ['validate'], [])).toEqual([]);
  });

  it('derives the vocabulary from the skill code when none is given', () => {
    const skillText = [
      '# Box',
      'Wrap values with `liftValue` before use.',
      '',
      '```ts',
      'const boxed = unwrapBox(value);',
      '```',
    ].join('\n');
    const task = scenario({
      output: { result: 'the result of unwrapBox', note: 'prefer liftValue over a loop' },
    });

    const hints = contractHints(suite([task], skillText), null, []);

    expect(hints).toEqual([warning('result', 'unwrapBox'), warning('note', 'liftValue')]);
  });

  it('leaves the prose of the skill text out of the derived vocabulary', () => {
    const skillText = 'Always prefer immutability.\n\n```ts\nconst boxed = 1;\n```';
    const task = scenario({ output: { result: 'prefer immutability, return a plain value' } });

    expect(contractHints(suite([task], skillText), null, [])).toEqual([]);
  });

  it('ignores keywords and built-ins', () => {
    const skillText = '```ts\nasync function load(): Promise<string> { return await go(); }\n```';
    const task = scenario({ output: { result: 'a Promise of a string, from an async function' } });

    expect(contractHints(suite([task], skillText), null, [])).toEqual([]);
  });

  it('ignores identifiers shorter than three characters in a derived vocabulary', () => {
    const skillText = '```ts\nconst a = 1;\n```\n\nCall `x` first.';
    // The prompt has neither word, so only the length filter keeps "a" and "x" quiet.
    const task = scenario({
      prompt: 'Parse the input.',
      output: { result: 'a value, plus x' },
    });

    expect(contractHints(suite([task], skillText), null, [])).toEqual([]);
  });

  it('does not filter an explicit vocabulary by length', () => {
    const task = scenario({ prompt: 'Parse the input.', output: { result: 'a value, plus x' } });

    const hints = contractHints(suite([task]), ['x'], []);

    expect(hints).toEqual([warning('result', 'x')]);
  });

  it('keeps a word the vocabulary names even when it is a keyword or built-in', () => {
    const task = scenario({ output: { result: 'a Promise of the value' } });

    expect(contractHints(suite([task]), ['Promise'], [])).toEqual([warning('result', 'Promise')]);
  });

  it('drops the words of the prompt and of the allow list when deriving the vocabulary', () => {
    const skillText = '`first` `second` `third`';
    const task = scenario({
      prompt: 'Use first.',
      output: { result: 'first, second and third' },
    });

    const hints = contractHints(suite([task], skillText), null, ['second']);

    expect(hints).toEqual([warning('result', 'third')]);
  });

  it('warns once per scenario, field and word, in contract order', () => {
    const first = scenario({
      id: 'a',
      output: { one: 'uses beta and alpha', two: 'alpha again, alpha' },
    });
    const second = scenario({ id: 'b', output: { three: 'beta' } });

    const hints = contractHints(suite([first, second]), ['alpha', 'beta', 'alpha'], []);

    expect(hints).toEqual([
      warning('one', 'alpha', 'a'),
      warning('one', 'beta', 'a'),
      warning('two', 'alpha', 'a'),
      warning('three', 'beta', 'b'),
    ]);
  });

  it('checks each scenario against its own prompt', () => {
    const quiet = scenario({ id: 'a', prompt: 'Use matchAsync.' });
    const loud = scenario({ id: 'b', prompt: 'Use something else.' });

    const hints = contractHints(suite([quiet, loud]), ['matchAsync'], []);

    expect(hints).toEqual([warning('result', 'matchAsync', 'b')]);
  });

  it('skips a scenario without an output contract', () => {
    const judged = scenario({ output: null, criteria: ['uses matchAsync'] });

    expect(contractHints(suite([judged]), ['matchAsync'], [])).toEqual([]);
  });
});
