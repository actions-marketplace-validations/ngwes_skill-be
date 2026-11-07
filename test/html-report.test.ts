import { describe, expect, it } from 'vitest';
import type { GateVerdict } from '../src/gate.js';
import { renderHtml } from '../src/html-report.js';
import type { ModelResult, RepOutputs, SkillRun } from '../src/runner.js';
import type { AdapterSettings } from '../src/types.js';

const SONNET: AdapterSettings = { adapter: 'claude-cli', id: 'claude-sonnet-5-5' };
const HAIKU: AdapterSettings = { adapter: 'claude-cli', id: 'claude-haiku-5-5' };
const METHOD = { models: [SONNET], grader: HAIKU, reps: 1, gradings: 1, date: '2026-11-02' };

const rep = (baseline: string, withSkill: string): RepOutputs => ({
  baseline: { output: baseline, gradings: [`graded ${baseline}`], tests: [] },
  'with-skill': { output: withSkill, gradings: [`graded ${withSkill}`], tests: [] },
});

const model = (scores: [number, number][], outputs: RepOutputs[], notes: string[] = []) =>
  ({
    model: 'claude-sonnet-5-5',
    criteria: scores.map(([baselinePct, withSkillPct]) => ({ baselinePct, withSkillPct })),
    notes,
    errors: 0,
    outputs,
  }) satisfies ModelResult;

/** `either` is READY; `option` blocks on a critical scenario. */
const RUNS: SkillRun[] = [
  {
    skill: 'either',
    errorCount: 0,
    startedAt: '2026-11-02T09:00:00.000Z',
    durationMs: 252_000,
    scenarios: [
      {
        scenario: {
          id: 'parse-config',
          critical: false,
          prompt: 'Parse it.',
          criteria: ['Uses Either'],
          output: null,
          tests: [],
        },
        models: [model([[0, 100]], [rep('either base answer', 'either skill answer')])],
      },
    ],
  },
  {
    skill: 'option',
    errorCount: 1,
    startedAt: '2026-11-02T09:05:00.000Z',
    durationMs: 3_050,
    scenarios: [
      {
        scenario: {
          id: 'theme-fallback',
          critical: true,
          prompt: 'Pick the theme.',
          criteria: ['Falls back inside the chain', 'Uses Option.from'],
          output: null,
          tests: [],
        },
        models: [
          model(
            [
              [0, 0],
              [33, 100],
            ],
            [rep('option base answer', 'option skill answer')],
            ['[NOTE] rep 1 baseline — criterion 1 tied between 2 gradings, counted as NO'],
          ),
        ],
      },
    ],
  },
];

const GATES = new Map<string, GateVerdict>([
  ['either', { ready: true, reasons: [], blocks: [] }],
  [
    'option',
    {
      ready: false,
      reasons: ['**BLOCKED** (universal 0%): `theme-fallback` — criterion: *"Falls back"*'],
      blocks: [{ kind: 'zero', scenario: 'theme-fallback', criterion: 0 }],
    },
  ],
]);

/** The page's text without tags or entities, with runs of white space as one space. */
const text = (html: string): string =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

/** The HTML of the skill's section. */
const section = (html: string, skill: string): string => {
  const match = new RegExp(`<section id="skill-${skill}"[\\s\\S]*?</section>`).exec(html);
  expect(match, `no section for ${skill}`).not.toBeNull();
  return match![0];
};

