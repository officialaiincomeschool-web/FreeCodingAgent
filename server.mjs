import http from 'node:http';
import { readFile, readdir, stat, realpath, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
const MAX_TOOL_ROUNDS = 8;
const REQUEST_TIMEOUT_MS = 300000;
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;   // how long a proposed file change waits for the user
const READ_MAX_BYTES = 2 * 1024 * 1024;       // read_file refuses anything larger
const WRITE_MAX_CHARS = 300000;               // write_file / edit_file content cap
const TOOL_OUTPUT_MAX = 60000;                // characters returned to the model per tool
export { MAX_TOOL_ROUNDS };

export const BUILTIN_TOOLS = [
  { type: 'function', function: { name: 'calculator', description: 'Evaluate one arithmetic expression. Use this for any math. Supports + - * / % ^ ( ) and decimals.', parameters: { type: 'object', properties: { expression: { type: 'string', description: 'The expression, e.g. (12+8)*3^2' } }, required: ['expression'] } } },
  { type: 'function', function: { name: 'current_time', description: 'Get the current date and time. Optionally for a specific timezone.', parameters: { type: 'object', properties: { timezone: { type: 'string', description: 'IANA timezone name such as Asia/Kolkata. Omit to use the server timezone.' } } } } },
  { type: 'function', function: { name: 'wikipedia_lookup', description: 'Look up a topic on Wikipedia and return a short factual summary with a source URL.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'The topic to look up.' }, language: { type: 'string', description: "Wikipedia language code. Default 'en'." } }, required: ['query'] } } }
];

export const FILE_TOOLS = [
  { type: 'function', function: { name: 'list_files', description: "List files and folders in the user's project folder. Call without arguments for the project root.", parameters: { type: 'object', properties: { path: { type: 'string', description: 'Folder path relative to the project root. Omit for the root.' } } } } },
  { type: 'function', function: { name: 'read_file', description: "Read a text file from the user's project folder. Use start_line/max_lines to page through large files.", parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path relative to the project root.' }, start_line: { type: 'integer', description: 'First line to return (1-based). Default 1.' }, max_lines: { type: 'integer', description: 'How many lines to return. Default 400, max 1200.' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'search_files', description: "Case-insensitive text search across the user's project folder. Returns matching file paths and line numbers. Skips .git and node_modules.", parameters: { type: 'object', properties: { query: { type: 'string', description: 'Text to find (at least 2 characters).' }, path: { type: 'string', description: 'Folder to search under, relative to the project root. Omit for the whole project.' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'write_file', description: "Create or fully overwrite a file in the user's project folder. The user sees a diff and must approve before anything is written. Prefer edit_file for small changes to existing files.", parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path relative to the project root.' }, content: { type: 'string', description: 'The complete new file content.' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'edit_file', description: "Replace an exact text fragment inside an existing file in the user's project folder. The user must approve before the change is written. Copy old_string exactly from the file and include enough context to make it unique.", parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path relative to the project root.' }, old_string: { type: 'string', description: 'Exact existing text to replace.' }, new_string: { type: 'string', description: 'Replacement text. Use an empty string to delete.' }, replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' } }, required: ['path', 'old_string', 'new_string'] } } }
];

const AGENT_SYSTEM_PROMPT = "You can work inside the user's project folder with file tools. Investigate with list_files, read_file and search_files before answering or editing. Prefer edit_file for targeted changes; use write_file for new files or full rewrites. Every write is shown to the user as a diff and only happens after they approve — after calling a write tool, wait for the tool result and never claim a file was changed unless the result confirms it. Always use paths relative to the project root.";

// ---- project workspace (coding agent) ----

const SKIP_DIRS = new Set(['node_modules', '.git']);
const BINARY_FILE = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|pdf|zip|gz|tgz|7z|rar|exe|dll|so|dylib|bin|dat|db|sqlite|woff2?|ttf|otf|eot|mp3|mp4|mov|avi|mkv|wav|ogg|class|jar|pyc|o|a|obj|lock)$/i;

const relDisplay = value => String(value || '').split(path.sep).join('/') || '.';
const clampInt = (value, min, max, fallback) => { const n = Number(value); return Number.isInteger(n) ? Math.min(Math.max(n, min), max) : fallback; };

