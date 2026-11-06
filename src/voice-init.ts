import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface, Interface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { homedir } from 'node:os';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

const TEMPLATE_PATH = join(__dirname, 'ai', 'voice-profile.template.md');
const PROFILE_PATH = join(__dirname, 'ai', 'voice-profile.md');
const ANSWERS_DIR = join(homedir(), '.linkedin-engage');
const ANSWERS_PATH = join(ANSWERS_DIR, 'voice-answers.json');

interface Answers {
  name: string;
  role: string;
  company: string;
  bio: string;
  adjectives: string[];
  cadence: 'lowercase' | 'mixed' | 'proper';
  swearing: 'never' | 'rare' | 'often';
  sarcasm: number;
  inspirations: string;
  topics: string[];
  angle: string;
  samples: string[];
  annoyances: string[];
  goals: string;
  audience: string;
}

async function ask(rl: Interface, q: string, opts: { default?: string; required?: boolean } = {}): Promise<string> {
  const def = opts.default ? ` [${opts.default}]` : '';
  while (true) {
    const raw = (await rl.question(`\n${q}${def}\n  > `)).trim();
    const ans = raw || opts.default || '';
    if (ans || !opts.required) return ans;
    console.log('  (required — please answer)');
  }
}

async function askMultiline(rl: Interface, q: string, label: string): Promise<string> {
  console.log(`\n${q}`);
  console.log(`  (paste ${label}, then enter on an empty line to finish; leave fully empty to skip)`);
  const lines: string[] = [];
  while (true) {
    const line = await rl.question('  > ');
    if (!line.trim()) {
      if (lines.length === 0) return '';
      break;
    }
    lines.push(line);
  }
  return lines.join('\n').trim();
}

async function askChoice<T extends string>(rl: Interface, q: string, choices: readonly T[], def?: T): Promise<T> {
  while (true) {
    const opts = choices.map(c => c === def ? `[${c}]` : c).join(' / ');
    const raw = (await rl.question(`\n${q}\n  ${opts}\n  > `)).trim().toLowerCase();
    const ans = raw || def || '';
    const match = choices.find(c => c.toLowerCase() === ans);
    if (match) return match;
    console.log(`  (please pick one of: ${choices.join(', ')})`);
  }
}

async function askInt(rl: Interface, q: string, min: number, max: number, def?: number): Promise<number> {
  const defStr = def !== undefined ? ` [${def}]` : '';
  while (true) {
    const raw = (await rl.question(`\n${q} (${min}-${max})${defStr}\n  > `)).trim();
    const ans = raw || (def !== undefined ? String(def) : '');
    const n = parseInt(ans, 10);
    if (!Number.isNaN(n) && n >= min && n <= max) return n;
    console.log(`  (please enter a number between ${min} and ${max})`);
  }
}

