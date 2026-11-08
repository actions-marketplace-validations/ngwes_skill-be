/** A `model`, `grader` or `triage.model` entry: adapter, model id and its own settings. */
export type AdapterSettings = { adapter: string; id: string; [key: string]: unknown };

export type TypecheckConfig = {
  preset?: 'typescript';
  command?: string;
  library?: string;
  blocking: boolean;
  preludes?: Record<string, string>;
};

export type CoverageConfig = {
  preset?: 'typescript';
  command?: string;
  entry?: string;
  ignore: string[];
  blocking: boolean;
};

export type Config = {
  /** The directory of the config file. */
  root: string;
  /** Absolute path of the config file; the fingerprint of every skill covers it. */
  configPath: string;
  /** Absolute path of the skills directory. */
  skills: string;
  /** Absolute path of the evals directory. */
  evals: string;
  models: AdapterSettings[];
  grader: AdapterSettings;
  reps: number;
  gradings: number;
  concurrency: number;
  timeoutSeconds: number;
  /** Absolute path of the results directory. */
  results: string;
  /** Absolute path of the committed result file. */
  resultFile: string;
  withSkillTemplate: string;
  graderPrompt: string | null;
  gate: { regressionOnCritical: boolean; blockOnZero: boolean; blockOnErrors: boolean };
  checks: { typecheck: TypecheckConfig | false; coverage: CoverageConfig | false };
  triage: { model: AdapterSettings | null };
  codeTests: {
    /** Absolute path of the tests folder; null when `tests` is not set. */
    tests: string | null;
    /**
     * Absolute path of the default package list when the YAML sets `codeTests.packages`; null when
     * it does not. The fallback to `<root>/test-packages.json` is applied where the list is used.
     */
    packages: string | null;
    /** Skill name -> absolute path of its package list, for skills that do not use the default. */
    packagesBySkill: Record<string, string>;
    testTimeoutSeconds: number;
    answerTimeoutSeconds: number;
    /** Words the contract hint check accepts. */
    allow: string[];
  };
};

/**
 * One task of an eval file, graded by a judge (`criteria`), by real tests (`output` and `tests`),
 * or both. `criteria` is `[]` when the judge has nothing to grade. `output` is the contract of
 * fields the model's code must export (name to description, in the eval file's order), or `null`
 * for a judge-only scenario. `tests` names the code tests of the scenario; parsing leaves it `[]`.
 */
export type Scenario = {
  id: string;
  critical: boolean;
  prompt: string;
  criteria: string[];
  output: Record<string, string> | null;
  tests: string[];
};

export type SkillSuite = {
  name: string;
  /** Absolute path of the skill's `SKILL.md` file. */
  skillPath: string;
  skillText: string;
  /** Absolute path of the skill's eval file. */
  evalPath: string;
  scenarios: Scenario[];
  /** Scenario id -> absolute path of its test file; `{}` when no scenario has an output contract. */
  testFiles: Record<string, string>;
  /**
   * Absolute paths of the skill's test files and helpers and of the shared helpers, sorted; `[]`
   * when no scenario has an output contract. The fingerprint of the skill covers them.
   */
  codeFiles: string[];
  /**
   * Absolute path of the package list the tests need; null when there is none to install, and when
   * no scenario has an output contract.
   */
  packageList: string | null;
};

/** A problem with the config, the skills or an eval file: the user must fix it (exit code 2). */
export class ConfigError extends Error {
  override name = 'ConfigError';
}
