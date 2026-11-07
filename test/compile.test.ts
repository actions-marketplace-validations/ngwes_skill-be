import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  ANSWER_LANGUAGES,
  extractAnswer,
  syntaxErrors,
  transpile,
} from '../src/code-tests/compile.js';

const URL_OF_TESTING = 'file:///skill-be/dist/testing.js';

const block = (lang: string, code: string): string => '```' + lang + '\n' + code + '\n```\n';

describe('extractAnswer', () => {
  it('takes the last ts block', () => {
    const output = [
      'A first try:',
      block('ts', 'export const result = 1;'),
      'Better:',
      block('typescript', 'export const result = 2;'),
      'Final:',
      block('ts', 'export const result = 3;'),
    ].join('\n');
    expect(extractAnswer(output)).toBe('export const result = 3;');
  });

  it('accepts js and javascript', () => {
    expect(extractAnswer(block('js', 'export const result = 1;'))).toBe('export const result = 1;');
    expect(extractAnswer(block('javascript', 'export const result = 2;'))).toBe(
      'export const result = 2;',
    );
    expect(ANSWER_LANGUAGES).toEqual(['ts', 'typescript', 'js', 'javascript']);
  });

  it('ignores blocks in other languages', () => {
    const output = [
      block('ts', 'export const result = 1;'),
      block('bash', 'npm install'),
      block('json', '{}'),
      block('', 'plain'),
    ].join('\n');
    expect(extractAnswer(output)).toBe('export const result = 1;');
  });

  it('returns null without a block', () => {
    expect(extractAnswer('No code here.')).toBeNull();
    expect(extractAnswer(block('bash', 'npm install'))).toBeNull();
    expect(extractAnswer('')).toBeNull();
  });
});

describe('transpile', () => {
  it('emits an ES module', () => {
    const out = transpile(ts, 'export const result: number = 1;', 'answer.ts', URL_OF_TESTING);
    expect(out).toContain('export const result');
    expect(out).not.toContain(': number');
  });

  it('does not fail on a type error', () => {
    const source = 'export const result: string = 1;\nexport const n: number = missing;';
    const out = transpile(ts, source, 'answer.ts', URL_OF_TESTING);
    expect(out).toContain('export const result = 1;');
    expect(out).toContain('export const n = missing;');
  });

  it('rewrites the testing import to the given URL', () => {
    const source = [
      "import { test } from '@ngwes/skill-be/testing';",
      'import { tests } from "@ngwes/skill-be/testing";',
      "export const later = () => import('@ngwes/skill-be/testing');",
      "export { test as again } from '@ngwes/skill-be/testing';",
      'test("a", () => {});',
      'tests()("b", () => {});',
    ].join('\n');
    const out = transpile(ts, source, 'a.test.ts', URL_OF_TESTING);
    expect(out).not.toContain('@ngwes/skill-be/testing');
    expect(out.match(/file:\/\/\/skill-be\/dist\/testing\.js/g)).toHaveLength(4);
    expect(out).toMatch(/import \{ test \} from ["']file:\/\/\/skill-be\/dist\/testing\.js["']/);
    expect(out).toMatch(/import \{ tests \} from ["']file:\/\/\/skill-be\/dist\/testing\.js["']/);
    expect(out).toMatch(/import\(["']file:\/\/\/skill-be\/dist\/testing\.js["']\)/);
  });

  it('writes a URL with a dollar sign or a quote as it is', () => {
    const url = "file:///c/$&/it's/testing.js";
    const source = "import { test } from '@ngwes/skill-be/testing';\ntest;";
    const out = transpile(ts, source, 'a.ts', url);
    expect(out).toContain(JSON.stringify(url));
  });

  it('leaves other specifiers alone', () => {
    const source = [
      "import { other } from '@ngwes/skill-be/testing-extra';",
      "import { sibling } from '@ngwes/skill-be';",
      "export const text = 'from \"@ngwes/skill-be\"';",
      'other; sibling;',
    ].join('\n');
    const out = transpile(ts, source, 'a.ts', URL_OF_TESTING);
    expect(out).toContain("'@ngwes/skill-be/testing-extra'");
    expect(out).toContain("'@ngwes/skill-be'");
    expect(out).not.toContain(URL_OF_TESTING);
  });

  it('keeps relative .js imports as written', () => {
    const source = [
      "import { helper } from './helper.js';",
      "import { shared } from '../_shared/util.js';",
      'export const result = helper() + shared();',
    ].join('\n');
    const out = transpile(ts, source, 'a.test.ts', URL_OF_TESTING);
    expect(out).toMatch(/from ["']\.\/helper\.js["']/);
    expect(out).toMatch(/from ["']\.\.\/_shared\/util\.js["']/);
  });

  it('drops a type-only import of the testing module', () => {
    const source = [
      "import type { TestFn } from '@ngwes/skill-be/testing';",
      'export const fn: TestFn<{ result: number }> = () => {};',
    ].join('\n');
    const out = transpile(ts, source, 'a.test.ts', URL_OF_TESTING);
    expect(out).not.toContain('import');
  });
});

describe('syntaxErrors', () => {
  it('returns none for code that parses, type errors included', () => {
    expect(syntaxErrors(ts, 'const n: number = "two";\n', 'a.ts')).toEqual([]);
  });

  it('returns each syntax error with its line', () => {
    const errors = syntaxErrors(ts, 'const a = 1;\nconst b = (;\n', 'a.test.ts');
    expect(errors).toEqual([{ line: 2, message: 'error TS1109: Expression expected.' }]);
  });
});