async function collectAnswers(): Promise<Answers> {
  const rl = createInterface({ input, output });
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Voice profile generator');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  ~15 questions. Aim for honesty over polish — the more specific');
  console.log('  your answers, the more your generated profile sounds like you.');
  console.log('  Press Enter on a blank line to use defaults [in brackets].');
  console.log(`  Answers saved to ${ANSWERS_PATH}`);
  console.log('  so you can re-run this anytime.');

  let prev: Partial<Answers> = {};
  if (existsSync(ANSWERS_PATH)) {
    try {
      prev = JSON.parse(readFileSync(ANSWERS_PATH, 'utf8'));
      console.log('\n  Found previous answers — defaults preloaded from prior session.');
    } catch {
      // ignore
    }
  }

  console.log('\n--- Identity ---');
  const name = await ask(rl, '1/15  Your full name', { default: prev.name, required: true });
  const role = await ask(rl, '2/15  Your role / title (e.g., "Founder", "Senior PM", "Indie hacker")', { default: prev.role, required: true });
  const company = await ask(rl, '3/15  Company name (or leave blank if independent)', { default: prev.company });
  const bio = await ask(rl, '4/15  One-line bio — how you describe what you do (~10-20 words)', { default: prev.bio, required: true });

  console.log('\n--- Voice register ---');
  const adjRaw = await ask(rl, '5/15  Pick 3 words that describe how you write online (comma-separated)\n      Examples: direct, witty, technical, warm, formal, sarcastic, dry, contrarian, earnest, playful', { default: prev.adjectives?.join(', '), required: true });
  const adjectives = adjRaw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);

  const cadence = await askChoice(rl, '6/15  Default casing in your writing', ['lowercase', 'mixed', 'proper'] as const, prev.cadence ?? 'mixed');
  const swearing = await askChoice(rl, '7/15  Swearing in your comments', ['never', 'rare', 'often'] as const, prev.swearing ?? 'never');
  const sarcasm = await askInt(rl, '8/15  Sarcasm level (1 = earnest, 10 = scorched earth)', 1, 10, prev.sarcasm ?? 5);
  const inspirations = await ask(rl, '9/15  Three writers/posters whose tone you\'d happily borrow\n      (LinkedIn / X / Substack / books — names or handles)', { default: prev.inspirations });

  console.log('\n--- Substance ---');
  const topicsRaw = await ask(rl, '10/15 Top 3 topics you\'ll comment on most (comma-separated)\n      Example: "B2B SaaS, GTM strategy, indie founders"', { default: prev.topics?.join(', '), required: true });
  const topics = topicsRaw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);

  const angle = await ask(rl, '11/15 Your unique angle — what perspective do you bring others don\'t?\n      Examples: "ex-engineer turned PM", "operator at a 200-person co",\n      "indie founder shipping weekly", "consultant with 50 deployments"', { default: prev.angle, required: true });

  console.log('\n12/15 Paste 2-3 short examples of YOUR actual writing — comments, tweets,');
  console.log('      paragraphs you\'re proud of. These anchor the model in real you.');
  const samples: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const s = await askMultiline(rl, `      Sample ${i}/3`, 'sample text');
    if (!s) {
      if (i === 1) {
        console.log('  (at least 1 sample is strongly recommended; continuing with 0)');
      }
      break;
    }
    samples.push(s);
  }

  const annoyancesRaw = await ask(rl, '13/15 What 3 things annoy you most about typical LinkedIn comments?\n      These get banned. (comma-separated)\n      Examples: "fake humility, name-dropping, calling everything a journey"', { default: prev.annoyances?.join(', '), required: true });
  const annoyances = annoyancesRaw.split(',').map(s => s.trim()).filter(Boolean);

  console.log('\n--- Goals ---');
  const goals = await ask(rl, '14/15 Why are you commenting? (build network / signal craft / find clients / learn / mix)', { default: prev.goals ?? 'build network + signal craft' });
  const audience = await ask(rl, '15/15 Who do you want to attract? Be specific.\n      Example: "founders running 10-50 person SaaS", "design directors at agencies"', { default: prev.audience, required: true });

  rl.close();

  return { name, role, company, bio, adjectives, cadence, swearing, sarcasm, inspirations, topics, angle, samples, annoyances, goals, audience };
}

