// Dev tool: crawl a hackathon site and extract event info without Discord.
//   npm run try:extract -- <url> [--model provider:id] [--no-render] [--crawl-only] [--text]
import 'dotenv/config';
import { extractEventInfo } from '../ai/extractEvent.js';
import { modelSpecFor } from '../ai/llm.js';
import { normalizeEvent } from '../events/normalize.js';
import { crawl } from '../web/crawl.js';
import { fetchHtml } from '../web/fetch.js';
import { createRenderer } from '../web/render.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const url = args.find((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--model');
if (!url) {
  console.error('Usage: npm run try:extract -- <url> [--model provider:id] [--no-render] [--crawl-only] [--text]');
  process.exit(1);
}

const renderer = flag('--no-render') ? null : await createRenderer();
const started = Date.now();
let result;
try {
  result = await crawl(url, { fetchHtml, renderer });
} finally {
  await renderer?.close();
}

console.log(`\nCrawled in ${((Date.now() - started) / 1000).toFixed(1)}s. Event: ${result.eventName ?? '?'}`);
console.log(`Sites: devpost=${result.roles.devpostHost ?? '-'} official=${result.roles.officialHost ?? '-'}`);
for (const page of result.pages) {
  console.log(`  read ${page.rendered ? 'rendered' : 'plain   '} ${String(page.text.length).padStart(6)} chars  ${page.url}`);
}
for (const page of result.skipped) console.log(`  skip ${page.url} (${page.reason})`);
if (flag('--text')) {
  for (const page of result.pages) console.log(`\n----- ${page.url}\n${page.text}`);
}
if (flag('--crawl-only')) process.exit(0);

const model = option('--model') ?? modelSpecFor('extract');
console.log(`\nExtracting with ${model}...`);
const extractStarted = Date.now();
const raw = await extractEventInfo(
  { startUrl: url, pages: result.pages, eventHints: result.eventHints, pastedText: null },
  model,
);
const event = normalizeEvent(raw);
console.log(`Extracted in ${((Date.now() - extractStarted) / 1000).toFixed(1)}s\n`);

const { timeline, ...rest } = event;
console.log(JSON.stringify(rest, null, 2));
console.log(`\nTimeline (${timeline.length} items, ${event.unreadableTimes} unreadable):`);
for (const item of timeline) {
  const where = item.location ? ` @ ${item.location}` : '';
  console.log(`  ${item.localStart} local = ${item.startsAt ?? '(no zone)'} UTC  [${item.kind}] ${item.title}${where}`);
}
