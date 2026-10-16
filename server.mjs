import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
try { process.loadEnvFile(path.join(root, '.env')); } catch (e) { if (e.code !== 'ENOENT') throw e; }

const defaults = ['deepseek-ai/DeepSeek-V4.1-Flash', 'zai-org/GLM-5.3-Flash', 'nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4'];
const envModels = (process.env.MODELS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const envBase = process.env.BASE_URL;
const envKey = envBase ? (process.env.API_KEY || process.env.RIVER_API_KEY) : (process.env.RIVER_API_KEY || process.env.API_KEY);
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

export const PRICING = {
  'deepseek-ai/DeepSeek-V4.1-Flash': { input: 0.12, cached: 0.0024, output: 0.48 },
  'nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4': { input: 0.07, cached: 0.024, output: 0.37 },
  'zai-org/GLM-5.3-Flash': { input: 0.12, cached: 0.024, output: 0.40 }
};

const HINTS = { 401: 'The API key was rejected. Check it under Model & settings, or in .env.', 403: 'This account does not have access to the model.', 404: 'Model or endpoint not found. Refresh models or check the exact model ID.', 402: 'Check your account balance.', 429: 'Rate limit or capacity reached. Wait and try again.' };

const MAX_BODY = 24 * 1024 * 1024;          // 24 MiB, includes base64 images
const MAX_IMAGE_CHARS = 6_000_000;          // ~4.5 MB per image after base64
const MAX_IMAGES = 4;                        // per message
const MAX_TOOL_ROUNDS = 5;
const REQUEST_TIMEOUT_MS = 300000;
export { MAX_TOOL_ROUNDS };

export const BUILTIN_TOOLS = [
  { type: 'function', function: { name: 'calculator', description: 'Evaluate one arithmetic expression. Use this for any math. Supports + - * / % ^ ( ) and decimals.', parameters: { type: 'object', properties: { expression: { type: 'string', description: 'The expression, e.g. (12+8)*3^2' } }, required: ['expression'] } } },
  { type: 'function', function: { name: 'current_time', description: 'Get the current date and time. Optionally for a specific timezone.', parameters: { type: 'object', properties: { timezone: { type: 'string', description: 'IANA timezone name such as Asia/Kolkata. Omit to use the server timezone.' } } } } },
  { type: 'function', function: { name: 'wikipedia_lookup', description: 'Look up a topic on Wikipedia and return a short factual summary with a source URL.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'The topic to look up.' }, language: { type: 'string', description: "Wikipedia language code. Default 'en'." } }, required: ['query'] } } }
];

// ---- tool executors ----

export function evaluateExpression(input) {
  const s = String(input ?? '').replace(/\s+/g, '');
  if (!s) throw new Error('Expression is empty.');
  if (s.length > 120) throw new Error('Expression is too long.');
  if (!/^[0-9+\-*/%^().]+$/.test(s)) throw new Error('Only numbers and + - * / % ^ ( ) are allowed.');
  let i = 0;
  const peek = () => s[i];
  const number = () => { const start = i; while (i < s.length && /[0-9.]/.test(s[i])) i++; if (start === i) throw new Error('Expected a number.'); const n = Number(s.slice(start, i)); if (!Number.isFinite(n)) throw new Error('Invalid number.'); return n; };
  const primary = () => { if (peek() === '(') { i++; const v = sum(); if (peek() !== ')') throw new Error('Missing closing parenthesis.'); i++; return v; } return number(); };
  const power = () => { const base = primary(); if (peek() === '^') { i++; return Math.pow(base, unary()); } return base; };
  function unary() { if (peek() === '-') { i++; return -unary(); } if (peek() === '+') { i++; return unary(); } return power(); }
  function product() { let v = unary(); while (peek() === '*' || peek() === '/' || peek() === '%') { const op = s[i++]; const r = unary(); if ((op === '/' || op === '%') && r === 0) throw new Error('Division by zero.'); v = op === '*' ? v * r : op === '/' ? v / r : v % r; } return v; }
  function sum() { let v = product(); while (peek() === '+' || peek() === '-') { const op = s[i++]; const r = product(); v = op === '+' ? v + r : v - r; } return v; }
  const value = sum();
  if (i !== s.length) throw new Error('Unexpected character at position ' + i + '.');
  if (!Number.isFinite(value)) throw new Error('Result is not a finite number.');
  return value;
}

async function lookupWikipedia(args, signal) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) throw new Error('query is required.');
  const lang = typeof args.language === 'string' && args.language.trim() ? args.language.trim() : 'en';
  if (!/^[a-z][a-z-]{1,9}$/.test(lang)) throw new Error('Invalid language code.');
  const headers = { 'User-Agent': 'RiverChatLocal/1.0 (local personal chat app)', Accept: 'application/json' };
  const limited = signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000);
  const search = await fetch(`https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=3&format=json&origin=*`, { headers, signal: limited });
  if (!search.ok) throw new Error(`Wikipedia search failed (HTTP ${search.status}).`);
  const found = (await search.json()).query?.search ?? [];
  if (!found.length) return JSON.stringify({ query, found: false, note: 'No Wikipedia article matched.' });
  const title = found[0].title;
  const summary = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replaceAll(' ', '_'))}`, { headers, signal: limited });
  if (!summary.ok) throw new Error(`Wikipedia summary failed (HTTP ${summary.status}).`);
  const page = await summary.json();
  return JSON.stringify({ query, title: page.title ?? title, description: page.description ?? '', extract: (page.extract ?? '').slice(0, 1200), url: page.content_urls?.desktop?.page ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`, related: found.slice(1).map(r => r.title) });
}

