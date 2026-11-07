/**
 * The model's answer as code: the code block taken from its reply, and TypeScript turned into the
 * JavaScript that runs. Nothing is type-checked: a type error in an answer or in a test does not
 * stop it from running.
 */

import type { CompilerOptions } from 'typescript';
import { Option } from '@ngwes/mini-fp';
import { extractCodeBlocks } from '../checks/code-blocks.js';
import { format, type TypeScript } from '../checks/typescript.js';

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
    compilerOptions: compilerOptions(ts),
  });
  return outputText.replace(
    TESTING_IMPORT,
    (_match, lead: string) => `${lead}${JSON.stringify(testingUrl)}`,
  );
}

/**
 * The syntax errors {@link transpile} meets in `source`, each with its 1-based line; none when the
 * source parses. Type errors are not looked for.
 */
export function syntaxErrors(
  ts: TypeScript,
  source: string,
  fileName: string,
): { line: number; message: string }[] {
  const { diagnostics = [] } = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: compilerOptions(ts),
  });
  return diagnostics.map((diagnostic) => ({
    line: Option.from(diagnostic.file)
      .bind((file) =>
        Option.from(diagnostic.start).map(
          (start) => file.getLineAndCharacterOfPosition(start).line + 1,
        ),
      )
      .orElse(1),
    message: format(ts, diagnostic),
  }));
}

function compilerOptions(ts: TypeScript): CompilerOptions {
  return { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, esModuleInterop: true };
}