async function synthesize(answers: Answers, template: string): Promise<{ profile: string; via: 'claude' | 'fallback' }> {
  const meta = `You are filling in a voice profile template for a LinkedIn comment generator.

The template below has {{PLACEHOLDERS}} that you must replace with personalized content based on the user's answers. Sections WITHOUT placeholders must be reproduced VERBATIM — they are universal LinkedIn anti-cope rules. Do not paraphrase them.

Replace {{NAME}} with the user's name everywhere it appears.

CRITICAL personalization rules:

- {{COMPANY_CLAUSE}}: ", Founder of <Company>" if company present, or ", <Role> at <Company>" depending on role wording, or "" if independent.
- {{ANGLE_DESCRIPTOR}}: short noun phrase capturing their angle (e.g., "builder-perspective", "operator", "ex-engineer", "design-trained"). Use lowercase. 1-3 words.
- {{VOICE_ONE_LINER}}: 2-3 sentences capturing how this user writes. Use their adjectives, register, and angle. Do NOT copy generic phrases like "direct, no fluff." Make it specific to them — reference their actual angle and goals.
- {{TONE_PATTERNS}}: 4-6 SPECIFIC patterns derived from the writing samples and adjectives. Each pattern is a bold name (in **bold**), then 1-2 sentences explaining it, then a concrete example phrase. Look at their samples and extract real moves they make (specific words, structures, rhythms). Do NOT invent patterns they don't actually use. If samples are too thin to extract, generate 4-6 patterns aligned with their adjectives + angle, but mark each with a concrete example.
- {{CADENCE_LABEL}}: pick one of "mostly lowercase" / "mixed case" / "proper sentences" based on the user's cadence answer.
- {{CADENCE_DESCRIPTION}}: one short paragraph (2-3 sentences) explaining when capitals are used in their writing.
- {{CUSTOM_BANS}}: a new section starting with "**Personal banned phrases / patterns:**" listing each annoyance from the user as a banned pattern. Plain markdown, one short paragraph or list.
- {{EXAMPLES}}: 4 worked examples. Format each one EXACTLY like:
    OP claim: "<plausible LinkedIn post claim>"
    → \`<the comment>\`
  The comments must sound like the user wrote them — match their adjectives, cadence, swearing rule, sarcasm level. Pull style from samples. Each comment 1-3 sentences, under 280 chars, no exclamation marks, no em dashes, no hashtags.

Adjustments based on answers:
- swearing = "never": zero swears in examples
- swearing = "rare": 1 swear in 4 examples (censored with #, e.g., "f#ck")
- swearing = "often": 2 swears in 4 examples (censored)
- sarcasm < 4: examples are earnest, not sarcastic
- sarcasm 4-7: dry but professional
- sarcasm > 7: lean dry/sarcastic, deflate hype
- cadence = "lowercase": examples are mostly lowercase
- cadence = "mixed": sentence starts capitalized, internal pivots can lowercase
- cadence = "proper": full proper capitalization

USER ANSWERS:

Name: ${answers.name}
Role: ${answers.role}
Company: ${answers.company || '(independent)'}
Bio: ${answers.bio}
Adjectives: ${answers.adjectives.join(', ')}
Cadence: ${answers.cadence}
Swearing: ${answers.swearing}
Sarcasm (1-10): ${answers.sarcasm}
Inspirations: ${answers.inspirations || '(none given)'}
Topics: ${answers.topics.join(', ')}
Angle: ${answers.angle}

Writing samples (most important signal for tone patterns and example style):
${answers.samples.length === 0 ? '(none provided)' : answers.samples.map((s, i) => `--- Sample ${i + 1} ---\n${s}`).join('\n\n')}

Annoyances (must ban): ${answers.annoyances.join(', ')}
Goals: ${answers.goals}
Target audience: ${answers.audience}

---

TEMPLATE TO FILL:

${template}

---

Output ONLY the filled-in voice profile markdown. No preamble, no commentary, no code fences. Start directly with "# ${answers.name}'s LinkedIn Comment Generator — Tone Rules". The output must contain ZERO remaining {{PLACEHOLDER}} patterns.`;

  console.log('\nSynthesizing voice profile via claude CLI... (20-60s)');
  try {
    const res = await execFileAsync(
      'claude',
      ['-p', meta, '--output-format', 'json', '--model', 'claude-sonnet-5-5'],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 180_000 }
    );
    const parsed = JSON.parse(res.stdout);
    const out = (parsed.result ?? '').trim();
    if (!out) throw new Error('empty result from claude CLI');
    const cleaned = out.replace(/^```(?:markdown)?\s*\n/, '').replace(/\n```\s*$/, '').trim();
    if (cleaned.includes('{{')) {
      console.warn('  ⚠ Synthesis output still contains placeholder markers — falling back.');
      return { profile: basicSubstitute(answers, template), via: 'fallback' };
    }
    return { profile: cleaned, via: 'claude' };
  } catch (err: any) {
    console.warn(`\n⚠ claude CLI synthesis failed: ${err.message}`);
    console.warn('  Falling back to basic substitution. Edit voice-profile.md manually or re-run after fixing claude CLI.\n');
    return { profile: basicSubstitute(answers, template), via: 'fallback' };
  }
}