function resolveInRoot(root, rel, label = 'path') {
  if (typeof rel !== 'string' || !rel.trim() || rel.length > 400 || rel.includes('\0')) throw new Error(`A valid relative ${label} is required.`);
  const abs = path.resolve(root, rel.trim().replace(/\\/g, '/'));
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('That path is outside the project folder. Use paths relative to the project root.');
  return abs;
}

async function assertReallyInside(root, abs) {
  let probe = abs;
  for (;;) {
    let real;
    try { real = await realpath(probe); }
    catch {
      const parent = path.dirname(probe);
      if (parent === probe) throw new Error('Could not resolve that path.');
      probe = parent;
      continue;
    }
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error('That path is outside the project folder. Use paths relative to the project root.');
    return;
  }
}

async function readProjectText(root, abs, { required = true } = {}) {
  const shown = relDisplay(path.relative(root, abs));
  let info = null;
  try { info = await stat(abs); } catch { if (required) throw new Error('File not found: ' + shown); return null; }
  if (!info.isFile()) throw new Error('Not a file: ' + shown);
  if (info.size > READ_MAX_BYTES) throw new Error(`File is too large to read (${Math.ceil(info.size / 1024)} KB). Read a specific part or use search_files.`);
  const buffer = await readFile(abs);
  if (buffer.includes(0)) throw new Error(`"${shown}" looks like a binary file.`);
  return buffer.toString('utf8');
}

