/**
 * The hint-word check: an `output` contract reaches the baseline arm as well as the skill arm, so
 * a contract that names something only the skill teaches (an API name) hints the baseline.
 */

import { Option } from '@ngwes/mini-fp';
import { extractCodeBlocks } from '../checks/code-blocks.js';
import { mentions } from '../checks/coverage.js';
import type { SkillSuite } from '../types.js';

const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

const INLINE_CODE = /`([^`\n]+)`/g;

/** A derived vocabulary leaves out identifiers shorter than this. */
const MIN_WORD_LENGTH = 3;

/** TypeScript keywords and built-ins: every task uses them, so they hint nothing. */
const STOP_WORDS = new Set(
  (
    'const let var function return export import from async await new type interface class ' +
    'extends implements string number boolean void null undefined true false any unknown never ' +
    'Promise Array Record Map Set Object Error console'
  ).split(' '),
);

/**
 * One warning for every field of a scenario's `output` contract whose description names a word of
 * the vocabulary that the scenario's task prompt does not use, for each such word. Words are
 * matched as whole words, with the same case. Scenarios in suite order, fields in contract order,
 * words in vocabulary order. A scenario without a contract gives none.
 *
 * `vocabulary` is the words to look for; `null` derives it from the skill: the identifiers in the
 * code blocks and inline code of the skill text, without TypeScript keywords and built-ins and
 * without names shorter than three characters. An explicit `vocabulary` is used as given. The
 * words in `allow` are never reported.
 */
export function contractHints(
  suite: SkillSuite,
  vocabulary: string[] | null,
  allow: string[],
): string[] {
  const allowed = new Set(allow);
  const words = [...new Set(vocabulary ?? skillVocabulary(suite.skillText))].filter(
    (word) => !allowed.has(word),
  );

  return suite.scenarios.flatMap((scenario) => {
    const unused = words.filter((word) => !mentions(scenario.prompt, word));
    return Option.from(scenario.output).match(
      (output) =>
        Object.entries(output).flatMap(([field, description]) =>
          unused
            .filter((word) => mentions(description, word))
            .map(
              (word) =>
                `skill "${suite.name}" / scenario "${scenario.id}": output.${field} names ` +
                `"${word}", which the task prompt does not use. ` +
                'The baseline sees the output contract too, so this hints it.',
            ),
        ),
      () => [],
    );
  });
}

/**
 * The identifiers in a skill's fenced code blocks and inline code spans, each once, without
 * keywords, built-ins and names shorter than three characters (`a`, `x`, `T`, `fn`), which read
 * as ordinary words of a description.
 */
function skillVocabulary(skillText: string): string[] {
  const code = [
    ...extractCodeBlocks(skillText).map((block) => block.code),
    ...Array.from(skillText.matchAll(INLINE_CODE), (span) => span[1]!),
  ];
  const identifiers = code
    .flatMap((text) => text.match(IDENTIFIER) ?? [])
    .filter((word) => word.length >= MIN_WORD_LENGTH && !STOP_WORDS.has(word));
  return [...new Set(identifiers)];
}
