/**
 * The model's answer as code: the code block taken from its reply, and TypeScript turned into the
 * JavaScript that runs. Nothing is type-checked: a type error in an answer or in a test does not
 * stop it from running.
 */

import { Option } from '@ngwes/mini-fp';
import { extractCodeBlocks } from '../checks/code-blocks.js';
import type { TypeScript } from '../checks/typescript.js';

/** The languages a code block may be in to count as the answer. */
export const ANSWER_LANGUAGES = ['ts', 'typescript', 'js', 'javascript'];

/** The code of the last block of the output in an accepted language; `null` when it has none. */
export function extractAnswer(output: string): string | null {
  const blocks = extractCodeBlocks(output).filter((block) => ANSWER_LANGUAGES.includes(block.lang));
  return Option.from(blocks[blocks.length - 1]).match(
    (block) => block.code,
    () => null,
  );
}

/** A `from '...'` or `import('...')` that names the testing module, with its quote. */
const TESTING_IMPORT = /(\bfrom\s*|\bimport\s*\(\s*)(['"])@ngwes\/skill-be\/testing\2/g;

/**
 * TypeScript to ES module JavaScript, without a type check. The imports of
 * `@ngwes/skill-be/testing` now name `testingUrl`, so the compiled file loads the wrapper from
 * where skill-be runs and not from the folder the file is in; other imports stay as written.
 * `fileName` names the source in the compiler.
 *
 * `ts` is the `typescript` module, which skill-be loads only when a code test needs it.
 */
export function transpile(
  ts: TypeScript,
  source: string,
  fileName: string,
  testingUrl: string,
): string {
  const { outputText } = ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  return outputText.replace(
    TESTING_IMPORT,
    (_match, lead: string) => `${lead}${JSON.stringify(testingUrl)}`,
  );
}
