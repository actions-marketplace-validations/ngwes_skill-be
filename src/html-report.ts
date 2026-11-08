/**
 * The HTML page of a run (`run --html`): what `summary.json` holds, plus every answer and grader
 * reply, in one self-contained file. It loads nothing and runs no script, so it opens offline and
 * from a downloaded CI artifact: even its fonts are in the page.
 */

import { readFileSync } from 'node:fs';
import { Option } from '@ngwes/mini-fp';
import { fmtDelta, type GateBlock, type GateVerdict } from './gate.js';
import { isGraded, NOT_GRADED, type ReportMethod } from './report.js';
import type { ArmOutput, CriterionScore, ModelResult, SkillRun } from './runner.js';
import { scoredLines } from './scored-lines.js';
import type { AdapterSettings } from './types.js';

/** The text, safe in an element and in a quoted attribute. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A gate reason: escaped, then its markdown `code`, **strong** and *emphasis* as HTML. */
function inlineMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

/** The section id of a skill, also the overview's link target. */
const anchor = (skill: string): string => `skill-${encodeURIComponent(skill)}`;

const adapterLabel = (settings: AdapterSettings): string => `${settings.adapter}:${settings.id}`;

/** `3s`, `4m 12s`, `1h 5m`. */
function duration(ms: number): string {
  const total = Math.round(ms / 1000);
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  if (h > 0) return `${h}h ${m}m`;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

const BLOCK_LABELS: Record<GateBlock['kind'], string> = {
  zero: 'universal 0%',
  regression: 'critical regression',
  error: 'errors',
};

/** The overview's short answer to why a skill blocks: the kinds of its blocks. */
function why(gate: GateVerdict): string {
  if (gate.ready) return '—';
  const kinds = [...new Set(gate.blocks.map((block) => BLOCK_LABELS[block.kind]))];
  return kinds.length > 0 ? kinds.join(', ') : `${gate.reasons.length} reason(s)`;
}

function verdictPill(ready: boolean): string {
  return ready
    ? '<span class="pill ready">READY</span>'
    : '<span class="pill blocked">NOT READY</span>';
}

function gateOf(gates: ReadonlyMap<string, GateVerdict>, skill: string): GateVerdict {
  return Option.from(gates.get(skill)).orElse(() => {
    throw new Error(`No gate verdict for skill "${skill}"`);
  });
}

function scoresTable(criteria: readonly string[], model: ModelResult): string {
  const rows = criteria.map((criterion, c) => {
    const { baselinePct, withSkillPct } = Option.from<CriterionScore>(model.criteria[c]).orElse({
      baselinePct: 0,
      withSkillPct: 0,
    });
    const delta = withSkillPct - baselinePct;
    const trend = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
    return (
      `<tr><td>${escapeHtml(criterion)}</td><td class="num">${baselinePct}%</td>` +
      `<td class="num">${withSkillPct}%</td><td class="num ${trend}">${fmtDelta(delta)}</td></tr>`
    );
  });
  return (
    '<div class="table-wrap"><table class="scores"><thead><tr><th>Criterion</th>' +
    '<th class="num baseline">Baseline</th><th class="num with-skill">With skill</th>' +
    '<th class="num">Delta</th></tr></thead>' +
    `<tbody>${rows.join('')}</tbody></table></div>`
  );
}

function notesList(notes: readonly string[]): string {
  if (notes.length === 0) return '';
  const items = notes.map((note) => {
    const level = note.startsWith('[ERROR]') ? 'error' : 'note';
    return `<li class="${level}">${escapeHtml(note)}</li>`;
  });
  return `<ul class="notes">${items.join('')}</ul>`;
}

/** An arm's test outcomes, `✓ name` or `✗ name — message`; nothing when it ran no test. */
function testsList(outcomes: ArmOutput['tests']): string {
  if (outcomes.length === 0) return '';
  const items = outcomes.map((outcome) =>
    outcome.pass
      ? `<li class="note">✓ ${escapeHtml(outcome.name)}</li>`
      : `<li class="error">✗ ${escapeHtml(outcome.name)} — ${escapeHtml(outcome.message)}</li>`,
  );
  return `<h6>Tests</h6><ul class="notes">${items.join('')}</ul>`;
}

/** One arm's answer; `kind` is its class, `baseline` or `with-skill`, which sets its colour. */
function arm(label: string, kind: 'baseline' | 'with-skill', kept: ArmOutput): string {
  const replies = kept.gradings.map((reply) => `<pre>${escapeHtml(reply.trimEnd())}</pre>`);
  // An answer its tests scored was checked, even when no judge graded it.
  const gradings =
    replies.length > 0
      ? `<details class="gradings"><summary>Grader replies (${replies.length})</summary>` +
        `${replies.join('')}</details>`
      : kept.tests.length > 0
        ? ''
        : '<p class="muted">Not graded.</p>';
  const output = `<pre>${escapeHtml(kept.output.trimEnd())}</pre>`;
  return (
    `<div class="arm ${kind}"><h6>${label}</h6>${output}${testsList(kept.tests)}` +
    `${gradings}</div>`
  );
}

function answers(model: ModelResult): string {
  if (model.outputs.length === 0) return '';
  const reps = model.outputs.map(
    (rep, r) =>
      `<h5>Rep ${r + 1}</h5><div class="arms">` +
      `${arm('Baseline', 'baseline', rep.baseline)}` +
      `${arm('With skill', 'with-skill', rep['with-skill'])}</div>`,
  );
  return (
    `<details class="answers">\n<summary>Answers (${model.outputs.length} rep(s))</summary>` +
    `${reps.join('')}</details>`
  );
}

function skillSection(run: SkillRun, gate: GateVerdict): string {
  const reasons = gate.reasons.map((reason) => `<li>${inlineMarkdown(reason)}</li>`);
  const verdict = gate.ready
    ? '<p class="gate ready">READY — No universal 0% criteria. No critical regressions.</p>'
    : `<ul class="reasons">${reasons.join('')}</ul>`;
  const scenarios = run.scenarios.map(({ scenario, models }) => {
    const critical = scenario.critical ? ' <span class="tag">critical</span>' : '';
    const perModel = models.map(
      (model) =>
        `<div class="model"><h4>${escapeHtml(model.model)}</h4>` +
        `${scoresTable(scoredLines(scenario), model)}${notesList(model.notes)}` +
        `${answers(model)}</div>`,
    );
    return (
      `<div class="scenario"><h3>${escapeHtml(scenario.id)}${critical}</h3>` +
      `<blockquote class="prompt">${escapeHtml(scenario.prompt)}</blockquote>` +
      `${perModel.join('')}</div>`
    );
  });
  return (
    `<section id="${anchor(run.skill)}">` +
    `<details class="skill"${gate.ready ? '' : ' open'}>` +
    `<summary><h2>${escapeHtml(run.skill)}</h2> ${verdictPill(gate.ready)}</summary>` +
    `${verdict}${scenarios.join('')}</details></section>`
  );
}

/**
 * The fonts the page embeds: the latin subsets, as woff2, from the package's `fonts/` folder,
 * next to their licenses (SIL OFL 1.1).
 */
const FONTS = [
  { family: 'Press Start 2P', weight: 400, file: 'press-start-2p-latin-400-normal.woff2' },
  { family: 'IBM Plex Mono', weight: 400, file: 'ibm-plex-mono-latin-400-normal.woff2' },
  { family: 'IBM Plex Mono', weight: 600, file: 'ibm-plex-mono-latin-600-normal.woff2' },
] as const;

let fontFacesCache: string | undefined;

/** The `@font-face` rules of the embedded fonts, read once, on the first page. */
function fontFaces(): string {
  fontFacesCache ??= FONTS.map(({ family, weight, file }) => {
    const data = readFileSync(new URL(`../fonts/${file}`, import.meta.url)).toString('base64');
    return (
      `@font-face { font-family: "${family}"; font-style: normal; font-weight: ${weight}; ` +
      `font-display: swap; src: url("data:font/woff2;base64,${data}") format("woff2"); }`
    );
  }).join('\n');
  return fontFacesCache;
}

/**
 * The light theme (Warm Cream, Deep Ink outlines), also used to print. The brand hues are too
 * light to read on cream, so text takes darker steps of them; frames keep the brand hues.
 */
const LIGHT = `
  --bg: #F5EFE1; --fg: #102A27; --muted: #4D5F57; --panel: #EAE2CE;
  --frame: #102A27; --rule: #D3CAB3; --rule-strong: #8C9C86;
  --green: #3B6034; --amber: #685C10; --ready: #3B6034; --blocked: #A3352B; --on-fill: #F5EFE1;
  --baseline: #22646E; --with-skill: #8A4361; --baseline-frame: #65A9B4;
  --with-skill-frame: #BD8299; --scan: rgba(16, 42, 39, .16);
  color-scheme: light;`;

/** The dark theme: CRT Black, Warm Cream text, Phosphor Green structure. */
const DARK = `
  --bg: #0B1A14; --fg: #F5EFE1; --muted: #A8B5A4; --panel: #102A27;
  --frame: #8FAF87; --rule: #22392E; --rule-strong: #4C6650;
  --green: #8FAF87; --amber: #DBD089; --ready: #8FAF87; --blocked: #E58A7E; --on-fill: #0B1A14;
  --baseline: #65A9B4; --with-skill: #BD8299; --baseline-frame: #65A9B4;
  --with-skill-frame: #BD8299; --scan: rgba(143, 175, 135, .22);
  color-scheme: dark;`;

/** A corner that steps in by one `--s`, twice, rather than a rounded one. */
const STEPPED = [
  '0 calc(2 * var(--s))',
  'var(--s) calc(2 * var(--s))',
  'var(--s) var(--s)',
  'calc(2 * var(--s)) var(--s)',
  'calc(2 * var(--s)) 0',
  'calc(100% - 2 * var(--s)) 0',
  'calc(100% - 2 * var(--s)) var(--s)',
  'calc(100% - var(--s)) var(--s)',
  'calc(100% - var(--s)) calc(2 * var(--s))',
  '100% calc(2 * var(--s))',
  '100% calc(100% - 2 * var(--s))',
  'calc(100% - var(--s)) calc(100% - 2 * var(--s))',
  'calc(100% - var(--s)) calc(100% - var(--s))',
  'calc(100% - 2 * var(--s)) calc(100% - var(--s))',
  'calc(100% - 2 * var(--s)) 100%',
  'calc(2 * var(--s)) 100%',
  'calc(2 * var(--s)) calc(100% - var(--s))',
  'var(--s) calc(100% - var(--s))',
  'var(--s) calc(100% - 2 * var(--s))',
  '0 calc(100% - 2 * var(--s))',
].join(', ');

const PIXEL = '"Press Start 2P", ui-monospace, monospace';
const MONO = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Consolas, monospace';

const STYLE = `
:root {${LIGHT}
  --s: 2px;
}
@media (prefers-color-scheme: dark) {
  :root {${DARK}
  }
}
@media print {
  :root {${LIGHT}
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.55 ${MONO}; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 64px; }
h1, h2, h5, h6, th, .pill, .tag, .verdict strong, details.answers > summary,
details.gradings > summary { font-family: ${PIXEL}; font-weight: 400; letter-spacing: 0; }
h1 { margin: 0; font-size: 20px; line-height: 1.3; }
h1 .be { color: var(--green); }
h1 .sub { font-size: 12px; color: var(--muted); margin-left: 8px; }
h2 { display: inline; font-size: 14px; line-height: 1.6; margin: 0; overflow-wrap: anywhere; }
h3 { font-size: 16px; font-weight: 600; margin: 24px 0 8px; overflow-wrap: anywhere; }
h4 { font-size: 14px; font-weight: 600; margin: 16px 0 6px; color: var(--muted); }
h5 { font-size: 10px; margin: 16px 0 8px; color: var(--green); }
h6 { font-size: 10px; margin: 10px 0 6px; color: var(--muted); }
a { color: var(--green); text-decoration-thickness: 1px; text-underline-offset: 3px; }
a:hover { color: var(--fg); }
a:focus-visible, summary:focus-visible { outline: var(--s) solid var(--amber); outline-offset: 2px; }
code { font: 600 0.92em ${MONO}; }

/* The stepped frame: a --s border, notched corners, a --s square filling each inner step. */
.banner, details.skill, pre, .pill, .tag {
  --fc: var(--frame); --fill: transparent;
  border: var(--s) solid var(--fc);
  background:
    linear-gradient(var(--fc) 0 0) left top / var(--s) var(--s) no-repeat,
    linear-gradient(var(--fc) 0 0) right top / var(--s) var(--s) no-repeat,
    linear-gradient(var(--fc) 0 0) left bottom / var(--s) var(--s) no-repeat,
    linear-gradient(var(--fc) 0 0) right bottom / var(--s) var(--s) no-repeat,
    var(--fill);
  clip-path: polygon(${STEPPED});
}

.banner { --fill: var(--panel); padding: 14px 18px 16px; margin-bottom: 24px; }
.titlebar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px;
  padding-bottom: 12px; margin-bottom: 14px; border-bottom: var(--s) solid var(--rule-strong); }
.icon { flex: none; display: block; shape-rendering: crispEdges; }
.icon .g { fill: var(--green); } .icon .w { fill: var(--fg); } .icon .a { fill: var(--amber); }
.icon .c { fill: var(--baseline-frame); } .icon .m { fill: var(--with-skill-frame); }
.scan { flex: 1 1 40px; align-self: center; height: 14px; min-width: 40px;
  background: repeating-linear-gradient(to bottom, var(--scan) 0 2px, transparent 2px 4px); }
.lights { display: flex; gap: 6px; }
.lights span { width: 10px; height: 10px; }
.lights span:nth-child(1) { background: #8FAF87; }
.lights span:nth-child(2) { background: #DBD089; }
.lights span:nth-child(3) { background: #BD8299; }
.verdict { margin: 0; font-size: 15px; display: flex; flex-wrap: wrap; align-items: baseline;
  gap: 4px 14px; }
.verdict strong { font-size: 16px; }
.banner.ready .verdict strong { color: var(--ready); }
.banner.blocked .verdict strong { color: var(--blocked); }
.meta, .muted { color: var(--muted); font-size: 13px; margin: 8px 0 0; }

.table-wrap { overflow-x: auto; margin: 6px 0; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
table.scores { min-width: 560px; }
table.overview { min-width: 600px; }
th, td { border-bottom: 1px solid var(--rule); padding: 6px 10px; text-align: left; vertical-align: top; }
th { font-size: 10px; line-height: 1.4; color: var(--green); white-space: nowrap;
  border-bottom: var(--s) solid var(--frame); padding-top: 10px; }
th.baseline, .arm.baseline > h6:first-child { color: var(--baseline); }
th.with-skill, .arm.with-skill > h6:first-child { color: var(--with-skill); }
th.baseline::before, th.with-skill::before, .arm > h6:first-child::before { content: "";
  display: inline-block; width: 8px; height: 8px; margin-right: 8px; vertical-align: 0; }
th.baseline::before, .arm.baseline > h6:first-child::before { background: var(--baseline-frame); }
th.with-skill::before, .arm.with-skill > h6:first-child::before {
  background: var(--with-skill-frame); }
.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.up { color: var(--ready); } .down { color: var(--blocked); } .flat { color: var(--muted); }

.pill { display: inline-block; padding: 5px 8px 4px; font-size: 10px; line-height: 1;
  white-space: nowrap; vertical-align: middle; }
.pill.ready { --fc: var(--ready); color: var(--ready); }
.pill.blocked { --fc: var(--blocked); --fill: var(--blocked); color: var(--on-fill); }
.tag { --fc: var(--amber); display: inline-block; padding: 5px 7px 4px; font-size: 8px;
  line-height: 1; color: var(--amber); vertical-align: middle; margin-left: 6px; }

section { margin: 16px 0; }
details.skill { --fc: var(--rule-strong); padding: 12px 16px; }
details.skill[open] { --fc: var(--frame); }
summary { cursor: pointer; list-style: none; }
summary::-webkit-details-marker { display: none; }
summary::before { content: "[+]"; font: 600 14px ${MONO}; color: var(--green); margin-right: 10px; }
details[open] > summary::before { content: "[-]"; }
details.skill > summary { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
details.skill > summary::before { margin-right: 0; }
.gate.ready { color: var(--ready); margin: 14px 0 0; }
.reasons { margin: 14px 0 0; padding-left: 22px; list-style: square; }
.reasons li { color: var(--blocked); margin: 4px 0; }
.prompt { margin: 0 0 8px; padding: 6px 14px; border-left: var(--s) solid var(--green);
  color: var(--muted); white-space: pre-wrap; overflow-wrap: anywhere; }
.notes { font-size: 13px; padding-left: 22px; list-style: square; }
.notes .error { color: var(--blocked); }
.model > .notes .note { color: var(--amber); }
.arm .notes .note { color: var(--ready); }
.arm .notes { list-style: none; padding-left: 0; margin: 0 0 8px; overflow-wrap: anywhere; }
details.answers, details.gradings { margin: 10px 0; }
details.answers > summary, details.gradings > summary { font-size: 10px; color: var(--green);
  line-height: 1.6; }
details.answers > summary::before, details.gradings > summary::before { font-size: 13px; }
.arms { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr));
  gap: 14px; }
.arm { min-width: 0; }
pre { --fc: var(--rule-strong); --fill: var(--panel); margin: 0; padding: 10px 12px;
  font: 12.5px/1.5 ${MONO}; white-space: pre-wrap; overflow-wrap: anywhere; }
.arm.baseline > pre { --fc: var(--baseline-frame); }
.arm.with-skill > pre { --fc: var(--with-skill-frame); }
details.gradings pre { margin-top: 6px; }

@media (max-width: 600px) {
  h1 { font-size: 16px; }
  h1 .sub { font-size: 10px; }
  h2 { font-size: 12px; }
  .banner { padding: 12px 12px 14px; }
  details.skill { padding: 10px 10px; }
  .verdict strong { font-size: 14px; }
}
`;

/**
 * The pixel icon of skill-be, as squares on a 24 × 20 grid: the terminal frame (`g`), its status
 * lights, the baseline document (`c`), the with-skill one (`m`) and the arrow between (`w`).
 */
const ICON_ROWS = [
  '..gggggggggggggggggggg..',
  '.g....................g.',
  'g...............g.a.m..g',
  'g......................g',
  'gggggggggggggggggggggggg',
  'g......................g',
  'g.cccc..........mmmm...g',
  'g.c...c.........m...m..g',
  'g.c....c........m....m.g',
  'g.c....c........m....m.g',
  'g.c.cc.c........m.mm.m.g',
  'g.c....c..w..w..m....m.g',
  'g.c.cc.c.wwwwww.m.mm.m.g',
  'g.c....c..w..w..m....m.g',
  'g.c.cc.c........m.mm.m.g',
  'g.c....c........m....m.g',
  'g.cccccc........mmmmmm.g',
  'g......................g',
  '.g....................g.',
  '..gggggggggggggggggggg..',
];

/** The icon as inline SVG: a path per colour, each run of its squares in a row one rectangle. */
function icon(): string {
  const runs = new Map<string, string>();
  ICON_ROWS.forEach((row, y) => {
    for (const run of row.matchAll(/([a-z])\1*/g)) {
      const colour = run[0][0] as string;
      runs.set(colour, `${runs.get(colour) ?? ''}M${run.index} ${y}h${run[0].length}v1H${run.index}z`);
    }
  });
  const paths = [...runs].map(([colour, d]) => `<path class="${colour}" d="${d}"/>`);
  return (
    '<svg class="icon" width="48" height="40" viewBox="0 0 24 20" aria-hidden="true">' +
    `${paths.join('')}</svg>`
  );
}

/**
 * The page of a run: a banner with the overall verdict and the method, an overview table of the
 * skills, then a section per skill (open when it blocks) with its gate reasons, and for each
 * scenario and model the scores (criteria, then `[test]` lines), the notes and, folded, every
 * answer with its test results and its grader replies.
 *
 * @throws when a skill has no verdict in `gates`.
 */
export function renderHtml(
  runs: readonly SkillRun[],
  gates: ReadonlyMap<string, GateVerdict>,
  method: ReportMethod,
): string {
  const blocking = runs.filter((run) => !gateOf(gates, run.skill).ready).length;
  const ready = blocking === 0;
  const verdict = ready
    ? '<strong>READY</strong> <span>every skill passes the gate</span>'
    : `<strong>NOT READY</strong> <span>${blocking} of ${runs.length} skill(s) block</span>`;
  const meta =
    `Models: ${method.models.map(adapterLabel).join(', ')} · ` +
    (isGraded(runs)
      ? `Grader: ${adapterLabel(method.grader)} · Reps: ${method.reps} · ` +
        `Gradings: ${method.gradings}`
      : `Grader: ${NOT_GRADED} · Reps: ${method.reps}`);

  const rows = runs.map((run) => {
    const gate = gateOf(gates, run.skill);
    return (
      `<tr><td><a href="#${anchor(run.skill)}">${escapeHtml(run.skill)}</a></td>` +
      `<td>${verdictPill(gate.ready)}</td><td class="num">${run.errorCount}</td>` +
      `<td class="num">${duration(run.durationMs)}</td><td>${escapeHtml(why(gate))}</td></tr>`
    );
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>skill-be results — ${escapeHtml(method.date)}</title>
<style>${fontFaces()}
${STYLE}</style>
</head>
<body>
<main>
<header class="banner ${ready ? 'ready' : 'blocked'}">
<div class="titlebar">${icon()}
<h1><span class="wordmark">skill-<span class="be">be</span></span> <span class="sub">results</span></h1>
<span class="scan" aria-hidden="true"></span>
<span class="lights" aria-hidden="true"><span></span><span></span><span></span></span>
</div>
<p class="verdict">${verdict}</p>
<p class="meta">Run of ${escapeHtml(method.date)} · ${escapeHtml(meta)}</p>
</header>
<div class="table-wrap">
<table class="overview">
<thead><tr><th>Skill</th><th>Verdict</th><th class="num">Errors</th><th class="num">Duration</th><th>Why it blocks</th></tr></thead>
<tbody>${rows.join('\n')}</tbody>
</table>
</div>
${runs.map((run) => skillSection(run, gateOf(gates, run.skill))).join('\n')}
</main>
</body>
</html>
`;
}
