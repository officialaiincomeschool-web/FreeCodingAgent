import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
    for (const route of ['/', '/app.js', '/style.css', '/icon.svg']) assert.equal((await fetch(url + route)).status, 200);
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

test('provider can be configured from the page', async t => {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    if (req.url === '/models') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'ui/chat-1' }, { id: 'ui/chat-2' }] })); }
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(sse({ choices: [{ delta: { content: 'hello from the UI provider' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
  });
  const up = await listen(upstream);
  const app = createApp({ apiKey: '', upstream: 'https://unset.example/v1' }); const url = await listen(app);
  t.after(() => { for (const s of [app, upstream]) { s.closeAllConnections(); s.close(); } });
  const post = (path, body) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  await t.test('starts unconfigured without env keys', async () => {
    const config = await (await fetch(url + '/api/config')).json();
    assert.equal(config.configured, false);
    assert.equal(config.source, null);
    assert.equal((await fetch(url + '/api/models')).status, 503);
  });
  await t.test('rejects bad provider input', async () => {
    assert.equal((await post('/api/provider', { baseUrl: 'not a url', apiKey: 'k' })).status, 400);
    assert.equal((await post('/api/provider', { baseUrl: 'https://api.example.com/v1' })).status, 400);
    assert.equal((await post('/api/provider', { baseUrl: 'https://api.example.com/v1', apiKey: 'has space' })).status, 400);
    assert.equal((await post('/api/provider', { baseUrl: 'ftp://api.example.com/v1', apiKey: 'k' })).status, 400);
    assert.equal((await post('/api/provider', { baseUrl: 'http://user:pass@api.example.com/v1', apiKey: 'k' })).status, 400);
  });
  await t.test('connects, loads models and chats through the UI provider', async () => {
    seen.length = 0;
    const r = await post('/api/provider', { baseUrl: up + '/', apiKey: 'ui-secret' });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.source, 'ui');
    assert.deepEqual(data.models, ['ui/chat-1', 'ui/chat-2']);
    assert.equal(seen[0].url, '/models');
    assert.equal(seen[0].auth, 'Bearer ui-secret');

    const chat = await post('/api/chat', { model: 'ui/chat-1', max_tokens: 4096, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(chat.status, 200);
    const text = await chat.text();
    assert.match(text, /hello from the UI provider/);
    assert.equal(seen.at(-1).url, '/chat/completions');
    assert.equal(seen.at(-1).auth, 'Bearer ui-secret');

    const config = await (await fetch(url + '/api/config')).json();
    assert.equal(config.configured, true);
    assert.equal(config.source, 'ui');
    const raw = JSON.stringify(config);
    assert.ok(!raw.includes('ui-secret'), 'config must never reveal the key');
  });
  await t.test('clearing the provider falls back to env settings', async () => {
    const r = await post('/api/provider', { baseUrl: '', apiKey: '' });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.source, null);
    assert.equal(data.configured, false);
    assert.equal((await fetch(url + '/api/models')).status, 503);
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

test('coding agent workspace: reads files, proposes edits, needs approval', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'riverchat-agent-'));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  await writeFile(path.join(dir, 'hello.js'), 'function add(a, b) {\n  return a + b;\n}\n');
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, 'src', 'notes.txt'), 'alpha\nbeta\ngamma\n');

  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/models') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'agent/model' }] })); }
    let raw = ''; for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (body.messages.at(-1).role === 'tool') {
      return res.end(sse({ choices: [{ delta: { content: 'Tool said: ' + body.messages.at(-1).content.slice(0, 160) } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }) + 'data: [DONE]\n\n');
    }
    const calls = {
      'agent-read': ['read_file', { path: 'hello.js' }],
      'agent-list': ['list_files', { path: 'src' }],
      'agent-search': ['search_files', { query: 'beta' }],
      'agent-write': ['write_file', { path: 'new/deep/river.txt', content: 'hello from the agent\n' }],
      'agent-edit': ['edit_file', { path: 'hello.js', old_string: 'return a + b;', new_string: 'return a + b; // sum' }],
      'agent-deny': ['write_file', { path: 'never.txt', content: 'should not exist\n' }],
      'agent-escape': ['write_file', { path: '../riverchat-escape-check.txt', content: 'nope\n' }]
    };
    const [name, args] = calls[body.model];
    res.end(
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }) +
      sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage }) +
      'data: [DONE]\n\n'
    );
  });
  const up = await listen(upstream);
  let pickHandler = () => Promise.resolve(null); // replaced per test; the default pretends the user canceled
  const app = createApp({ apiKey: 'test-secret', upstream: up, folderPicker: () => pickHandler() });
  const url = await listen(app);
  t.after(() => { for (const s of [app, upstream]) { s.closeAllConnections(); s.close(); } });

  const api = (pathname, body) => fetch(url + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const chat = model => api('/api/chat', { model, max_tokens: 4096, tools: true, messages: [{ role: 'user', content: 'go' }] });
  const collect = async (response, onEvent) => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const events = [];
    let buffer = '';
    const handleBlock = async block => {
      const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n').trim();
      if (!data) return;
      const item = JSON.parse(data);
      events.push(item);
      if (onEvent) await onEvent(item);
    };
    for (;;) {
      const part = await reader.read();
      buffer += part.done ? decoder.decode() : decoder.decode(part.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) { const block = buffer.slice(0, cut); buffer = buffer.slice(cut + 2); await handleBlock(block); }
      if (part.done) break;
    }
    if (buffer.trim()) await handleBlock(buffer);
    return events;
  };

  await t.test('sets, validates and clears the project folder', async () => {
    assert.equal((await api('/api/workspace', { path: path.join(dir, 'missing') })).status, 400);
    assert.equal((await api('/api/workspace', { path: path.join(dir, 'hello.js') })).status, 400);
    assert.equal((await api('/api/workspace/approval', { id: 'nope', approve: true })).status, 404);
    const ok = await api('/api/workspace', { path: dir });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).ready, true);
    const config = await (await fetch(url + '/api/config')).json();
    assert.equal(config.workspace.ready, true);
    assert.equal(config.workspace.root.toLowerCase(), dir.toLowerCase());
    const cleared = await api('/api/workspace', { path: '' });
    assert.equal((await cleared.json()).ready, false);
    const foreign = await fetch(url + '/api/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, body: JSON.stringify({ path: dir }) });
    assert.equal(foreign.status, 403);
    await api('/api/workspace', { path: dir });
  });

  await t.test('read tools see the project files', async () => {
    const readEvents = await collect(await chat('agent-read'));
    const readTool = readEvents.find(e => e.type === 'tool');
    assert.equal(readTool.ok, true);
    assert.match(readTool.result, /return a \+ b;/);
    assert.ok(readEvents.some(e => e.type === 'done'));

    const listEvents = await collect(await chat('agent-list'));
    assert.match(listEvents.find(e => e.type === 'tool').result, /notes\.txt/);

    const searchEvents = await collect(await chat('agent-search'));
    assert.match(searchEvents.find(e => e.type === 'tool').result, /src\/notes\.txt:2/);
  });

  await t.test('write tools wait for approval, then apply', async () => {
    let proposal = null;
    const events = await collect(await chat('agent-write'), async event => {
      if (event.type === 'proposal') {
        proposal = event;
        assert.equal(event.path, 'new/deep/river.txt');
        assert.equal(event.before, null);
        assert.equal(event.after, 'hello from the agent\n');
        assert.equal((await api('/api/workspace/approval', { id: event.id, approve: true })).status, 200);
      }
    });
    assert.ok(proposal, 'a proposal event should be sent');
    assert.equal(await readFile(path.join(dir, 'new', 'deep', 'river.txt'), 'utf8'), 'hello from the agent\n');
    assert.match(events.find(e => e.type === 'tool').result, /Applied/);
    assert.equal(events.find(e => e.type === 'done').finish_reason, 'stop');
  });

  await t.test('edits require approval and apply exactly', async () => {
    const events = await collect(await chat('agent-edit'), async event => {
      if (event.type === 'proposal') await api('/api/workspace/approval', { id: event.id, approve: true });
    });
    assert.match(await readFile(path.join(dir, 'hello.js'), 'utf8'), /return a \+ b; \/\/ sum/);
    assert.equal(events.find(e => e.type === 'tool').ok, true);
  });

  await t.test('rejected changes are not written', async () => {
    const events = await collect(await chat('agent-deny'), async event => {
      if (event.type === 'proposal') await api('/api/workspace/approval', { id: event.id, approve: false });
    });
    const tool = events.find(e => e.type === 'tool');
    assert.equal(tool.ok, true);
    assert.match(tool.result, /rejected/i);
    await assert.rejects(readFile(path.join(dir, 'never.txt')), /ENOENT/);
  });

  await t.test('cannot escape the project folder', async () => {
    const outside = path.join(dir, '..', 'riverchat-escape-check.txt');
    await rm(outside, { force: true }).catch(() => {});
    const events = await collect(await chat('agent-escape'));
    const tool = events.find(e => e.type === 'tool');
    assert.equal(tool.ok, false);
    assert.match(tool.result, /outside the project folder/);
    assert.ok(!events.some(e => e.type === 'proposal'), 'no proposal should be sent for outside paths');
    await assert.rejects(readFile(outside), /ENOENT/);
  });

  await t.test('save endpoint writes code into the folder, asks before overwrite', async () => {
    const save = body => api('/api/workspace/save', body);
    const first = await save({ path: 'saved/note.txt', content: 'console.log(1);\n' });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).saved, 'saved/note.txt');
    assert.equal(await readFile(path.join(dir, 'saved', 'note.txt'), 'utf8'), 'console.log(1);\n');

    const exists = await save({ path: 'saved/note.txt', content: 'console.log(2);\n' });
    assert.equal(exists.status, 409);
    assert.equal((await exists.json()).exists, true);
    assert.equal(await readFile(path.join(dir, 'saved', 'note.txt'), 'utf8'), 'console.log(1);\n');

    const overwrite = await save({ path: 'saved/note.txt', content: 'console.log(2);\n', overwrite: true });
    assert.equal(overwrite.status, 200);
    assert.equal(await readFile(path.join(dir, 'saved', 'note.txt'), 'utf8'), 'console.log(2);\n');

    assert.equal((await save({ path: '../sneaky.txt', content: 'x' })).status, 400);
    assert.equal((await save({ path: 'saved', content: 'x' })).status, 400);
    assert.equal((await save({ path: 'ok.txt', content: 'x'.repeat(300001) })).status, 400);
  });

  await t.test('folder picker sets the folder; cancel and a busy picker are handled', async () => {
    pickHandler = async () => path.join(dir, 'src');
    const picked = await api('/api/workspace/pick', {});
    assert.equal(picked.status, 200);
    const pickedBody = await picked.json();
    assert.equal(pickedBody.ready, true);
    assert.equal(pickedBody.root.toLowerCase(), path.join(dir, 'src').toLowerCase());
    let config = await (await fetch(url + '/api/config')).json();
    assert.equal(config.workspace.root.toLowerCase(), path.join(dir, 'src').toLowerCase());

    pickHandler = async () => null;
    const canceled = await api('/api/workspace/pick', {});
    assert.equal(canceled.status, 200);
    assert.equal((await canceled.json()).canceled, true);
    config = await (await fetch(url + '/api/config')).json();
    assert.equal(config.workspace.root.toLowerCase(), path.join(dir, 'src').toLowerCase(), 'canceling must keep the previous folder');

    let release, started;
    const startedPromise = new Promise(resolve => { started = resolve; });
    pickHandler = () => new Promise(resolve => { release = resolve; started(); });
    const first = api('/api/workspace/pick', {});
    await startedPromise;
    const second = await api('/api/workspace/pick', {});
    assert.equal(second.status, 409);
    release(path.join(dir, 'hello.js'));
    assert.equal((await first).status, 400, 'a file cannot become the project folder');

    await api('/api/workspace', { path: dir });
  });

  await t.test('clearing the folder turns saves and file tools off', async () => {
    await api('/api/workspace', { path: '' });
    const refused = await api('/api/workspace/save', { path: 'x.txt', content: 'x' });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /project folder/i);

    const events = await collect(await chat('agent-read'));
    const tool = events.find(e => e.type === 'tool');
    assert.equal(tool.ok, false);
    assert.match(tool.result, /no project folder/i);
  });
});