async function readJsonBody(req, limit) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) { const error = new Error('Request is too large.'); error.tooLarge = true; throw error; }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { const error = new Error('Invalid JSON.'); error.badJson = true; throw error; }
}

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
  let workspace = null; // { root, label } — project folder for the coding agent, set via POST /api/workspace
  const pendingApprovals = new Map(); // id -> { signal, resolve } for proposed file changes
  const active = () => uiProvider ?? { base, key: apiKey };

  function waitForApproval(id, signal) {
    return new Promise(resolve => {
      const timer = setTimeout(() => { pendingApprovals.delete(id); resolve('expired'); }, APPROVAL_TIMEOUT_MS);
      pendingApprovals.set(id, { signal, resolve: value => { clearTimeout(timer); resolve(value); } });
    });
  }

  async function proposeChange(tool, abs, before, after, signal, out) {
    const id = randomUUID();
    out({ type: 'proposal', id, tool, path: relDisplay(path.relative(workspace.root, abs)), before, after });
    const decision = await waitForApproval(id, signal);
    if (decision === 'reject') return 'The user rejected this change. Do not retry it unless they ask.';
    if (decision !== 'approve') return 'This change was not applied (the request stopped or timed out before the user decided).';
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, after, 'utf8');
    return `Applied: "${relDisplay(path.relative(workspace.root, abs))}" now has ${after.length} characters, approved by the user.`;
  }

  async function executeProjectTool(name, a, signal, out) {
    if (!workspace) throw new Error('No project folder is set up yet. Ask the user to set one under "Project folder".');
    if (name === 'list_files') {
      const abs = resolveInRoot(workspace.root, a.path || '.');
      await assertReallyInside(workspace.root, abs);
      let info;
      try { info = await stat(abs); } catch { throw new Error('Folder not found: ' + relDisplay(path.relative(workspace.root, abs))); }
      if (info.isFile()) return `File: ${relDisplay(path.relative(workspace.root, abs))} (${Math.max(1, Math.ceil(info.size / 1024))} KB)`;
      if (!info.isDirectory()) throw new Error('That is not a file or folder.');
      const entries = await readdir(abs, { withFileTypes: true });
      entries.sort((x, y) => (Number(y.isDirectory()) - Number(x.isDirectory())) || x.name.localeCompare(y.name));
      const lines = [];
      for (const entry of entries.slice(0, 400)) {
        if (entry.isDirectory()) lines.push(entry.name + '/');
        else if (entry.isFile()) { const size = (await stat(path.join(abs, entry.name)).catch(() => null))?.size ?? 0; lines.push(`${entry.name} (${size < 1024 ? size + ' B' : Math.ceil(size / 1024) + ' KB'})`); }
        else lines.push(entry.name + ' (special)');
      }
      if (entries.length > 400) lines.push(`… ${entries.length - 400} more entries not shown`);
      return `Directory "${relDisplay(path.relative(workspace.root, abs))}" — ${entries.length} entries:\n` + lines.join('\n');
    }
    if (name === 'read_file') {
      const abs = resolveInRoot(workspace.root, a.path);
      await assertReallyInside(workspace.root, abs);
      const content = await readProjectText(workspace.root, abs);
      const lines = content.split('\n');
      const start = clampInt(a.start_line, 1, Math.max(1, lines.length), 1);
      const count = clampInt(a.max_lines, 1, 1200, 400);
      const slice = lines.slice(start - 1, start - 1 + count);
      let result = `File: ${relDisplay(path.relative(workspace.root, abs))} — lines ${start}-${start + slice.length - 1} of ${lines.length}\n` + slice.join('\n');
      if (start - 1 + slice.length < lines.length) result += `\n… file continues to line ${lines.length}`;
      if (result.length > TOOL_OUTPUT_MAX) result = result.slice(0, TOOL_OUTPUT_MAX) + '\n… output truncated';
      return result;
    }
    if (name === 'search_files') {
      const query = typeof a.query === 'string' ? a.query.trim() : '';
      if (query.length < 2) throw new Error('query must be at least 2 characters.');
      if (query.length > 200) throw new Error('query is too long.');
      const baseAbs = resolveInRoot(workspace.root, a.path || '.');
      await assertReallyInside(workspace.root, baseAbs);
      const needle = query.toLowerCase();
      const matches = [];
      let scanned = 0, stopped = false;
      const walk = async dir => {
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (stopped) return;
          const child = path.join(dir, entry.name);
          if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) await walk(child); continue; }
          if (!entry.isFile() || BINARY_FILE.test(entry.name)) continue;
          if (++scanned > 1500) { stopped = true; return; }
          const info = await stat(child).catch(() => null);
          if (!info || info.size > 300 * 1024) continue;
          let text;
          try { text = await readFile(child, 'utf8'); } catch { continue; }
          if (text.includes('\0')) continue;
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(needle)) {
              matches.push(`${relDisplay(path.relative(workspace.root, child))}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
              if (matches.length >= 60) { stopped = true; return; }
            }
          }
        }
      };
      await walk(baseAbs);
      if (!matches.length) return `No matches for "${query}" (${scanned} files scanned).`;
      return matches.join('\n') + (stopped ? `\n… stopped early (${scanned} files scanned)` : `\n(${matches.length} matches in ${scanned} files scanned)`);
    }
    if (name === 'write_file') {
      if (typeof a.content !== 'string') throw new Error('content must be a string.');
      if (a.content.length > WRITE_MAX_CHARS) throw new Error('content is too large (max 300,000 characters).');
      const abs = resolveInRoot(workspace.root, a.path);
      await assertReallyInside(workspace.root, abs);
      let before = null;
      try { before = await readProjectText(workspace.root, abs, { required: false }); } catch { before = null; }
      if (before === a.content) return 'No change: the file already has exactly this content.';
      return proposeChange('write_file', abs, before, a.content, signal, out);
    }
    if (name === 'edit_file') {
      const abs = resolveInRoot(workspace.root, a.path);
      await assertReallyInside(workspace.root, abs);
      const before = await readProjectText(workspace.root, abs);
      if (typeof a.old_string !== 'string' || !a.old_string) throw new Error('old_string is required.');
      if (typeof a.new_string !== 'string') throw new Error('new_string must be a string (use "" to delete text).');
      const occurrences = before.split(a.old_string).length - 1;
      if (!occurrences) throw new Error('old_string was not found. Read the file and copy the exact text.');
      if (occurrences > 1 && a.replace_all !== true) throw new Error(`old_string appears ${occurrences} times. Add more surrounding context or set replace_all: true.`);
      const after = a.replace_all === true ? before.split(a.old_string).join(a.new_string) : before.replace(a.old_string, a.new_string);
      if (after === before) return 'No change: old_string and new_string are identical.';
      return proposeChange('edit_file', abs, before, after, signal, out);
    }
    throw new Error(`Unknown tool "${name}".`);
  }

  const FILE_TOOL_NAMES = new Set(FILE_TOOLS.map(t => t.function.name));
  async function runAnyTool(name, args, signal, out) {
    if (!FILE_TOOL_NAMES.has(name)) return executeTool(name, args, signal);
    const started = Date.now();
    try { return { ok: true, result: await executeProjectTool(name, args, signal, out), ms: Date.now() - started }; }
    catch (e) { return { ok: false, result: 'Error: ' + (e?.message || 'tool failed'), ms: Date.now() - started }; }
  }

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
      models: modelList, pricing: PRICING, tools: BUILTIN_TOOLS.map(t => t.function.name),
      workspace: workspace ? { ready: true, root: workspace.label } : { ready: false, root: null }
    });
    if (!['/api/chat', '/api/models', '/api/provider', '/api/workspace', '/api/workspace/approval'].includes(url.pathname)) return json(res, 404, { error: 'Not found' });
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

    if (url.pathname === '/api/workspace') {
      if (!req.headers['content-type']?.includes('application/json')) return json(res, 415, { error: 'Send JSON.' });
      let payload;
      try { payload = await readJsonBody(req, 65536); }
      catch (e) { return json(res, e.tooLarge ? 413 : 400, { error: e.message }); }
      const folder = typeof payload.path === 'string' ? payload.path.trim() : '';
      if (!folder) { workspace = null; return json(res, 200, { ready: false, root: null }); }
      if (folder.length > 1000 || folder.includes('\0')) return json(res, 400, { error: 'That folder path is not valid.' });
      let info;
      try { info = await stat(folder); } catch { return json(res, 400, { error: 'That folder does not exist. Copy the full path from your file explorer.' }); }
      if (!info.isDirectory()) return json(res, 400, { error: 'That path is a file, not a folder. Point to the folder that holds your project.' });
      let real;
      try { real = await realpath(folder); } catch { return json(res, 400, { error: 'Could not open that folder.' }); }
      workspace = { root: real, label: folder };
      return json(res, 200, { ready: true, root: folder });
    }

    if (url.pathname === '/api/workspace/approval') {
      if (!req.headers['content-type']?.includes('application/json')) return json(res, 415, { error: 'Send JSON.' });
      let payload;
      try { payload = await readJsonBody(req, 65536); }
      catch (e) { return json(res, e.tooLarge ? 413 : 400, { error: e.message }); }
      const entry = pendingApprovals.get(payload.id);
      if (!entry) return json(res, 404, { error: 'This change is no longer waiting for approval.' });
      pendingApprovals.delete(payload.id);
      entry.resolve(payload.approve ? 'approve' : 'reject');
      return json(res, 200, { ok: true });
    }

    if (!uiProvider && !envReady) return json(res, 503, { error: 'No API key yet. Open Model & settings in the page and connect your provider, or set API_KEY in .env.' });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    res.on('close', () => controller.abort());
    controller.signal.addEventListener('abort', () => {
      for (const [id, entry] of pendingApprovals) if (entry.signal === controller.signal) { pendingApprovals.delete(id); entry.resolve('canceled'); }
    });

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

      const agentMode = Boolean(tools) && Boolean(workspace);
      const toolList = agentMode ? [...BUILTIN_TOOLS, ...FILE_TOOLS] : BUILTIN_TOOLS;
      const systemParts = [];
      if (systemPrompt?.trim()) systemParts.push(systemPrompt.trim());
      if (agentMode) systemParts.push(AGENT_SYSTEM_PROMPT);
      const convo = [];
      if (systemParts.length) convo.push({ role: 'system', content: systemParts.join('\n\n') });
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
        const result = await streamCompletion({ model, maxTokens: max_tokens, messages: convo, tools: Boolean(tools), toolList, extras, base: current.base, apiKey: current.key, signal: controller.signal, out, provider });
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
            const done = await runAnyTool(call.function.name, args, controller.signal, out);
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

async function streamCompletion({ model, maxTokens, messages, tools, toolList, extras, base, apiKey, signal, out, provider }) {
  const buildBody = includeUsage => {
    const body = { model, messages, max_tokens: maxTokens, stream: true, ...extras };
    if (includeUsage) body.stream_options = { include_usage: true };
    if (tools) { body.tools = toolList ?? BUILTIN_TOOLS; body.tool_choice = 'auto'; }
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
