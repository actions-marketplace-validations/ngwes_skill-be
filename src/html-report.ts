/**
 * The HTML page of a run (`run --html`): what `summary.json` holds, plus every answer and grader
 * reply, in one self-contained file. It loads nothing and runs no script, so it opens offline and
 * from a downloaded CI artifact.
 */

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
    '<table class="scores"><thead><tr><th>Criterion</th><th class="num">Baseline</th>' +
    '<th class="num">With skill</th><th class="num">Delta</th></tr></thead>' +
    `<tbody>${rows.join('')}</tbody></table>`
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

function arm(label: string, kept: ArmOutput): string {
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
  return `<div class="arm"><h6>${label}</h6>${output}${testsList(kept.tests)}${gradings}</div>`;
}

function answers(model: ModelResult): string {
  if (model.outputs.length === 0) return '';
  const reps = model.outputs.map(
    (rep, r) =>
      `<h5>Rep ${r + 1}</h5><div class="arms">` +
      `${arm('Baseline', rep.baseline)}${arm('With skill', rep['with-skill'])}</div>`,
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

const STYLE = `
:root {
  --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0; --panel: #f6f8fa;
  --ready: #1a7f37; --ready-bg: #dafbe1; --blocked: #cf222e; --blocked-bg: #ffebe9;
  --accent: #0969da;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --line: #3d444d; --panel: #151b23;
    --ready: #3fb950; --ready-bg: #12261e; --blocked: #f85149; --blocked-bg: #2d1214;
    --accent: #4493f8;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { display: inline; font-size: 18px; margin: 0; }
h3 { font-size: 16px; margin: 20px 0 6px; }
h4 { font-size: 14px; margin: 14px 0 6px; color: var(--muted); }
h5 { font-size: 13px; margin: 12px 0 6px; }
h6 { font-size: 12px; margin: 0 0 4px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
a { color: var(--accent); }
.banner { border-radius: 8px; padding: 14px 16px; margin-bottom: 20px; }
.banner.ready { background: var(--ready-bg); }
.banner.blocked { background: var(--blocked-bg); }
.verdict { margin: 0; font-size: 17px; }
.banner.ready .verdict strong { color: var(--ready); }
.banner.blocked .verdict strong { color: var(--blocked); }
.meta, .muted { color: var(--muted); font-size: 13px; margin: 4px 0 0; }
table { border-collapse: collapse; width: 100%; margin: 6px 0; font-size: 14px; }
th, td { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.up { color: var(--ready); } .down { color: var(--blocked); }
.pill { display: inline-block; padding: 1px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; }
.pill.ready { color: var(--ready); background: var(--ready-bg); }
.pill.blocked { color: var(--blocked); background: var(--blocked-bg); }
.tag { font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 4px;
  color: var(--blocked); border: 1px solid currentColor; vertical-align: middle; }
section { margin: 14px 0; }
details.skill { border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; }
details.skill > summary { cursor: pointer; }
.gate.ready { color: var(--ready); }
.reasons li { color: var(--blocked); }
.prompt { margin: 0 0 6px; padding: 6px 12px; border-left: 3px solid var(--line);
  color: var(--muted); white-space: pre-wrap; }
.notes { font-size: 13px; }
.notes .error { color: var(--blocked); }
.notes .note { color: var(--muted); }
details.answers, details.gradings { margin: 8px 0; }
details.answers > summary, details.gradings > summary { cursor: pointer; color: var(--accent); font-size: 13px; }
.arms { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 10px; }
.arm { min-width: 0; }
pre { margin: 0; padding: 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
  font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
details.gradings pre { margin-top: 6px; }
code { font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; }
`;

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
<style>${STYLE}</style>
</head>
<body>
<main>
<header class="banner ${ready ? 'ready' : 'blocked'}">
<h1>skill-be results</h1>
<p class="verdict">${verdict}</p>
<p class="meta">Run of ${escapeHtml(method.date)} · ${escapeHtml(meta)}</p>
</header>
<table class="overview">
<thead><tr><th>Skill</th><th>Verdict</th><th class="num">Errors</th><th class="num">Duration</th><th>Why it blocks</th></tr></thead>
<tbody>${rows.join('\n')}</tbody>
</table>
${runs.map((run) => skillSection(run, gateOf(gates, run.skill))).join('\n')}
</main>
</body>
</html>
`;
}
