// Queue externally-drafted comments when the `claude -p` subprocess can't run
// (expired CLI OAuth). Pairs with the DUMP_ELIGIBLE escape hatch in scan.ts:
//
//   DUMP_ELIGIBLE=/tmp/eligible.json npm run scan
//   <draft the comments, write a JSON array of strings, "SKIP" to skip a post>
//   npm run queue:drafts -- /tmp/eligible.json /tmp/drafts.json
//
// Runs the same guardrails the drafter pipeline runs, then queues + marks seen.
import { readFileSync } from 'node:fs';
import { createPending, countByStatus } from '../queue.js';
import { markPostSeen, getRecentComments } from '../cache/sqlite.js';
import { validateDraft } from '../ai/guardrails.js';
import { syncVault } from '../vault/sync.js';

const [eligiblePath, draftsPath] = process.argv.slice(2);
if (!eligiblePath || !draftsPath) {
  console.error('usage: npm run queue:drafts -- <eligible.json> <drafts.json>');
  process.exit(1);
}

const posts = JSON.parse(readFileSync(eligiblePath, 'utf8'));
const drafts: string[] = JSON.parse(readFileSync(draftsPath, 'utf8'));
if (posts.length !== drafts.length) {
  console.error(`length mismatch: ${posts.length} posts vs ${drafts.length} drafts`);
  process.exit(1);
}

const recent = getRecentComments(20);
const accepted: string[] = [];
let queued = 0;
let skipped = 0;

for (let i = 0; i < posts.length; i++) {
  const draft = drafts[i].trim();
  if (draft === 'SKIP') {
    console.log(`  · ${posts[i].author}: SKIP`);
    skipped++;
    continue;
  }
  const check = validateDraft(draft, recent, accepted);
  if (!check.ok) {
    console.log(`  ✗ ${posts[i].author}: ${check.reason}`);
    skipped++;
    continue;
  }
  await createPending({
    author: posts[i].author,
    postUrl: posts[i].postUrl,
    postText: posts[i].text,
    draft,
  });
  markPostSeen(posts[i].postUrl, posts[i].author);
  accepted.push(draft);
  queued++;
  console.log(`  ✓ ${posts[i].author}: ${draft.slice(0, 60)}...`);
}

console.log(`\nQueued ${queued}, skipped ${skipped}.`, await countByStatus());
await syncVault();
