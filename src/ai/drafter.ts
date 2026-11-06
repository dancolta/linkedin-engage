import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

// Strip Claude Code / Anthropic session env so the spawned `claude` CLI uses
// the user's real ~/.claude credentials instead of the parent session's token.
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_|CLAUDECODE)/.test(k))
);
const VOICE_PROFILE = readFileSync(join(__dirname, 'voice-profile.md'), 'utf8');
const GOOD_DRAFTS_PATH = join(__dirname, 'good-drafts.md');

function loadGoodDraftsVibe(): string {
  if (!existsSync(GOOD_DRAFTS_PATH)) return '';
  const content = readFileSync(GOOD_DRAFTS_PATH, 'utf8');
  const entries = content.split(/(?=\n## )/).map(s => s.trim()).filter(s => s.startsWith('## '));
  if (entries.length === 0) return '';
  const shuffled = [...entries].sort(() => Math.random() - 0.5).slice(0, 3);
  const formatted = shuffled.map(e => {
    const lines = e.split('\n').filter(l => l.trim());
    const header = lines[0].replace(/^## /, '');
    const body = lines.slice(1).join(' ').trim();
    return `- (${header}) → ${body}`;
  }).join('\n');
  return `\n\n## Vibe reference — recent comments Dan flagged as good (DO NOT copy structure or phrasing, only the energy/specificity/register):\n\n${formatted}\n`;
}

export class UsageLimitError extends Error {}
export class AuthError extends Error {}
export class DrafterError extends Error {}

export interface PostInput {
  author: string;
  text: string;
  qcFeedback?: { previousDraft: string; issues: string[]; suggestion?: string };
}

const TEXT_TRUNCATE = 800;

// Generating many comments behind the full voice profile in a single `claude -p`
// call is fragile: the model drifts off the requested JSON array and the call can
// blow the execFile timeout (SIGTERM / code 143). Chunk into small groups so each
// call is fast and reliably parseable; merge results in order.
const CHUNK_SIZE = 6;

export async function draftBatch(posts: PostInput[]): Promise<string[]> {
  if (posts.length === 0) return [];
  if (posts.length <= CHUNK_SIZE) return draftChunk(posts);

  const out: string[] = [];
  for (let i = 0; i < posts.length; i += CHUNK_SIZE) {
    const chunk = posts.slice(i, i + CHUNK_SIZE);
    try {
      const drafts = await draftChunk(chunk);
      out.push(...drafts);
    } catch (err) {
      // A usage-limit hit is terminal for the whole run — surface it.
      if (err instanceof UsageLimitError || err instanceof AuthError) throw err;
      // Otherwise don't let one bad chunk sink the scan: SKIP this group and continue.
      console.warn(`Chunk ${i / CHUNK_SIZE + 1} failed (${(err as Error).message.slice(-600)}) — skipping ${chunk.length} posts.`);
      out.push(...new Array(chunk.length).fill('SKIP'));
    }
  }
  return out;
}

async function draftChunk(posts: PostInput[]): Promise<string[]> {
  if (posts.length === 0) return [];

  const numbered = posts.map((p, i) => {
    const text = p.text.slice(0, TEXT_TRUNCATE);
    let block = `### POST ${i + 1} (by ${p.author})\n${text}`;
    if (p.qcFeedback) {
      const issues = p.qcFeedback.issues.map(s => `- ${s}`).join('\n');
      const suggestion = p.qcFeedback.suggestion ? `\nSuggestion: ${p.qcFeedback.suggestion}` : '';
      block += `\n\n[QC REJECTED A PRIOR DRAFT FOR THIS POST]\nPrior draft: ${p.qcFeedback.previousDraft}\nIssues:\n${issues}${suggestion}\n\nWrite a fresh comment that fixes these specific issues. Do not reuse the prior draft's structure or opener.`;
    }
    return block;
  }).join('\n\n');

  const prompt = `${VOICE_PROFILE}${loadGoodDraftsVibe()}

---

Below are ${posts.length} LinkedIn posts. Draft ONE comment for each, in the voice defined above, following all rules.

If a post offers nothing specific to react to, return literally: SKIP

${numbered}

---

Return ONLY a JSON array of ${posts.length} strings (one per post in order). No prose, no markdown, no code fences. Each element is either the comment text OR the literal string "SKIP". Example format:

["Counter: ~14 hours/week of...", "SKIP", "The 41/100 score..."]`;

  let stdout: string;
  try {
    const res = await execFileAsync(
      'claude',
      ['-p', prompt, '--output-format', 'json', '--model', 'claude-sonnet-5-5', '--tools', ''],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 420_000, env: CLEAN_ENV }
    );
    stdout = res.stdout;
  } catch (err: any) {
    const stderr = err.stderr?.toString?.() ?? '';
    const blob = `${stderr}\n${err.stdout?.toString?.() ?? ''}`.toLowerCase();
    if (blob.includes('usage limit') || blob.includes('rate limit') || blob.includes('quota')) {
      throw new UsageLimitError('Claude subscription usage limit hit');
    }
    if (blob.includes('failed to authenticate') || blob.includes('oauth session expired')
      || blob.includes('authentication_error') || blob.includes('invalid api key')) {
      throw new AuthError('claude CLI is not authenticated — run `claude login`');
    }
    throw new DrafterError(`claude CLI failed: ${err.message}\nstderr: ${stderr.slice(0, 2000)}\nstdout: ${(err.stdout?.toString?.() ?? '').slice(0, 2000)}\ncode=${err.code} signal=${err.signal}`);
  }

  let result: any;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new DrafterError('claude CLI returned non-JSON wrapper');
  }
  const inner = (result.result ?? '').trim();
  if (!inner) throw new DrafterError('empty result from claude CLI');

  let arr: string[] | null = null;

  const arrayText = extractJsonArray(inner);
  if (arrayText) {
    try {
      const parsed = JSON.parse(arrayText);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      // fall through to prose fallback
    }
  }

  // Fallback: the model sometimes ignores the JSON instruction on large batches
  // and returns numbered markdown (`**1 (author):** ...` / blockquotes / inline SKIP).
  // Parse that shape rather than failing the whole scan.
  if (!arr) {
    arr = parseNumberedProse(inner, posts.length);
  }

  if (!arr) {
    throw new DrafterError(`could not parse JSON array or numbered prose from response: ${inner.slice(0, 200)}`);
  }

  if (!Array.isArray(arr)) throw new DrafterError('parsed result is not an array');
  if (arr.length !== posts.length) {
    console.warn(`Drafter returned ${arr.length} drafts for ${posts.length} posts — padding with SKIP`);
    while (arr.length < posts.length) arr.push('SKIP');
    arr = arr.slice(0, posts.length);
  }

  return arr.map(s => (typeof s === 'string' ? s.trim() : 'SKIP'));
}

function extractJsonArray(text: string): string | null {
  const fenceMatch = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  if (fenceMatch) return fenceMatch[1];
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return null;
}

/**
 * Best-effort parse of numbered-markdown output for an N-item batch. The drafter
 * sometimes returns `**1 (author — desc):** <comment>` blocks (comment inline, in a
 * `>` blockquote, or the literal SKIP) instead of the requested JSON array. We split
 * on the bold numbered headers and map each block to its index; any item we can't
 * recover stays SKIP. Returns null if no numbered headers are found at all.
 */
function parseNumberedProse(text: string, expectedCount: number): string[] | null {
  const headerRe = /\*\*\s*(\d+)\b[^\n*]*\*\*\s*:?[ \t]*/g;
  const headers: { num: number; contentStart: number; matchStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(text)) !== null) {
    headers.push({ num: parseInt(m[1], 10), matchStart: m.index, contentStart: headerRe.lastIndex });
  }
  if (headers.length === 0) return null;

  const out: string[] = new Array(expectedCount).fill('SKIP');
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (h.num < 1 || h.num > expectedCount) continue;
    const end = i + 1 < headers.length ? headers[i + 1].matchStart : text.length;
    let body = text.slice(h.contentStart, end).trim();
    // Drop a leading horizontal rule / bullet left over from the block separator.
    body = body.replace(/^[-*>\s]*\n/, '').trim();
    // Inline or fenced SKIP.
    if (/^`?\s*SKIP\s*`?\.?$/i.test(body) || /^`?\s*SKIP\s*`?\b/i.test(body)) {
      out[h.num - 1] = 'SKIP';
      continue;
    }
    // Strip blockquote markers and trailing block separators.
    body = body
      .split('\n')
      .map(l => l.replace(/^\s*>\s?/, ''))
      .join('\n')
      .replace(/\n*-{3,}\s*$/, '')
      .trim();
    // Unwrap surrounding quotes/backticks the model sometimes adds.
    body = body.replace(/^["'`]+|["'`]+$/g, '').trim();
    out[h.num - 1] = body || 'SKIP';
  }
  return out;
}

export async function draftComment(post: PostInput): Promise<string> {
  const [draft] = await draftBatch([post]);
  return draft;
}