function basicSubstitute(a: Answers, t: string): string {
  const company = a.company ? `, ${a.role} at ${a.company}` : '';
  const adjList = a.adjectives.join(', ');
  const cadenceLabel = a.cadence === 'lowercase' ? 'mostly lowercase' : a.cadence === 'mixed' ? 'mixed case' : 'proper sentences';
  const sampleBlock = a.samples.length > 0
    ? a.samples.map((s, i) => `\n*Sample ${i + 1} (your own words):* ${s}`).join('\n')
    : '(no samples provided — add patterns manually)';

  return t
    .replaceAll('{{NAME}}', a.name)
    .replaceAll('{{ROLE}}', a.role)
    .replaceAll('{{COMPANY_CLAUSE}}', company)
    .replaceAll('{{ANGLE_DESCRIPTOR}}', a.angle.toLowerCase().split(' ').slice(0, 3).join('-'))
    .replaceAll('{{VOICE_ONE_LINER}}', `${adjList}. ${a.bio}`)
    .replaceAll('{{TONE_PATTERNS}}', `(Synthesis stub — re-run \`npm run voice:init\` once \`claude\` CLI is available\nfor a properly synthesized profile. For now, here are your raw answers as reference:\n\n**Adjectives:** ${adjList}\n**Angle:** ${a.angle}\n**Inspirations:** ${a.inspirations || 'n/a'}\n**Sarcasm:** ${a.sarcasm}/10\n${sampleBlock})`)
    .replaceAll('{{CADENCE_LABEL}}', cadenceLabel)
    .replaceAll('{{CADENCE_DESCRIPTION}}', `Default register: ${cadenceLabel}. Capitals reserved for proper nouns and emphasis.`)
    .replaceAll('{{CUSTOM_BANS}}', `**Personal banned phrases / patterns:**\n${a.annoyances.map(x => `- ${x}`).join('\n')}`)
    .replaceAll('{{EXAMPLES}}', `(Synthesis stub — examples will be generated once you re-run with \`claude\` CLI available.)`);
}

async function main() {
  if (!existsSync(TEMPLATE_PATH)) {
    console.error(`Template missing: ${TEMPLATE_PATH}`);
    process.exit(1);
  }

  if (existsSync(PROFILE_PATH)) {
    const rl = createInterface({ input, output });
    const ans = (await rl.question(`\nvoice-profile.md already exists. Overwrite? [y/N] `)).trim().toLowerCase();
    rl.close();
    if (ans !== 'y' && ans !== 'yes') {
      console.log('Aborted.');
      process.exit(0);
    }
    const backup = PROFILE_PATH + '.bak';
    copyFileSync(PROFILE_PATH, backup);
    console.log(`Backed up existing profile to: ${backup}`);
  }

  const template = readFileSync(TEMPLATE_PATH, 'utf8');
  const answers = await collectAnswers();

  mkdirSync(ANSWERS_DIR, { recursive: true });
  writeFileSync(ANSWERS_PATH, JSON.stringify(answers, null, 2), 'utf8');

  const { profile, via } = await synthesize(answers, template);
  writeFileSync(PROFILE_PATH, profile, 'utf8');

  console.log(`\n✓ Voice profile written to: ${PROFILE_PATH}`);
  console.log(`  Source: ${via === 'claude' ? 'claude CLI synthesis' : 'fallback substitution (run again with claude CLI available for full synthesis)'}`);
  console.log(`  Answers saved to:          ${ANSWERS_PATH}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Open the file and skim it: src/ai/voice-profile.md`);
  console.log(`  2. Test it on a real post:    npm run draft:test -- "<paste a post>"`);
  console.log(`  3. If it doesn't sound like you, tweak the file directly or re-run \`npm run voice:init\`.\n`);
}

main().catch((err) => { console.error(err); process.exit(1); });