export async function runTool(name, args, signal) {
  const a = args && typeof args === 'object' ? args : {};
  if (name === 'calculator') {
    if (typeof a.expression !== 'string' || !a.expression.trim()) throw new Error('expression is required.');
    return JSON.stringify({ expression: a.expression, value: evaluateExpression(a.expression) });
  }
  if (name === 'current_time') {
    const tz = typeof a.timezone === 'string' && a.timezone.trim() ? a.timezone.trim() : Intl.DateTimeFormat().resolvedOptions().timeZone;
    let formatted;
    try { formatted = new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' }).format(new Date()); }
    catch { throw new Error(`Unknown timezone "${tz}". Use an IANA name like Asia/Kolkata.`); }
    return JSON.stringify({ timezone: tz, formatted, iso: new Date().toISOString() });
  }
  if (name === 'wikipedia_lookup') return lookupWikipedia(a, signal);
  throw new Error(`Unknown tool "${name}".`);
}

export async function executeTool(name, args, signal) {
  const started = Date.now();
  try { return { ok: true, result: await runTool(name, args, signal), ms: Date.now() - started }; }
  catch (e) { return { ok: false, result: 'Error: ' + (e?.message || 'tool failed'), ms: Date.now() - started }; }
}

// ---- request validation ----

const isText = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 100000;
const isImageURL = url => typeof url === 'string' && url.length <= MAX_IMAGE_CHARS && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/.test(url);

function validContent(content, role) {
  if (typeof content === 'string') return isText(content);
  if (role !== 'user' || !Array.isArray(content) || content.length < 1 || content.length > 12) return false;
  if (content.filter(p => p?.type === 'image_url').length > MAX_IMAGES) return false;
  return content.every(p => p && typeof p === 'object' && ((p.type === 'text' && isText(p.text)) || (p.type === 'image_url' && p.image_url && isImageURL(p.image_url.url))));
}

function validStop(stop) {
  const one = s => typeof s === 'string' && s.length > 0 && s.length <= 100;
  if (stop === undefined) return true;
  if (typeof stop === 'string') return one(stop);
  return Array.isArray(stop) && stop.length >= 1 && stop.length <= 4 && stop.every(one);
}

function allowedEfforts(model) {
  const m = String(model).toLowerCase();
  if (m.includes('deepseek')) return ['none', 'high', 'max'];
  if (m.includes('glm')) return ['low', 'high', 'max'];
  return [];
}

export function createApp({ apiKey = envKey, upstream = envBase || 'https://api.river.ai/v1', models } = {}) {
  const base = String(upstream).replace(/\/+$/, '');
  const modelList = models ?? (envModels.length ? envModels : (base.includes('river.ai') ? defaults : []));
  const provider = { streamUsage: true };
  let uiProvider = null; // provided from the page via POST /api/provider; env values are the fallback
  const active = () => uiProvider ?? { base, key: apiKey };
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
    const host = req.headers.host;
    if (!host || !/^(localhost|127\.0\.0\.1):\d+$/.test(host)) return json(res, 403, { error: 'Use the local URL printed in the terminal.' });
    if (req.headers.origin && ![`http://${host}`].includes(req.headers.origin)) return json(res, 403, { error: 'Cross-origin requests are blocked.' });
    const url = new URL(req.url, `http://${host}`);
    const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/icon.svg': ['icon.svg', 'image/svg+xml'] };
    if (req.method === 'GET' && files[url.pathname]) {
      try { const [file, type] = files[url.pathname]; const content = await readFile(path.join(root, 'public', file)); res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }); res.end(content); }
      catch { json(res, 500, { error: 'Could not load the page.' }); } return;
    }
    const envReady = Boolean(apiKey && !String(apiKey).startsWith('replace_with'));
    if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, {
      configured: Boolean(uiProvider) || envReady,
      source: uiProvider ? 'ui' : (envReady ? 'env' : null),
      baseUrl: uiProvider ? uiProvider.base : (envReady ? base : null),
      models: modelList, pricing: PRICING, tools: BUILTIN_TOOLS.map(t => t.function.name)
    });
    if (!['/api/chat', '/api/models', '/api/provider'].includes(url.pathname)) return json(res, 404, { error: 'Not found' });
    const validMethod = (req.method === 'POST' && url.pathname !== '/api/models') || (req.method === 'GET' && url.pathname === '/api/models');
    if (!validMethod) return json(res, 405, { error: 'Method not allowed' });

    if (url.pathname === '/api/provider') {
      if (!req.headers['content-type']?.includes('application/json')) return json(res, 415, { error: 'Send JSON.' });
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) return json(res, 413, { error: 'Request is too large.' }); chunks.push(chunk); }
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString()); } catch { return json(res, 400, { error: 'Invalid JSON.' }); }
      const baseUrl = typeof payload.baseUrl === 'string' ? payload.baseUrl.trim() : '';
      const key = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
      if (!baseUrl && !key) {
        uiProvider = null;
        return json(res, 200, { source: envReady ? 'env' : null, configured: envReady, baseUrl: envReady ? base : null, models: modelList });
      }
      if (!baseUrl || !key) return json(res, 400, { error: 'Enter both the base URL and the API key.' });
      if (baseUrl.length > 300 || key.length > 500 || /\s/.test(key)) return json(res, 400, { error: 'Check the base URL and the key (keys cannot contain spaces).' });
      let parsed;
      try { parsed = new URL(baseUrl); } catch { return json(res, 400, { error: 'That base URL is not a valid URL.' }); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return json(res, 400, { error: 'Use a plain http(s) base URL without username or password.' });
      const clean = baseUrl.replace(/\/+$/, '');
      let response;
      try { response = await fetch(clean + '/models', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) }); }
      catch { return json(res, 400, { error: 'Could not reach that base URL. Check it and your internet connection.' }); }
      if (!response.ok) return json(res, 400, { error: response.status === 401 ? 'The provider rejected this API key.' : `The provider answered HTTP ${response.status}. Check the base URL and the key.` });
      let data;
      try { data = await response.json(); } catch { return json(res, 400, { error: 'The base URL did not return a model list. Does it end with /v1?' }); }
      uiProvider = { base: clean, key };
      return json(res, 200, { source: 'ui', configured: true, baseUrl: clean, models: (data.data || []).map(m => m.id).filter(id => typeof id === 'string') });
    }

    if (!uiProvider && !envReady) return json(res, 503, { error: 'No API key yet. Open Model & settings in the page and connect your provider, or set API_KEY in .env.' });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    res.on('close', () => controller.abort());

    try {
      const current = active();
      if (url.pathname === '/api/models') {
        const response = await fetch(current.base + '/models', { headers: { Authorization: `Bearer ${current.key}` }, signal: controller.signal });
        if (!response.ok) return json(res, response.status, { error: HINTS[response.status] || `The provider returned HTTP ${response.status}.` });
        const data = await response.json();
        return json(res, 200, { models: (data.data || []).map(m => m.id).filter(id => typeof id === 'string') });
      }

      if (!req.headers['content-type']?.includes('application/json')) return json(res, 415, { error: 'Send JSON.' });
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > MAX_BODY) return json(res, 413, { error: 'Request is too large. Fewer or smaller images, or start a new chat.' }); chunks.push(chunk); }
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString()); } catch { return json(res, 400, { error: 'Invalid JSON.' }); }
      const { model, messages, max_tokens, temperature, top_p, stop, reasoning_effort, tools, systemPrompt } = payload;

      const badMessages = !Array.isArray(messages) || messages.length < 1 || messages.length > 100 ||
        messages.some(m => !m || !['user', 'assistant'].includes(m.role) || !validContent(m.content, m.role));
      if (typeof model !== 'string' || !model.trim() || model.length > 200 || badMessages || !Number.isInteger(max_tokens) || max_tokens < 256 || max_tokens > 16384)
        return json(res, 400, { error: 'Invalid chat settings or messages. Start a new chat if it is too long.' });
      if (temperature !== undefined && (typeof temperature !== 'number' || !(temperature >= 0 && temperature <= 2)))
        return json(res, 400, { error: 'Temperature must be between 0 and 2.' });
      if (top_p !== undefined && (typeof top_p !== 'number' || !(top_p > 0 && top_p <= 1)))
        return json(res, 400, { error: 'Top P must be greater than 0 and at most 1.' });
      if (!validStop(stop)) return json(res, 400, { error: 'Stop sequences: up to 4 non-empty strings.' });
      if (reasoning_effort !== undefined && !allowedEfforts(model).includes(reasoning_effort))
        return json(res, 400, { error: `Reasoning effort is not supported for this model (allowed: ${allowedEfforts(model).join(', ') || 'none'}).` });
      if (systemPrompt !== undefined && (typeof systemPrompt !== 'string' || systemPrompt.length > 4000))
        return json(res, 400, { error: 'System prompt must be text under 4,000 characters.' });
      if (tools !== undefined && typeof tools !== 'boolean') return json(res, 400, { error: 'Invalid tools setting.' });

      const convo = [];
      if (systemPrompt?.trim()) convo.push({ role: 'system', content: systemPrompt.trim() });
      for (const m of messages) convo.push({ role: m.role, content: m.content });

      const extras = {};
      if (temperature !== undefined) extras.temperature = temperature;
      if (top_p !== undefined) extras.top_p = top_p;
      if (stop !== undefined) extras.stop = stop;
      if (reasoning_effort !== undefined) extras.reasoning_effort = reasoning_effort;

      let headersSent = false;
      const out = obj => { if (res.destroyed) return; if (!headersSent) { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' }); headersSent = true; } res.write(`data: ${JSON.stringify(obj)}\n\n`); };

      const usage = { prompt_tokens: 0, cached_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, total_tokens: 0, rounds: 0 };
      let finish = null;

      for (let round = 0; ; round++) {
        const result = await streamCompletion({ model, maxTokens: max_tokens, messages: convo, tools: Boolean(tools), extras, base: current.base, apiKey: current.key, signal: controller.signal, out, provider });
        usage.rounds++;
        if (result.usage) {
          usage.prompt_tokens += result.usage.prompt_tokens ?? 0;
          usage.completion_tokens += result.usage.completion_tokens ?? 0;
          usage.total_tokens += result.usage.total_tokens ?? 0;
          usage.cached_tokens += result.usage.prompt_tokens_details?.cached_tokens ?? 0;
          usage.reasoning_tokens += result.usage.completion_tokens_details?.reasoning_tokens ?? 0;
        }
        if (result.toolCalls.length && round < MAX_TOOL_ROUNDS) {
          convo.push({ role: 'assistant', content: result.text || null, tool_calls: result.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.function.name, arguments: c.function.arguments } })) });
          for (const call of result.toolCalls) {
            let args = {};
            try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* reported by executor */ }
            const done = await executeTool(call.function.name, args, controller.signal);
            out({ type: 'tool', name: call.function.name, args, ok: done.ok, result: done.result.slice(0, 4000), ms: done.ms });
            convo.push({ role: 'tool', tool_call_id: call.id, content: done.result });
          }
          continue;
        }
        finish = result.finish ?? 'stop';
        if (result.toolCalls.length) finish = 'tool_limit';
        break;
      }

      if (usage.rounds > 1 || usage.total_tokens) out({ type: 'usage', usage });
      out({ type: 'done', finish_reason: finish });
      res.end();
    } catch (e) {
      if (res.destroyed) return;
      let friendly;
      if (e.upstream) friendly = e.message;
      else if (controller.signal.aborted) friendly = 'Request timed out. Try again or use a smaller output limit.';
      else if (HINTS[e.status]) friendly = HINTS[e.status];
      else if (e.status) friendly = `The provider returned HTTP ${e.status}. Check your account and try again.`;
      else friendly = 'Could not reach the API provider. Check your internet connection.';
      if (!res.headersSent) json(res, HINTS[e.status] ? e.status : 502, { error: friendly });
      else { res.write(`data: ${JSON.stringify({ type: 'error', message: friendly })}\n\n`); res.end(); }
    } finally { clearTimeout(timer); }
  });
}

