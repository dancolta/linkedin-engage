import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const VOICE_PROFILE = readFileSync(join(__dirname, 'voice-profile.md'), 'utf8');

const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_|CLAUDECODE)/.test(k))
);

export class QCError extends Error {}
export class QCUsageLimitError extends Error {}

export interface QCItem {
  author: string;
  postText: string;
  draft: string;
}

export interface QCResult {
  verdict: 'pass' | 'fail';
  issues: string[];
  suggestion?: string;
}

const POST_TRUNCATE = 600;
const RUBRIC = `
You are a strict editor reviewing LinkedIn comments written for Dan Colta. You did NOT write these comments. Your job is to catch drift from Dan's voice rules before they ship.

You are looking at a separate set of eyes than the writer. Be unsparing. When in doubt, fail.

Read the voice rules below carefully. Then for each (post, draft) pair, decide if the draft passes.

A draft FAILS if ANY of these are true (this is not exhaustive — use judgement):

1. Essay-opener pattern. The draft starts with "The [Noun phrase] [stative verb]..." in a way that names a phenomenon and explains it from above. Example fails: "The post structure is doing something", "The workflow bottleneck is real", "Paraphrasing is the tell.", "Infinite scroll produced the outcomes...", "The doctor/lawyer comparison breaks down".
2. Quoted-phrase tic. The draft contains 'single quotes' or "double quotes" around a phrase — almost always banned. Only allowed for explicit reported speech with a named speaker.
3. Banned acronyms. fwiw, FWIW, imo, imho, tbh, iirc, tldr — banned.
4. Sounds like an op-ed reviewing the OP, not a peer typing in DMs. If the comment is "naming a phenomenon" or "grading the post" rather than reacting like a friend, fail.
5. Negation-reframe. "Not X. But Y.", "It's not X. It's Y.", "less about X, more about Y", "X isn't the problem. Y is."
6. Listicle-wisdom register. "the most underrated", "the real X", "where most fail", "separates the good from the great".
7. AUTODOC/NodeSparks/ship-count credibility flex. Any reference to AUTODOC, "26 markets", "millions of SKUs", "8 years", or boasts about shipping count / mini-apps / weekends.
8. Service-provider framing. "we worked with", "we replaced X for Y", positioning Dan as an agency.
9. Exclamation marks, em/en dashes, hashtags, Unicode emoji (ASCII :) is fine).
10. Length over 280 chars or under 30 chars.
11. Restates the OP without adding angle.
12. Closes with lazy filler. "Thoughts?", "What do you think?", "Agree?", "Would love to hear takes."
13. Fabricated numbers presented as Dan's experience that have no anchor the post text or that read implausibly specific (e.g. tenure claims like "~18 months" without any basis in the post context).
14. Choppy period-fragment rhythm. If the comment has 2+ sentence-fragments back-to-back (X. Y.) where each fragment is a continuation rather than a real pivot, fail and suggest comma-joining (X and Y / X, but Y / X, though Y).
15. Missing lowercase-i casualness. If Dan refers to himself mid-sentence in a casual comment and uses capital I, flag it as a soft fix (suggestion only, not a hard fail). Mid-sentence i should appear in ~60% of self-referring casual comments. Always uppercase at sentence start.

A draft PASSES if it:
- Reads like a peer typing fast in DMs.
- Has a conversational opener (yeah / honestly / depends / hmm / wait / kinda / first-person observation / genuine question).
- Adds a real angle, hedge, perspective, or question — not a restatement.
- Leaves room for the OP to reply where natural.
- Passes every other rule above.

When you fail a draft, write 2-3 specific issues (the exact problem, quoting the offending phrase from the draft). Optionally suggest a rewrite direction (don't write the new comment, just describe the angle to take).

---

# Dan's Full Voice Rules (reference)

${VOICE_PROFILE}
`;

export async function qcBatch(items: QCItem[]): Promise<QCResult[]> {
  if (items.length === 0) return [];

  const numbered = items.map((it, i) => {
    const post = it.postText.slice(0, POST_TRUNCATE);
    return `### ITEM ${i + 1}
POST (by ${it.author}):
${post}

DRAFT:
${it.draft}`;
  }).join('\n\n');

  const prompt = `${RUBRIC}

---

Review the ${items.length} drafts below against the rules. Think briefly per item, then return your verdicts.

${numbered}

---

Return ONLY a JSON array of ${items.length} objects (one per item, in order). Each object has:
  - "verdict": "pass" or "fail"
  - "issues": array of short strings (empty if pass)
  - "suggestion": optional short string with rewrite direction (only when verdict is "fail")

No prose, no markdown, no code fences. Example shape:

[{"verdict":"pass","issues":[]},{"verdict":"fail","issues":["essay opener: 'The X is doing Y'","banned acronym: 'fwiw'"],"suggestion":"lead with a first-person reaction"}]`;

  let stdout: string;
  try {
    const res = await execFileAsync(
      'claude',
      ['-p', prompt, '--output-format', 'json', '--model', 'claude-sonnet-4-6', '--tools', ''],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 180_000, env: CLEAN_ENV }
    );
    stdout = res.stdout;
  } catch (err: any) {
    const stderr = err.stderr?.toString?.() ?? '';
    const blob = `${stderr}\n${err.stdout?.toString?.() ?? ''}`.toLowerCase();
    if (blob.includes('usage limit') || blob.includes('rate limit') || blob.includes('quota')) {
      throw new QCUsageLimitError('Claude subscription usage limit hit during QC');
    }
    throw new QCError(`QC claude CLI failed: ${err.message}`);
  }

  let result: any;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new QCError('QC claude CLI returned non-JSON wrapper');
  }
  const inner = (result.result ?? '').trim();
  if (!inner) throw new QCError('QC empty result from claude CLI');

  const arrayText = extractJsonArray(inner);
  if (!arrayText) throw new QCError(`QC could not parse JSON array: ${inner.slice(0, 200)}`);

  let arr: any[];
  try {
    arr = JSON.parse(arrayText);
  } catch (err) {
    throw new QCError(`QC JSON parse failed: ${(err as Error).message} — raw: ${arrayText.slice(0, 200)}`);
  }

  if (!Array.isArray(arr)) throw new QCError('QC parsed result is not an array');
  if (arr.length !== items.length) {
    console.warn(`QC returned ${arr.length} verdicts for ${items.length} items — padding with fail`);
    while (arr.length < items.length) arr.push({ verdict: 'fail', issues: ['QC missing verdict'] });
    arr = arr.slice(0, items.length);
  }

  return arr.map(normalizeResult);
}

function normalizeResult(raw: any): QCResult {
  const verdict = raw?.verdict === 'pass' ? 'pass' : 'fail';
  const issues = Array.isArray(raw?.issues) ? raw.issues.filter((s: any) => typeof s === 'string') : [];
  const suggestion = typeof raw?.suggestion === 'string' && raw.suggestion.trim() ? raw.suggestion.trim() : undefined;
  return { verdict, issues, suggestion };
}

function extractJsonArray(text: string): string | null {
  const fenceMatch = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  if (fenceMatch) return fenceMatch[1];
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return null;
}
