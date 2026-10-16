import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp, evaluateExpression, executeTool, MAX_TOOL_ROUNDS } from './server.mjs';

const BASE = 'deepseek-ai/Test-Nano';
const usage = { prompt_tokens: 120, completion_tokens: 25, total_tokens: 145, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 9 } };
const sse = obj => 'data: ' + JSON.stringify(obj) + '\n\n';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

test('local server forwards chats with images, reasoning, usage and tools', async t => {
  const received = [];
  let auth;
  const upstream = http.createServer(async (req, res) => {
    auth = req.headers.authorization;
    if (req.url === '/models') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: BASE }] })); }
    let raw = ''; for await (const c of req) raw += c;
    const body = JSON.parse(raw); received.push(body);
    if (body.model === 'denied') { res.writeHead(401); return res.end('private upstream diagnostic'); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (body.model === 'boom') return res.end(sse({ choices: [{ delta: { content: 'Partial ' } }] }) + sse({ error: { message: 'upstream exploded' } }));
    if (body.model === 'tool' || body.model === 'loop') {
      const lastRole = body.messages.at(-1).role;
      if (body.model === 'loop' || lastRole !== 'tool') {
        return res.end(
          sse({ choices: [{ delta: { role: 'assistant', content: '' }, finish_reason: null }] }) +
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_test_1', type: 'function', function: { name: 'calculator', arguments: '' } }] }, finish_reason: null }] }) +
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: null, arguments: '{"expression": "2' } }] }, finish_reason: null }] }) +
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: null, arguments: '+2"}' } }] }, finish_reason: null }] }) +
          sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage }) +
          'data: [DONE]\n\n'
        );
      }
    }
    res.end(
      sse({ choices: [{ delta: { reasoning_content: 'Let me think. ' } }] }) +
      sse({ choices: [{ delta: { content: 'Hello ' } }] }) +
      sse({ choices: [{ delta: { content: 'AIBrain' } }] }) +
      sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }) +
      'data: [DONE]\n\n'
    );
  });
  const up = await listen(upstream);
  const app = createApp({ apiKey: 'test-secret', upstream: up }); const url = await listen(app);
  const missing = createApp({ apiKey: '' }); const missingURL = await listen(missing);
  t.after(() => { for (const s of [app, upstream, missing]) { s.closeAllConnections(); s.close(); } });
  const post = (body, headers = {}) => fetch(url + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const payload = { model: BASE, max_tokens: 4096, temperature: 0.5, top_p: 0.9, stop: ['END'], reasoning_effort: 'none', systemPrompt: 'Be brief.', foo: 'bar', messages: [{ role: 'user', content: 'My name is AIBrain' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'What is my name?' }] };

  await t.test('serves page, JS and CSS with the Build with AI brand', async () => {
    for (const route of ['/', '/app.js', '/style.css']) assert.equal((await fetch(url + route)).status, 200);
    assert.match(await (await fetch(url + '/')).text(), /BUILD WITH AI/);
  });
  await t.test('does not serve private files', async () => { assert.equal((await fetch(url + '/.env')).status, 404); assert.equal((await fetch(url + '/server.mjs')).status, 404); });
  await t.test('config never reveals the key and lists pricing and tools', async () => {
    const text = await (await fetch(url + '/api/config')).text();
    assert.ok(!text.includes('test-secret'));
    const config = JSON.parse(text);
    assert.equal(config.configured, true);
    assert.ok(config.pricing[BASE.replace('Test-Nano', 'DeepSeek-V4.1-Flash')]);
    assert.ok(config.tools.includes('calculator'));
  });
  await t.test('forwards history, auth, settings and streams normalized events', async () => {
    received.length = 0;
    const r = await post(payload);
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.match(text, /"type":"content","text":"Hello "/);
    assert.match(text, /"type":"content","text":"AIBrain"/);
    assert.match(text, /"type":"reasoning","text":"Let me think\. "/);
    assert.match(text, /"type":"usage"/);
    assert.match(text, /"type":"done","finish_reason":"stop"/);
    assert.equal(auth, 'Bearer test-secret');
    const sent = received[0];
    assert.deepEqual(sent.messages, [{ role: 'system', content: 'Be brief.' }, ...payload.messages]);
    assert.equal(sent.stream, true);
    assert.equal(sent.stream_options.include_usage, true);
    assert.equal(sent.temperature, 0.5);
    assert.equal(sent.top_p, 0.9);
    assert.deepEqual(sent.stop, ['END']);
    assert.equal(sent.reasoning_effort, 'none');
    assert.equal(sent.model, BASE);
    assert.equal(sent.max_tokens, 4096);
    assert.equal(sent.foo, undefined);
  });
  await t.test('refreshes models', async () => { assert.deepEqual(await (await fetch(url + '/api/models')).json(), { models: [BASE] }); });
  await t.test('rejects foreign origins', async () => { assert.equal((await post(payload, { Origin: 'https://untrusted.example' })).status, 403); });
  await t.test('validates messages, settings and images', async () => {
    const tests = [
      { ...payload, messages: [{ role: 'system', content: 'x' }] },
      { ...payload, max_tokens: 999999 },
      { ...payload, temperature: 3 },
      { ...payload, top_p: 0 },
      { ...payload, stop: ['a', 'b', 'c', 'd', 'e'] },
      { ...payload, reasoning_effort: 'bogus' },
      { ...payload, model: 'zai-org/GLM-Test', reasoning_effort: 'none' },
      { ...payload, systemPrompt: 'x'.repeat(4001) },
      { ...payload, tools: 'yes' },
      { ...payload, messages: [{ role: 'user', content: 'x'.repeat(100001) }] },
      { ...payload, messages: Array.from({ length: 101 }, () => ({ role: 'user', content: 'x' })) },
      { ...payload, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }] },
      { ...payload, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }] },
      { ...payload, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/svg+xml;base64,PHN2Zz4=' } }] }] }
    ];
    for (const body of tests) assert.equal((await post(body)).status, 400);
  });
  await t.test('accepts and forwards image parts', async () => {
    received.length = 0;
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } };
    const imagePayload = { ...payload, systemPrompt: undefined, messages: [{ role: 'user', content: [{ type: 'text', text: 'What is this?' }, image] }] };
    const r = await post(imagePayload);
    assert.equal(r.status, 200);
    await r.text();
    assert.deepEqual(received[0].messages, imagePayload.messages);
  });
  await t.test('runs the tool loop and returns the final answer', async () => {
    received.length = 0;
    const r = await post({ model: 'tool', max_tokens: 4096, tools: true, messages: [{ role: 'user', content: 'What is 2+2?' }] });
    assert.equal(r.status, 200);
    const text = await r.text();
    const events = text.trim().split('\n\n').map(block => JSON.parse(block.slice(6)));
    assert.ok(events.some(e => e.type === 'tool' && e.name === 'calculator' && e.ok === true && JSON.parse(e.result).value === 4));
    assert.ok(events.some(e => e.type === 'content' && e.text === 'AIBrain'));
    assert.equal(events.find(e => e.type === 'done').finish_reason, 'stop');
    const sent = received.filter(b => b.model === 'tool');
    assert.equal(sent.length, 2);
    assert.equal(sent[0].tools.length, 3);
    assert.equal(sent[0].tool_choice, 'auto');
    const followUp = sent[1].messages;
    assert.equal(followUp.at(-2).role, 'assistant');
    assert.equal(followUp.at(-2).tool_calls[0].id, 'call_test_1');
    assert.equal(followUp.at(-1).role, 'tool');
    assert.equal(followUp.at(-1).tool_call_id, 'call_test_1');
    assert.match(followUp.at(-1).content, /"value":4/);
  });
  await t.test('stops after the tool round limit', async () => {
    received.length = 0;
    const r = await post({ model: 'loop', max_tokens: 4096, tools: true, messages: [{ role: 'user', content: 'loop please' }] });
    const text = await r.text();
    assert.match(text, /"type":"done","finish_reason":"tool_limit"/);
    assert.equal((text.match(/"type":"tool"/g) ?? []).length, MAX_TOOL_ROUNDS);
    assert.equal(received.filter(b => b.model === 'loop').length, MAX_TOOL_ROUNDS + 1);
  });
  await t.test('surfaces mid-stream upstream errors as events', async () => {
    const r = await post({ model: 'boom', max_tokens: 4096, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.match(text, /"type":"content","text":"Partial "/);
    assert.match(text, /"type":"error","message":"upstream exploded"/);
  });
  await t.test('handles missing credentials', async () => { assert.equal((await fetch(missingURL + '/api/models')).status, 503); });
  await t.test('handles upstream auth errors without raw diagnostics', async () => {
    const r = await post({ model: 'denied', max_tokens: 4096, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 401);
    const text = await r.text();
    assert.match(text, /API key/);
    assert.ok(!text.includes('private upstream'));
  });
});

test('works with any OpenAI-compatible provider', async t => {
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/models') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'acme/chat-1' }] })); }
    let raw = ''; for await (const c of req) raw += c;
    const body = JSON.parse(raw); received.push(body);
    if (body.stream_options) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'stream_options unsupported' } })); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(sse({ choices: [{ delta: { content: 'works anywhere' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
  });
  const up = (await listen(upstream)) + '/';
  const app = createApp({ apiKey: 'other-key', upstream: up, models: ['acme/chat-1', 'acme/chat-2'] });
  const url = await listen(app);
  t.after(() => { for (const s of [app, upstream]) { s.closeAllConnections(); s.close(); } });
  await t.test('serves the custom model list from config', async () => {
    const config = await (await fetch(url + '/api/config')).json();
    assert.deepEqual(config.models, ['acme/chat-1', 'acme/chat-2']);
    assert.equal(config.configured, true);
  });
  await t.test('normalizes trailing slashes and retries without stream_options on 400', async () => {
    received.length = 0;
    const r = await fetch(url + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'acme/chat-1', max_tokens: 4096, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.match(text, /"type":"content","text":"works anywhere"/);
    assert.match(text, /"type":"done","finish_reason":"stop"/);
    assert.equal(received.length, 2);
    assert.ok(received[0].stream_options);
    assert.equal(received[1].stream_options, undefined);
  });
  await t.test('lists provider models through /api/models', async () => {
    assert.deepEqual(await (await fetch(url + '/api/models')).json(), { models: ['acme/chat-1'] });
  });
});

test('tool executors are safe and correct', async t => {
  await t.test('calculator evaluates expressions', () => {
    assert.equal(evaluateExpression('2+2'), 4);
    assert.equal(evaluateExpression('(2+3)*4^2'), 80);
    assert.equal(evaluateExpression('10%3'), 1);
    assert.equal(evaluateExpression('-2^2'), -4);
    assert.equal(evaluateExpression('1.5 * 4'), 6);
    for (const bad of ['alert(1)', 'process.exit()', '1/0', '2+', '', 'a+b']) assert.throws(() => evaluateExpression(bad));
  });
  await t.test('runs built-in tools through the executor', async () => {
    const sum = await executeTool('calculator', { expression: '2+2' });
    assert.equal(sum.ok, true);
    assert.equal(JSON.parse(sum.result).value, 4);
    const time = await executeTool('current_time', {});
    assert.equal(time.ok, true);
    assert.ok(JSON.parse(time.result).iso);
    const unknown = await executeTool('nope', {});
    assert.equal(unknown.ok, false);
    assert.match(unknown.result, /Unknown tool/);
    const badLang = await executeTool('wikipedia_lookup', { query: 'x', language: '!!' });
    assert.equal(badLang.ok, false);
    assert.match(badLang.result, /language/i);
    const noQuery = await executeTool('wikipedia_lookup', {});
    assert.equal(noQuery.ok, false);
  });
});