async function streamCompletion({ model, maxTokens, messages, tools, extras, base, apiKey, signal, out, provider }) {
  const buildBody = includeUsage => {
    const body = { model, messages, max_tokens: maxTokens, stream: true, ...extras };
    if (includeUsage) body.stream_options = { include_usage: true };
    if (tools) { body.tools = BUILTIN_TOOLS; body.tool_choice = 'auto'; }
    return body;
  };
  const send = includeUsage => fetch(base + '/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(buildBody(includeUsage)), signal });
  let response = await send(provider.streamUsage);
  if (response.status === 400 && provider.streamUsage) { provider.streamUsage = false; response = await send(false); }
  if (!response.ok) { const error = new Error('Upstream rejected the request.'); error.status = response.status; throw error; }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) { const error = new Error('Unexpected stream format.'); error.status = 502; throw error; }

  const state = { text: '', reasoning: '', toolCalls: [], finish: null, usage: null };
  const decoder = new TextDecoder();
  let buffer = '';
  const handleBlock = block => {
    const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n').trim();
    if (!data || data === '[DONE]') return;
    let item;
    try { item = JSON.parse(data); } catch { return; }
    if (item.error) { const error = new Error(item.error.message || 'The stream failed.'); error.upstream = true; throw error; }
    const choice = item.choices?.[0];
    if (choice?.finish_reason) state.finish = choice.finish_reason;
    const delta = choice?.delta;
    if (delta) {
      if (typeof delta.content === 'string' && delta.content) { state.text += delta.content; out({ type: 'content', text: delta.content }); }
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) { state.reasoning += delta.reasoning_content; out({ type: 'reasoning', text: delta.reasoning_content }); }
      for (const call of delta.tool_calls ?? []) {
        const slot = state.toolCalls[call.index] ??= { id: null, type: 'function', function: { name: '', arguments: '' } };
        if (call.id) slot.id = call.id;
        if (call.function?.name) slot.function.name = call.function.name;
        if (call.function?.arguments) slot.function.arguments += call.function.arguments;
      }
    }
    if (item.usage) state.usage = item.usage;
  };
  for await (const chunk of response.body) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) { handleBlock(buffer.slice(0, cut)); buffer = buffer.slice(cut + 2); }
  }
  if (buffer.trim()) handleBlock(buffer);
  return state;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const server = createApp();
  server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `Port ${port} is busy. Change PORT in .env.` : e.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`River Chat: http://127.0.0.1:${port}\nPress Ctrl+C to stop.`));
}
