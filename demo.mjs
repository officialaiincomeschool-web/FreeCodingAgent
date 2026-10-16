// Live capability demo. Start the app first (npm start), then run: npm run demo
// Each example goes through the local server exactly like the browser UI does.
// Total cost for a full run is a fraction of a cent of River credit.
import zlib from 'node:zlib';

const base = process.env.DEMO_URL || 'http://127.0.0.1:3000';
const MODEL = process.env.DEMO_MODEL || 'deepseek-ai/DeepSeek-V4.1-Flash';

async function ask(name, body, { showReasoning = false } = {}) {
  const started = Date.now();
  const response = await fetch(base + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, ...body })
  });
  if (!response.ok) {
    console.log(`\n=== ${name} ===\n  ✖ HTTP ${response.status}: ${(await response.json()).error}`);
    return;
  }
  const events = (await response.text()).trim().split('\n\n').filter(Boolean).map(block => JSON.parse(block.slice(6)));
  const content = events.filter(e => e.type === 'content').map(e => e.text).join('');
  const reasoning = events.filter(e => e.type === 'reasoning').map(e => e.text).join('');
  const tools = events.filter(e => e.type === 'tool');
  const usage = events.find(e => e.type === 'usage')?.usage;
  const finish = events.find(e => e.type === 'done')?.finish_reason;
  console.log(`\n=== ${name} (${((Date.now() - started) / 1000).toFixed(1)}s) ===`);
  for (const t of tools) console.log(`  🔧 ${t.name}(${JSON.stringify(t.args)}) → ${t.result}`);
  if (showReasoning && reasoning) console.log(`  🧠 thinking (${reasoning.length} chars, first 180): ${reasoning.slice(0, 180)}…`);
  console.log(`  💬 ${content}`);
  if (usage) console.log(`  📊 in ${usage.prompt_tokens} (${usage.cached_tokens} cached) · out ${usage.completion_tokens} (${usage.reasoning_tokens} reasoning) · finish: ${finish}`);
}

await ask('1. Plain chat', {
  messages: [{ role: 'user', content: 'Reply with exactly this sentence: Build with AI is ready.' }],
  max_tokens: 2048, reasoning_effort: 'none'
});

await ask('2. Reasoning (effort: high)', {
  messages: [{ role: 'user', content: 'A bat and a ball cost $1.10 together. The bat costs $1.00 more than the ball. How much is the ball? Reply with just the amount.' }],
  max_tokens: 2048, reasoning_effort: 'high'
}, { showReasoning: true });

await ask('3. Tool: calculator', {
  messages: [{ role: 'user', content: 'Use the calculator tool to compute (1482 × 37) + 265.5, then state the result in one short line.' }],
  max_tokens: 2048, tools: true, reasoning_effort: 'none'
});

await ask('4. Tools: current time + Wikipedia', {
  messages: [{ role: 'user', content: 'Use your tools: 1) what is the current date and time here, and 2) give a two-sentence summary of Ada Lovelace from Wikipedia.' }],
  max_tokens: 2048, tools: true, reasoning_effort: 'none'
});

// Build a 200x200 four-quadrant test image in pure Node (no libraries, no network).
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; } return t; })();
const crc32 = buf => { let c = -1; for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const header = Buffer.alloc(4); header.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([header, body, crc]); };
function makeTestPNG() {
  const W = 200, H = 200;
  const color = (top, left) => top ? (left ? [229, 57, 53] : [67, 160, 71]) : (left ? [30, 136, 229] : [253, 216, 53]);
  const raw = Buffer.alloc(H * (1 + W * 3));
  let offset = 0;
  for (let y = 0; y < H; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < W; x++) { const [r, g, b] = color(y < H / 2, x < W / 2); raw[offset++] = r; raw[offset++] = g; raw[offset++] = b; }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const testImage = 'data:image/png;base64,' + makeTestPNG().toString('base64');
await ask('5. Vision (200x200 test image: red/green/blue/yellow quadrants)', {
  messages: [{ role: 'user', content: [{ type: 'text', text: 'This image is split into four quadrants. List their colors clockwise starting from the top-left, in one short line.' }, { type: 'image_url', image_url: { url: testImage } }] }],
  max_tokens: 2048, reasoning_effort: 'none'
});

await ask('6. Conversation memory (3 messages sent as history)', {
  messages: [
    { role: 'user', content: 'My favorite color is teal. Remember it.' },
    { role: 'assistant', content: 'Noted — teal it is.' },
    { role: 'user', content: 'What is my favorite color? Reply with one word.' }
  ],
  max_tokens: 2048, reasoning_effort: 'none'
});

console.log('\nDone. The same prompts work in the UI at ' + base);