describe('renderHtml', () => {
  const html = renderHtml(RUNS, GATES, METHOD);

  it('is a complete page that loads nothing and runs no script', () => {
    expect(html.startsWith('<!doctype html>\n<html lang="en">')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    expect(html).not.toMatch(/<script|<link|<img|src=|https?:\/\//i);
  });

  it('opens with the verdict, how many skills block, the date and the method', () => {
    expect(text(html)).toContain('NOT READY 1 of 2 skill(s) block');
    expect(text(html)).toContain('2026-11-02');
    expect(text(html)).toContain(
      'Models: claude-cli:claude-sonnet-5-5 · Grader: claude-cli:claude-haiku-5-5 · Reps: 1 · Gradings: 1',
    );
  });

  describe('the grader part of the method', () => {
    const GRADED = 'Grader: claude-cli:claude-haiku-5-5 · Reps: 1 · Gradings: 1';
    const NOT_GRADED = 'Grader: none, no scenario has criteria (code tests only) · Reps: 1';

    /** A skill whose scenarios are given as `[criteria, tests]` pairs. */
    const skillOf = (skill: string, scenarios: [string[], string[]][]): SkillRun => ({
      skill,
      errorCount: 0,
      startedAt: '2026-11-02T09:00:00.000Z',
      durationMs: 1_000,
      scenarios: scenarios.map(([criteria, tests], i) => ({
        scenario: {
          id: `${skill}-${i}`,
          critical: false,
          prompt: 'Do it.',
          criteria,
          output: tests.length > 0 ? { handler: 'The handler' } : null,
          tests,
        },
        models: [model([...criteria, ...tests].map((): [number, number] => [0, 100]), [])],
      })),
    });

    const gatesOf = (runs: SkillRun[]) =>
      new Map<string, GateVerdict>(
        runs.map((run) => [run.skill, { ready: true, reasons: [], blocks: [] }]),
      );

    const header = (runs: SkillRun[]): string => text(renderHtml(runs, gatesOf(runs), METHOD));

    it('says nothing was graded when no scenario of the run has criteria', () => {
      const runs = [
        skillOf('signup', [[[], ['responds 201']]]),
        skillOf('login', [[[], ['responds 200']], [[], ['rejects a bad password']]]),
      ];
      expect(header(runs)).toContain(
        `Models: claude-cli:claude-sonnet-5-5 · ${NOT_GRADED}`,
      );
      expect(header(runs)).not.toContain('claude-haiku-5-5');
      expect(header(runs)).not.toContain('Gradings:');
    });

    it('keeps the grading text when a scenario of the run has criteria', () => {
      const runs = [skillOf('signup', [[['Uses Option'], []]])];
      expect(header(runs)).toContain(`Models: claude-cli:claude-sonnet-5-5 · ${GRADED}`);
      expect(header(runs)).not.toContain('Grader: none');
    });

    it('keeps the grading text when one skill of the run is graded and another has only tests', () => {
      const runs = [
        skillOf('signup', [[[], ['responds 201']]]),
        skillOf('either', [[['Uses Either'], []]]),
      ];
      expect(header(runs)).toContain(GRADED);
      expect(header(runs)).not.toContain('Grader: none');
    });

    it('keeps the grading text when one scenario has criteria and another has only tests', () => {
      const runs = [skillOf('signup', [[[], ['responds 201']], [['Uses Option'], []]])];
      expect(header(runs)).toContain(GRADED);
      expect(header(runs)).not.toContain('Grader: none');
    });
  });

  it('says READY when no skill blocks', () => {
    const ready = new Map(GATES).set('option', { ready: true, reasons: [], blocks: [] });
    expect(text(renderHtml(RUNS, ready, METHOD))).toContain('READY every skill passes the gate');
  });

  it('lists every skill in the overview with its verdict, errors, duration and why it blocks', () => {
    const overview = /<table class="overview">[\s\S]*?<\/table>/.exec(html)?.[0] ?? '';
    expect(text(overview)).toContain('either READY 0 4m 12s');
    expect(text(overview)).toContain('option NOT READY 1 3s universal 0%');
    expect(overview).toContain('href="#skill-either"');
    expect(overview).toContain('href="#skill-option"');
  });

  it('opens the sections of the skills that block and folds the READY ones', () => {
    expect(section(html, 'option')).toContain('<details class="skill" open>');
    expect(section(html, 'either')).toContain('<details class="skill">');
  });

  it('shows the gate reasons with their emphasis and code', () => {
    expect(section(html, 'option')).toContain(
      '<li><strong>BLOCKED</strong> (universal 0%): <code>theme-fallback</code> — criterion: <em>&quot;Falls back&quot;</em></li>',
    );
  });

  it('shows each scenario with its prompt, its critical mark, the scores and the notes', () => {
    const option = text(section(html, 'option'));
    expect(option).toContain('theme-fallback critical');
    expect(option).toContain('Pick the theme.');
    expect(option).toContain('Criterion Baseline With skill Delta');
    expect(option).toContain('Falls back inside the chain 0% 0% +0pp');
    expect(option).toContain('Uses Option.from 33% 100% +67pp');
    expect(option).toContain('[NOTE] rep 1 baseline — criterion 1 tied between 2 gradings');
    expect(section(html, 'option')).toContain('<span class="tag">critical</span>');
    expect(section(html, 'either')).not.toContain('<span class="tag">critical</span>');
  });

  it('shows every answer of both arms with the grader replies, folded', () => {
    const option = section(html, 'option');
    expect(option).toMatch(/<details class="answers">\s*<summary>Answers/);
    for (const answer of ['option base answer', 'option skill answer']) {
      expect(option).toContain(`<pre>${answer}</pre>`);
      expect(option).toContain(`<pre>graded ${answer}</pre>`);
    }
    expect(text(option)).toMatch(/Rep 1 Baseline option base answer .*With skill option skill answer/);
  });

  it('escapes every text it shows, so an answer cannot break the page', () => {
    const hostile = '</pre></details><script>alert("x")</script> & <b>';
    const runs: SkillRun[] = [
      {
        ...RUNS[0]!,
        skill: 'a<b>',
        scenarios: [
          {
            scenario: {
              id: 'i<d>',
              critical: false,
              prompt: hostile,
              criteria: [hostile],
              output: null,
              tests: [],
            },
            models: [model([[0, 100]], [rep(hostile, hostile)], [hostile])],
          },
        ],
      },
    ];
    const gates = new Map([['a<b>', { ready: false, reasons: [hostile], blocks: [] }]]);

    const page = renderHtml(runs, gates, METHOD);

    expect(page).not.toMatch(/<script|<b>|<d>/);
    expect(page).toContain('&lt;/pre&gt;&lt;/details&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;b&gt;');
    expect(page).toContain('id="skill-a%3Cb%3E"');
    expect(page).toContain('href="#skill-a%3Cb%3E"');
  });

  it("shows each arm's test results with failure messages, escaped", () => {
    const runs: SkillRun[] = [
      {
        ...RUNS[0]!,
        scenarios: [
          {
            scenario: {
              id: 'create-user',
              critical: false,
              prompt: 'Create a user.',
              criteria: [],
              output: { result: 'the handler' },
              tests: ['responds 201', 'rejects <b>'],
            },
            models: [
              model(
                [
                  [0, 100],
                  [0, 50],
                ],
                [
                  {
                    baseline: {
                      output: 'base code',
                      gradings: [],
                      tests: [
                        { name: 'responds 201', pass: false, message: 'expected 201, got <500>' },
                        { name: 'rejects <b>', pass: false, message: 'no code block' },
                      ],
                    },
                    'with-skill': {
                      output: 'skill code',
                      gradings: [],
                      tests: [
                        { name: 'responds 201', pass: true, message: '' },
                        { name: 'rejects <b>', pass: true, message: '' },
                      ],
                    },
                  },
                ],
              ),
            ],
          },
        ],
      },
    ];

    const page = section(renderHtml(runs, GATES, METHOD), 'either');

    expect(page).not.toContain('<b>');
    expect(page).toContain(
      '<h6>Tests</h6><ul class="notes"><li class="error">✗ responds 201 — expected 201, got ' +
        '&lt;500&gt;</li><li class="error">✗ rejects &lt;b&gt; — no code block</li></ul>',
    );
    expect(page).toContain(
      '<h6>Tests</h6><ul class="notes"><li class="note">✓ responds 201</li>' +
        '<li class="note">✓ rejects &lt;b&gt;</li></ul>',
    );
    expect(text(page)).toContain('[test] responds 201 0% 100% +100pp');
    expect(text(page)).toContain('[test] rejects <b> 0% 50% +50pp');
    // Only the judge's replies are missing, and the tests say what was checked.
    expect(page).not.toContain('Not graded.');
  });

  it('shows no test list for a judge-only scenario', () => {
    expect(html).not.toContain('<h6>Tests</h6>');
  });

  it('follows the light or dark setting of the system', () => {
    expect(html).toContain('@media (prefers-color-scheme: dark)');
  });
});
