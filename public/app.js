const $ = id => document.getElementById(id);
const LS_CHATS = 'riverchat.chats.v2';
const LS_SETTINGS = 'riverchat.settings.v2';
const LS_PROVIDER = 'riverchat.provider.v1';
const LS_WORKSPACE = 'riverchat.workspace.v1';

let pricing = {};
let state = { chats: [], activeId: null };
let settings = { temperature: '', top_p: '', stop: '', tools: true, effort: '', systemPrompt: '' };
let attachments = [];
let active = null;
let busy = false;
let providerConfig = { baseUrl: '', apiKey: '' };
let connection = { ready: false, source: null, baseUrl: null };
let workspace = { ready: false, root: null };
let models = [];
let currentModel = '';

const shortName = id => String(id || '').split('/').pop();
const activeChat = () => state.chats.find(c => c.id === state.activeId) ?? state.chats[0];
function notice(text) { $('notice').textContent = text; }
function scroll(force) {
  const conversation = $('conversation');
  if (force || conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 260) conversation.scrollTop = conversation.scrollHeight;
}
function setBusy(b) { busy = b; for (const id of ['send', 'newChat', 'modelButton', 'tokens', 'refresh', 'effort', 'attach']) $(id).disabled = b; $('stop').hidden = !b; }
function readJSON(response) { return response.json().then(data => { if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); return data; }); }
const safeHost = url => { try { return new URL(url).host; } catch { return String(url || ''); } };
function updateProviderUI() {
  if (connection.source === 'ui') $('providerHint').textContent = 'Connected to ' + safeHost(connection.baseUrl) + '. Saved in this browser only.';
  else if (connection.source === 'env') $('providerHint').textContent = 'Using the values from .env. Fill both fields above to use a different provider.';
  else $('providerHint').textContent = 'Enter your provider’s base URL and API key. Saved in this browser only.';
}
function updateConnectionUI() {
  $('connection').textContent = !connection.ready ? 'Setup needed' : (connection.source === 'ui' ? 'Connected · ' + safeHost(connection.baseUrl) : 'Connected · .env');
  $('connection').classList.toggle('warn', !connection.ready);
}
function updateModelLine() {
  const bits = [];
  const model = currentModel || activeChat()?.model;
  if (model) bits.push(model);
  if ($('tokens').value) bits.push($('tokens').value + ' max tokens');
  if ($('tools').checked) bits.push('tools on');
  if (workspace.ready) bits.push('agent folder on');
  if ($('effort').value) bits.push('reasoning: ' + $('effort').value);
  $('modelLine').textContent = bits.join(' · ');
  $('modelLine').hidden = bits.length === 0;
}

// ---- persistence ----

function newChatRecord() {
  return { id: crypto.randomUUID(), title: 'New conversation', model: currentModel || '', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
}
function loadAll() {
  try {
    const data = JSON.parse(localStorage.getItem(LS_CHATS) || 'null');
    if (data && Array.isArray(data.chats)) { state.chats = data.chats; state.activeId = data.activeId ?? null; }
  } catch { /* start fresh */ }
  try { Object.assign(settings, JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}')); } catch { /* defaults */ }
  if (!state.chats.length) state.chats.push(newChatRecord());
  if (!state.chats.some(c => c.id === state.activeId)) state.activeId = state.chats[0].id;
}
function trySave() {
  try { localStorage.setItem(LS_CHATS, JSON.stringify({ chats: state.chats, activeId: state.activeId })); return true; }
  catch { return false; }
}
function loadProvider() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_PROVIDER) || 'null');
    if (saved && typeof saved === 'object') providerConfig = { baseUrl: String(saved.baseUrl || ''), apiKey: String(saved.apiKey || '') };
  } catch { /* nothing saved */ }
}
function saveProvider() {
  try {
    if (providerConfig.baseUrl || providerConfig.apiKey) localStorage.setItem(LS_PROVIDER, JSON.stringify(providerConfig));
    else localStorage.removeItem(LS_PROVIDER);
  } catch { /* ignore */ }
}
function stripOldestImage() {
  for (const chat of state.chats) for (const message of chat.messages) {
    if (!Array.isArray(message.parts)) continue;
    const index = message.parts.findIndex(part => part.type === 'image_url');
    if (index >= 0) {
      message.parts.splice(index, 1);
      if (!message.parts.length) message.parts.push({ type: 'text', text: '[image removed to free space]' });
      return true;
    }
  }
  return false;
}
function persist() {
  try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch { /* ignore */ }
  if (trySave()) return;
  let freed = false;
  while (stripOldestImage()) {
    freed = true;
    if (trySave()) { if (freed) { notice('Browser storage was full, so older images were removed from saved history.'); renderMessages(); } return; }
  }
  if (freed) notice('Browser storage is full. Recent changes may not be saved.');
}

// ---- rendering ----

function ensureThinking(refs, open = false) {
  if (!refs.thinkingBox) {
    const box = document.createElement('details'); box.className = 'thinking';
    const summary = document.createElement('summary'); summary.textContent = 'Thinking';
    const reasoning = document.createElement('div'); reasoning.className = 'reasoning';
    box.append(summary, reasoning);
    refs.card.insertBefore(box, refs.body);
    Object.assign(refs, { thinkingBox: box, reasoningEl: reasoning });
  }
  refs.thinkingBox.open = open;
  return refs.reasoningEl;
}
function ensureTools(refs, open = false) {
  if (!refs.toolsBox) {
    const box = document.createElement('details'); box.className = 'tools';
    const summary = document.createElement('summary'); summary.textContent = 'Using tools…';
    const rows = document.createElement('div');
    box.append(summary, rows);
    refs.card.insertBefore(box, refs.body);
    Object.assign(refs, { toolsBox: box, toolsSummary: summary, toolRows: rows });
  }
  if (open) refs.toolsBox.open = true;
  return refs.toolRows;
}
const truncate = (text, max) => text.length > max ? text.slice(0, max - 1) + '…' : text;
const LANG_EXT = { js: 'js', javascript: 'js', mjs: 'mjs', cjs: 'cjs', jsx: 'jsx', ts: 'ts', typescript: 'ts', tsx: 'tsx', python: 'py', py: 'py', html: 'html', htm: 'html', css: 'css', scss: 'scss', sass: 'sass', less: 'less', json: 'json', jsonc: 'json', md: 'md', markdown: 'md', bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh', powershell: 'ps1', ps1: 'ps1', pwsh: 'ps1', batch: 'bat', bat: 'bat', cmd: 'bat', java: 'java', c: 'c', h: 'h', cpp: 'cpp', 'c++': 'cpp', hpp: 'hpp', cs: 'cs', csharp: 'cs', go: 'go', golang: 'go', rs: 'rs', rust: 'rs', sql: 'sql', yml: 'yml', yaml: 'yml', toml: 'toml', ini: 'ini', xml: 'xml', svg: 'svg', php: 'php', ruby: 'rb', rb: 'rb', kotlin: 'kt', kt: 'kt', swift: 'swift', dart: 'dart', lua: 'lua', r: 'r', txt: 'txt', text: 'txt', diff: 'diff', patch: 'patch', graphql: 'graphql', proto: 'proto' };
function languageExt(lang) { return LANG_EXT[String(lang || '').toLowerCase()] ?? 'txt'; }
function fenceTarget(info) {
  const text = String(info || '').trim();
  if (!text) return null;
  const titled = text.match(/title\s*=\s*["']?([^"'\s]+)["']?/i);
  if (titled) return titled[1];
  const tokens = text.split(/\s+/).filter(Boolean);
  const candidate = tokens.length >= 2 ? tokens.slice(1).join('') : tokens[0];
  return candidate && /[./]/.test(candidate) ? candidate : null;
}
function sanitizeRelPath(name) {
  const value = String(name || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!value || value.length > 180 || /^([a-zA-Z]:|\/)/.test(value)) return null;
  const segments = value.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[<>:"|?*\x00-\x1f]/.test(segment))) return null;
  return segments.join('/');
}
function toolRow(trace) {
  const row = document.createElement('div'); row.className = 'tool-row' + (trace.ok === false ? ' bad' : '');
  const name = document.createElement('b'); name.textContent = trace.name;
  const args = document.createElement('code'); args.textContent = truncate(JSON.stringify(trace.args ?? {}), 140);
  const result = document.createElement('code'); result.textContent = truncate(String(trace.result ?? ''), 220);
  const status = document.createElement('span'); status.className = 'tool-status'; status.textContent = trace.ok === false ? 'failed · ' + (trace.ms ?? 0) + ' ms' : (trace.ms ?? 0) + ' ms';
  row.append(name, document.createTextNode('('), args, document.createTextNode(') → '), result, status);
  return row;
}
function ensureProposals(refs) {
  if (!refs.proposalList) {
    const box = document.createElement('div'); box.className = 'proposals';
    refs.card.insertBefore(box, refs.body);
    refs.proposalList = box;
  }
  return refs.proposalList;
}
function diffRows(before, after) {
  const a = typeof before === 'string' ? before.split('\n') : [];
  const b = String(after ?? '').split('\n');
  let rows;
  if (a.length * b.length > 1000000) {
    rows = [...a.map(l => ({ t: 'del', l })), ...b.map(l => ({ t: 'add', l }))];
  } else {
    const width = b.length + 1;
    const dp = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i * width + j] = a[i] === b[j] ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    rows = []; let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { rows.push({ t: 'ctx', l: a[i] }); i++; j++; }
      else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) { rows.push({ t: 'del', l: a[i] }); i++; }
      else { rows.push({ t: 'add', l: b[j] }); j++; }
    }
    while (i < a.length) rows.push({ t: 'del', l: a[i++] });
    while (j < b.length) rows.push({ t: 'add', l: b[j++] });
  }
  const out = []; let run = [];
  const flush = () => { if (run.length <= 6) out.push(...run); else out.push(...run.slice(0, 3), { t: 'gap', n: run.length - 6 }, ...run.slice(-3)); run = []; };
  for (const row of rows) { if (row.t === 'ctx') run.push(row); else { flush(); out.push(row); } }
  flush();
  return out;
}
function proposalCard(item) {
  const card = document.createElement('div'); card.className = 'proposal';
  const head = document.createElement('div'); head.className = 'proposal-head';
  const title = document.createElement('b');
  title.textContent = item.tool === 'edit_file' ? '✎ Edit request' : (item.before === null ? '📄 New file request' : '✎ Rewrite request');
  const file = document.createElement('code'); file.textContent = item.path;
  const rows = diffRows(item.before ?? null, item.after ?? '');
  const added = rows.filter(r => r.t === 'add').length;
  const removed = rows.filter(r => r.t === 'del').length;
  const counts = document.createElement('span'); counts.className = 'proposal-counts';
  counts.textContent = `+${added} −${removed}${item.clipped ? ' · preview trimmed for storage' : ''}`;
  const state = document.createElement('span'); state.className = 'proposal-state';
  head.append(title, file, counts, state);
  const diff = document.createElement('div'); diff.className = 'proposal-diff';
  let shown = 0;
  for (const row of rows) {
    if (shown >= 500) { const more = document.createElement('div'); more.className = 'dl gap'; more.textContent = `… ${rows.length - shown} more lines — open the file to see the rest`; diff.append(more); break; }
    const line = document.createElement('div');
    line.className = 'dl ' + (row.t === 'add' ? 'add' : row.t === 'del' ? 'del' : row.t === 'gap' ? 'gap' : 'ctx');
    line.textContent = row.t === 'add' ? '+ ' + row.l : row.t === 'del' ? '- ' + row.l : row.t === 'gap' ? `… ${row.n} unchanged lines` : '  ' + row.l;
    diff.append(line); shown++;
  }
  const actions = document.createElement('div'); actions.className = 'proposal-actions';
  const apply = document.createElement('button'); apply.type = 'button'; apply.className = 'apply'; apply.textContent = '✓ Apply';
  const reject = document.createElement('button'); reject.type = 'button'; reject.className = 'reject'; reject.textContent = '✗ Reject';
  const setState = (text, cls) => { state.textContent = text; state.className = 'proposal-state' + (cls ? ' ' + cls : ''); };
  const decide = async approve => {
    apply.disabled = reject.disabled = true;
    setState(approve ? 'applying…' : 'rejecting…', '');
    try {
      await readJSON(await fetch('/api/workspace/approval', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id, approve }) }));
      item.decision = approve ? 'applied' : 'rejected';
      setState(approve ? '✓ applied' : '✗ rejected', approve ? 'ok' : 'no');
      actions.remove();
      notice('');
    } catch (e) {
      setState('failed — you can try again', 'no');
      apply.disabled = reject.disabled = false;
      notice(e.message);
    }
  };
  apply.onclick = () => decide(true);
  reject.onclick = () => decide(false);
  actions.append(apply, reject);
  card.append(head, diff, actions);
  if (item.decision) {
    setState(item.decision === 'applied' ? '✓ applied' : '✗ rejected', item.decision === 'applied' ? 'ok' : 'no');
    actions.remove();
  }
  return card;
}
function renderText(target, text) {
  target.replaceChildren();
  const parts = text.split('```');
  parts.forEach((part, i) => {
    if (i % 2) {
      const cut = part.indexOf('\n');
      const info = (cut === -1 ? part : part.slice(0, cut)).trim();
      const codeText = cut === -1 ? '' : part.slice(cut + 1);
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = codeText;
      pre.append(code);
      const block = document.createElement('div'); block.className = 'code-block';
      const bar = document.createElement('div'); bar.className = 'code-bar';
      const tokens = info.split(/\s+/).filter(Boolean);
      const language = tokens.length && !/^(title|file|filename)=/i.test(tokens[0]) ? tokens[0] : '';
      const name = fenceTarget(info);
      const lang = document.createElement('span'); lang.className = 'code-lang';
      lang.textContent = language && language !== name ? language : 'code';
      const copy = document.createElement('button');
      copy.type = 'button'; copy.className = 'code-tool'; copy.textContent = 'Copy';
      copy.title = 'Copy this code block';
      copy.onclick = async () => { try { await navigator.clipboard.writeText(codeText); copy.textContent = 'Copied'; setTimeout(() => copy.textContent = 'Copy', 1200); } catch { notice('Select the code and copy it manually.'); } };
      bar.append(lang, copy);
      const save = document.createElement('button');
      save.type = 'button'; save.className = 'code-tool code-save';
      save.textContent = name ? `💾 Save as ${name}` : '💾 Save';
      save.title = 'Save this code into your project folder';
      save.onclick = () => saveCodeBlock(codeText, info);
      bar.append(save);
      block.append(bar, pre);
      target.append(block);
    } else target.append(document.createTextNode(part));
  });
}
function addCopy(card, text) { if (!text) return; const b = document.createElement('button'); b.className = 'copy'; b.textContent = 'Copy message'; b.onclick = async () => { try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; setTimeout(() => b.textContent = 'Copy message', 1500); } catch { notice('Select the message text and copy it manually.'); } }; card.append(b); }
const userText = record => (record.parts ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n\n');

function renderMessage(record) {
  $('welcome').hidden = true;
  const card = document.createElement('article'); card.className = `message ${record.role}`;
  const label = document.createElement('div'); label.className = 'label'; label.textContent = record.role === 'user' ? 'YOU' : 'AI';
  const body = document.createElement('div'); body.className = 'body';
  const meta = document.createElement('div'); meta.className = 'meta';
  card.append(label);
  const refs = { card, body, meta };
  if (record.role === 'user') {
    const images = (record.parts ?? []).filter(p => p.type === 'image_url');
    if (images.length) {
      const box = document.createElement('div'); box.className = 'msg-images';
      for (const image of images) { const el = document.createElement('img'); el.src = image.image_url.url; el.alt = 'Attached image'; el.loading = 'lazy'; box.append(el); }
      card.append(box);
    }
    body.textContent = userText(record);
    card.append(body);
  } else {
    if (record.reasoning) ensureThinking(refs).textContent = record.reasoning;
    if (record.tools?.length) {
      const rows = ensureTools(refs);
      for (const trace of record.tools) rows.append(toolRow(trace));
      const names = [...new Set(record.tools.map(t => t.name))].join(', ');
      refs.toolsSummary.textContent = `Tools used: ${names} · ${record.tools.length} call${record.tools.length > 1 ? 's' : ''}`;
      refs.toolsBox.open = false;
    }
    if (record.proposals?.length) { const list = ensureProposals(refs); for (const item of record.proposals) list.append(proposalCard(item)); }
    renderText(body, record.text);
    meta.textContent = usageLine(record.model ?? activeChat()?.model, record.usage, record.finish);
    card.append(body);
  }
  card.append(meta);
  $('messages').append(card); scroll();
  return refs;
}
function usageLine(model, usage, finish) {
  const bits = [];
  if (usage) {
    bits.push(`↑ ${usage.prompt_tokens.toLocaleString()} in (${usage.cached_tokens.toLocaleString()} cached) · ↓ ${usage.completion_tokens.toLocaleString()} out (${usage.reasoning_tokens.toLocaleString()} reasoning)`);
    const price = pricing[model];
    if (price) {
      const cost = ((usage.prompt_tokens - usage.cached_tokens) / 1e6) * price.input + (usage.cached_tokens / 1e6) * price.cached + (usage.completion_tokens / 1e6) * price.output;
      bits.push('≈$' + (cost < 0.01 ? cost.toFixed(6) : cost.toFixed(4)));
    }
  }
  if (finish === 'length') bits.push('Output limit reached. Ask “continue” or increase Max output tokens.');
  if (finish === 'tool_limit') bits.push('Tool limit reached. Ask “continue” so the agent can keep working.');
  return bits.join(' · ');
}
function renderMessages() {
  $('messages').replaceChildren();
  const chat = activeChat();
  $('welcome').hidden = chat.messages.length > 0;
  for (const record of chat.messages) {
    const refs = renderMessage(record);
    if (record.role === 'user') addCopy(refs.card, userText(record));
  }
  scroll(true);
}
function renderChatList() {
  const list = $('chats');
  list.replaceChildren();
  for (const chat of state.chats) {
    const item = document.createElement('li');
    item.className = chat.id === state.activeId ? 'active' : '';
    item.title = chat.title;
    const title = document.createElement('span'); title.className = 'chat-title'; title.textContent = chat.title;
    const model = document.createElement('span'); model.className = 'chat-model'; model.textContent = chat.model ? shortName(chat.model) : '';
    const del = document.createElement('button'); del.className = 'del'; del.textContent = '✕'; del.title = 'Delete conversation'; del.setAttribute('aria-label', `Delete ${chat.title}`);
    del.onclick = event => {
      event.stopPropagation();
      if (busy || !confirm(`Delete "${chat.title}"?`)) return;
      state.chats = state.chats.filter(c => c.id !== chat.id);
      if (state.activeId === chat.id) { if (!state.chats.length) state.chats.push(newChatRecord()); state.activeId = state.chats[0].id; }
      persist(); renderAll();
    };
    item.onclick = () => openChat(chat.id);
    item.ondblclick = event => {
      event.preventDefault();
      const name = prompt('Rename conversation', chat.title);
      if (name?.trim()) { chat.title = name.trim(); persist(); renderChatList(); }
    };
    item.append(title, model, del);
    list.append(item);
  }
}
function openChat(id) {
  if (busy) return;
  setMenu(false);
  state.activeId = id;
  const chat = activeChat();
  if (chat.model && models.includes(chat.model)) { currentModel = chat.model; updateModelButton(); }
  else if (!chat.model) chat.model = currentModel;
  updateEffort(); persist(); renderMessages(); renderChatList();
  $('prompt').focus();
}
function renderAll() { renderChatList(); renderMessages(); updateEffort(); }

// ---- attachments ----

async function fileToDataURL(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.9);
}
async function addFiles(files) {
  for (const file of files) {
    if (attachments.length >= 4) { notice('Up to 4 images per message.'); break; }
    if (!/^image\/(png|jpeg)$/.test(file.type)) { notice('Only PNG and JPEG images are supported.'); continue; }
    if (file.size > 15 * 1024 * 1024) { notice('Image too large (max 15 MB).'); continue; }
    try { attachments.push({ url: await fileToDataURL(file), name: file.name || 'image' }); }
    catch { notice('Could not read that image.'); }
  }
  renderAttachments();
}
function renderAttachments() {
  const box = $('attachments');
  box.replaceChildren();
  attachments.forEach((attachment, index) => {
    const wrap = document.createElement('div'); wrap.className = 'thumb';
    const img = document.createElement('img'); img.src = attachment.url; img.alt = attachment.name; img.title = attachment.name;
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '✕'; remove.setAttribute('aria-label', `Remove ${attachment.name}`);
    remove.onclick = () => { attachments.splice(index, 1); renderAttachments(); };
    wrap.append(img, remove);
    box.append(wrap);
  });
}

// ---- saving code into the project folder ----

async function saveCodeBlock(codeText, info) {
  if (!workspace.ready) {
    notice('Set your project folder first: sidebar → 📁 Project folder, paste the path, then Save writes files there.');
    $('projectBox').open = true;
    $('projectPath').focus();
    return;
  }
  let relPath = sanitizeRelPath(fenceTarget(info));
  if (!relPath) {
    const language = String(info || '').trim().split(/\s+/)[0] || '';
    const entered = prompt('File name for this code (subfolders like src/app.js are allowed):', 'snippet.' + languageExt(language));
    relPath = entered ? sanitizeRelPath(entered) : null;
    if (entered && !relPath) { notice('That file name is not valid. Use letters, numbers, dots, dashes and / for subfolders.'); return; }
    if (!relPath) return;
  }
  try {
    const send = overwrite => fetch('/api/workspace/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: relPath, content: codeText, overwrite }) });
    let response = await send(false);
    let data = await response.json().catch(() => ({}));
    if (response.status === 409 && data.exists) {
      if (!confirm('"' + relPath + '" already exists in your project folder. Overwrite it?')) return;
      response = await send(true);
      data = await response.json().catch(() => ({}));
    }
    if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status);
    notice('Saved "' + data.saved + '" into your project folder.');
  } catch (e) { notice(e?.message || 'Could not save the file.'); }
}

// ---- model + settings wiring ----

function effortChoices(model) {
  const name = String(model).toLowerCase();
  if (name.includes('deepseek')) return [['', 'Model default'], ['none', 'None — fastest'], ['high', 'High'], ['max', 'Max']];
  if (name.includes('glm')) return [['', 'Model default'], ['low', 'Low'], ['high', 'High'], ['max', 'Max']];
  return [];
}
function updateEffort() {
  const choices = effortChoices(currentModel);
  $('effortBox').hidden = choices.length === 0;
  const previous = $('effort').value;
  $('effort').replaceChildren(...choices.map(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; return option; }));
  const wanted = [previous, settings.effort].find(value => choices.some(([v]) => v === value));
  $('effort').value = wanted ?? '';
  updateModelLine();
}
function fillModels(list) {
  const keep = currentModel || activeChat()?.model || '';
  models = [...new Set([...list, ...(keep ? [keep] : [])])];
  currentModel = models.includes(keep) ? keep : (models[0] ?? '');
  updateModelButton();
  if (!$('modelMenu').hidden) renderModelMenu($('modelSearch').value);
  updateEffort();
}
function hydrateSettings() {
  $('temperature').value = settings.temperature ?? '';
  $('top_p').value = settings.top_p ?? '';
  $('stop').value = settings.stop ?? '';
  $('tools').checked = settings.tools !== false;
  $('systemPrompt').value = settings.systemPrompt ?? '';
}

function commitModel(id) {
  const chat = activeChat();
  chat.model = id;
  chat.updatedAt = Date.now();
  updateEffort(); persist(); renderChatList();
}

// ---- searchable model picker ----

function updateModelButton() {
  $('modelLabel').textContent = currentModel ? shortName(currentModel) : (models.length ? 'Select a model' : 'No models — connect a provider');
  $('modelButton').title = currentModel || '';
}
function renderModelMenu(filter) {
  const list = $('modelList');
  const query = String(filter || '').trim().toLowerCase();
  const visible = models.filter(id => !query || id.toLowerCase().includes(query));
  list.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement('div'); empty.className = 'picker-empty';
    empty.textContent = models.length ? 'No model matches that search.' : 'No models loaded — click ↻ Refresh available models.';
    list.append(empty);
    return;
  }
  for (const id of visible) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'picker-item' + (id === currentModel ? ' active' : '');
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', id === currentModel ? 'true' : 'false');
    item.dataset.id = id;
    const name = document.createElement('span'); name.textContent = shortName(id);
    item.append(name);
    if (shortName(id) !== id) { const sub = document.createElement('small'); sub.textContent = id; item.append(sub); }
    item.onclick = () => chooseModel(id);
    list.append(item);
  }
}
function positionModelMenu() {
  const rect = $('modelButton').getBoundingClientRect();
  const menu = $('modelMenu');
  const width = Math.max(rect.width, 230);
  menu.style.width = width + 'px';
  const height = menu.offsetHeight || 320;
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - 6 - height);
  menu.style.top = top + 'px';
  menu.style.left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8)) + 'px';
}
function openModelMenu() {
  $('modelMenu').hidden = false;
  renderModelMenu('');
  $('modelSearch').value = '';
  positionModelMenu();
  $('modelButton').setAttribute('aria-expanded', 'true');
  $('modelSearch').focus();
}
function closeModelMenu() {
  if ($('modelMenu').hidden) return;
  $('modelMenu').hidden = true;
  $('modelButton').setAttribute('aria-expanded', 'false');
}
function chooseModel(id) {
  closeModelMenu();
  $('modelButton').focus();
  if (!id || id === currentModel) return;
  currentModel = id;
  updateModelButton();
  commitModel(id);
}
$('modelButton').onclick = () => ($('modelMenu').hidden ? openModelMenu() : closeModelMenu());
$('modelSearch').addEventListener('input', () => renderModelMenu($('modelSearch').value));
$('modelSearch').addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    const first = $('modelList').querySelector('.picker-item');
    if (first) chooseModel(first.dataset.id);
  } else if (event.key === 'ArrowDown') {
    const first = $('modelList').querySelector('.picker-item');
    if (first) { event.preventDefault(); first.focus(); }
  }
});
$('modelList').addEventListener('keydown', event => {
  const items = [...$('modelList').querySelectorAll('.picker-item')];
  const index = items.indexOf(document.activeElement);
  if (event.key === 'ArrowDown' && index >= 0 && index < items.length - 1) { event.preventDefault(); items[index + 1].focus(); }
  else if (event.key === 'ArrowUp' && index >= 0) { event.preventDefault(); index === 0 ? $('modelSearch').focus() : items[index - 1].focus(); }
});
document.addEventListener('pointerdown', event => { if (!$('modelMenu').hidden && !event.target.closest('#modelMenu, #modelButton')) closeModelMenu(); });
window.addEventListener('resize', () => { if (!$('modelMenu').hidden) positionModelMenu(); });
document.addEventListener('scroll', () => { if (!$('modelMenu').hidden) positionModelMenu(); }, true);

// ---- project folder (coding agent) ----

function updateWorkspaceUI() {
  $('projectUse').textContent = workspace.ready ? '✓ Folder in use · change or clear' : '📁 Use this folder';
  $('projectHint').textContent = workspace.ready
    ? 'Agent mode is ON for ' + workspace.root + '. The AI can read files there, every change needs your approval, and 💾 Save writes into this folder.'
    : 'Paste the full path of your code project. The AI can read files there and propose edits (you approve every change), and 💾 Save buttons write into this folder. Empty + click turns it off.';
  updateModelLine();
}
$('projectUse').onclick = async () => {
  const folder = $('projectPath').value.trim();
  $('projectUse').disabled = true;
  try {
    const data = await readJSON(await fetch('/api/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: folder }) }));
    workspace = { ready: data.ready, root: data.root ?? null };
    try { if (data.ready) localStorage.setItem(LS_WORKSPACE, folder); else localStorage.removeItem(LS_WORKSPACE); } catch { /* ignore */ }
    updateWorkspaceUI();
    notice(data.ready ? 'Agent folder set: ' + data.root + ' — the AI can read this folder, and every change needs your approval.' : 'Agent folder cleared. The AI can no longer touch your files.');
  } catch (e) { notice(e.message); }
  finally { $('projectUse').disabled = false; }
};
for (const [id, key] of [['temperature', 'temperature'], ['top_p', 'top_p'], ['stop', 'stop'], ['systemPrompt', 'systemPrompt']]) {
  $(id).addEventListener('input', () => { settings[key] = $(id).value.trim(); persist(); });
}
$('tools').addEventListener('change', () => { settings.tools = $('tools').checked; persist(); updateModelLine(); });
$('effort').addEventListener('change', () => { settings.effort = $('effort').value; persist(); updateModelLine(); });
$('tokens').addEventListener('change', updateModelLine);
$('refresh').onclick = async () => {
  $('refresh').disabled = true; notice('Loading models…');
  try {
    const data = await readJSON(await fetch('/api/models'));
    if (!data.models.length) throw new Error('No models returned for this key. Check your provider dashboard.');
    fillModels(data.models); notice('Available models updated.');
  } catch (e) { notice(e.message); }
  finally { $('refresh').disabled = false; }
};
$('connect').onclick = async () => {
  const baseUrl = $('baseUrl').value.trim();
  const apiKey = $('providerKey').value.trim();
  $('connect').disabled = true; notice('Checking the provider…');
  try {
    const data = await readJSON(await fetch('/api/provider', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl, apiKey }) }));
    providerConfig = data.source === 'ui' ? { baseUrl, apiKey } : { baseUrl: '', apiKey: '' };
    saveProvider();
    connection = { ready: data.configured, source: data.source ?? null, baseUrl: data.baseUrl ?? null };
    fillModels(data.models ?? []);
    updateProviderUI(); updateConnectionUI();
    if (data.source === 'ui') notice(`Connected to ${safeHost(data.baseUrl)} — ${data.models.length} model${data.models.length === 1 ? '' : 's'} loaded.`);
    else notice(data.configured ? 'Now using the provider configured in .env.' : 'Cleared. Enter a base URL and key to connect your provider.');
  } catch (e) { notice(e.message); }
  finally { $('connect').disabled = false; }
};
$('newChat').onclick = () => {
  if (busy) return;
  setMenu(false);
  const chat = newChatRecord();
  if (!chat.model) chat.model = currentModel;
  state.chats.unshift(chat); state.activeId = chat.id;
  persist(); renderAll(); notice(''); $('prompt').focus();
};
$('stop').onclick = () => active?.abort();
$('attach').onclick = () => $('fileInput').click();
$('fileInput').onchange = () => { addFiles([...$('fileInput').files]); $('fileInput').value = ''; };
$('prompt').addEventListener('paste', event => {
  const files = [...(event.clipboardData?.items ?? [])].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
  if (files.length) { event.preventDefault(); addFiles(files); }
});
$('form').addEventListener('dragover', event => { event.preventDefault(); $('form').classList.add('dropping'); });
$('form').addEventListener('dragleave', () => $('form').classList.remove('dropping'));
$('form').addEventListener('drop', event => {
  event.preventDefault(); $('form').classList.remove('dropping');
  addFiles([...event.dataTransfer.files]);
});
$('prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!busy) $('form').requestSubmit();
  }
});

// ---- sending ----

$('form').onsubmit = async event => {
  event.preventDefault();
  if (busy) return;
  if (!connection.ready) { notice('Connect your AI provider first: open Model & settings and click "Connect & load models".'); return; }
  const chat = activeChat();
  const promptText = $('prompt').value.trim();
  if (!promptText && !attachments.length) return;
  const parts = [];
  if (promptText) parts.push({ type: 'text', text: promptText });
  for (const attachment of attachments) parts.push({ type: 'image_url', image_url: { url: attachment.url } });
  const content = parts.length === 1 && parts[0].type === 'text' ? promptText : parts;
  const outgoing = [...chat.messages.map(m => m.role === 'user'
    ? { role: 'user', content: m.parts.length === 1 && m.parts[0].type === 'text' ? m.parts[0].text : m.parts }
    : { role: 'assistant', content: m.text }), { role: 'user', content }];
  const userRecord = { role: 'user', parts: content === promptText ? [{ type: 'text', text: promptText }] : parts };

  const userRefs = renderMessage(userRecord);
  addCopy(userRefs.card, promptText);
  const refs = renderMessage({ role: 'assistant', text: '' });
  const skeleton = document.createElement('div'); skeleton.className = 'skeleton';
  for (let i = 0; i < 3; i++) skeleton.append(document.createElement('span'));
  refs.body.replaceChildren(skeleton);
  refs.card.classList.add('generating');
  scroll(true);

  const body = { model: chat.model || currentModel, messages: outgoing, max_tokens: Number($('tokens').value), tools: $('tools').checked };
  const temperature = parseFloat($('temperature').value);
  if (!Number.isNaN(temperature)) body.temperature = temperature;
  const top_p = parseFloat($('top_p').value);
  if (!Number.isNaN(top_p)) body.top_p = top_p;
  const stops = $('stop').value.split(',').map(s => s.trim()).filter(Boolean).slice(0, 4);
  if (stops.length) body.stop = stops;
  if ($('effort').value) body.reasoning_effort = $('effort').value;
  const systemPrompt = $('systemPrompt').value.trim();
  if (systemPrompt) body.systemPrompt = systemPrompt;

  $('prompt').value = ''; attachments = []; renderAttachments(); notice(''); autoGrow();
  active = new AbortController(); setBusy(true);

  let text = '', reasoning = '', usage = null, finish = null, done = false, streamError = null;
  const toolTrace = [];
  const proposals = [];
  try {
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: active.signal });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let lastEvent = '';
    const handleBlock = block => {
      const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n').trim();
      if (!data) return;
      lastEvent = data;
      let item;
      try { item = JSON.parse(data); } catch { return; }
      if (typeof item.type !== 'string') { console.warn('Unrecognized stream event (is this an outdated page? hard-refresh with Ctrl+Shift+R):', item); return; }
      if (item.type === 'content') { text += item.text; refs.body.textContent = text; refs.body.classList.add('streaming'); scroll(); }
      else if (item.type === 'reasoning') { reasoning += item.text; ensureThinking(refs, true).textContent = reasoning; if (!text) { refs.body.textContent = 'Thinking…'; refs.body.classList.add('streaming'); } scroll(); }
      else if (item.type === 'tool') { toolTrace.push({ name: item.name, args: item.args, result: item.result, ok: item.ok, ms: item.ms }); ensureTools(refs, true).append(toolRow(toolTrace.at(-1))); refs.toolsSummary.textContent = `Using tools… (${toolTrace.length})`; scroll(); }
      else if (item.type === 'proposal') {
        const pending = { id: item.id, tool: item.tool, path: item.path, before: item.before ?? null, after: item.after ?? '', decision: null };
        proposals.push(pending);
        ensureProposals(refs).append(proposalCard(pending));
        notice('Change requested: ' + item.path + ' — review the diff above the message and click Apply or Reject.');
        scroll();
      }
      else if (item.type === 'usage') usage = item.usage;
      else if (item.type === 'done') { finish = item.finish_reason; done = true; }
      else if (item.type === 'error') streamError = item.message;
    };
    while (true) {
      const part = await reader.read();
      buffer += part.done ? decoder.decode() : decoder.decode(part.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) { handleBlock(buffer.slice(0, cut)); buffer = buffer.slice(cut + 2); }
      if (part.done) break;
    }
    if (buffer.trim()) handleBlock(buffer);
    if (streamError) throw new Error(streamError);
    if (!done) { console.warn('Stream ended without a done event. Last event received:', lastEvent); throw new Error('Connection ended before the reply finished. If this repeats, hard-refresh the page with Ctrl+Shift+R.'); }
    if (!text.trim()) throw new Error('No answer text returned. Reasoning or tools may have used the token budget; increase Max output tokens and retry.');

    if (refs.thinkingBox?.open) refs.thinkingBox.open = false;
    if (refs.toolsBox) {
      refs.toolsBox.open = false;
      const names = [...new Set(toolTrace.map(t => t.name))].join(', ');
      refs.toolsSummary.textContent = `Tools used: ${names} · ${toolTrace.length} call${toolTrace.length > 1 ? 's' : ''}`;
    }
    refs.card.classList.remove('generating');
    refs.body.classList.remove('streaming');
    renderText(refs.body, text);
    refs.meta.textContent = usageLine(body.model, usage, finish);
    addCopy(refs.card, text);
    const assistantRecord = { role: 'assistant', text };
    if (reasoning) assistantRecord.reasoning = reasoning;
    if (toolTrace.length) assistantRecord.tools = toolTrace;
    if (proposals.length) assistantRecord.proposals = proposals.map(pending => ({
      id: pending.id, tool: pending.tool, path: pending.path, decision: pending.decision,
      before: pending.before === null ? null : pending.before.slice(0, 60000),
      after: String(pending.after ?? '').slice(0, 60000),
      clipped: (pending.before?.length ?? 0) > 60000 || (pending.after?.length ?? 0) > 60000
    }));
    if (usage) assistantRecord.usage = usage;
    if (finish) assistantRecord.finish = finish;
    chat.messages.push(userRecord, assistantRecord);
    chat.updatedAt = Date.now();
    if (chat.title === 'New conversation') chat.title = truncate(promptText || 'Image question', 42);
    chat.model = body.model;
    persist(); renderChatList();
  } catch (e) {
    refs.card.classList.remove('generating');
    refs.body.classList.remove('streaming');
    refs.meta.textContent = e.name === 'AbortError' ? 'Stopped. This exchange was not added to the next request.' : e.message;
    if (!text) refs.body.textContent = 'No reply received.';
    else renderText(refs.body, text);
    if (!$('prompt').value) $('prompt').value = promptText;
    autoGrow();
    if (content !== promptText) { attachments = parts.filter(p => p.type === 'image_url').map(p => ({ url: p.image_url.url, name: 'image' })); renderAttachments(); notice('Images were kept so you can retry.'); }
  } finally {
    active = null; setBusy(false); $('prompt').focus(); scroll();
  }
};

// ---- init ----

loadAll();
loadProvider();
hydrateSettings();
$('baseUrl').value = providerConfig.baseUrl;
$('providerKey').value = providerConfig.apiKey;
renderAll();
document.body.append($('modelMenu')); // escapes the sidebar's scroll clipping for the dropdown

// ---- app shell: drawer, scroll-to-bottom, composer ----

function setMenu(open) { document.body.classList.toggle('menu-open', open); if (!open) closeModelMenu(); }
$('menu').onclick = () => setMenu(true);
$('closeMenu').onclick = () => setMenu(false);
$('overlay').onclick = () => setMenu(false);
document.addEventListener('keydown', event => { if (event.key === 'Escape') { setMenu(false); closeModelMenu(); } });

const conversationEl = $('conversation');
conversationEl.addEventListener('scroll', () => { $('toBottom').hidden = conversationEl.scrollHeight - conversationEl.scrollTop - conversationEl.clientHeight < 320; });
$('toBottom').onclick = () => conversationEl.scrollTo({ top: conversationEl.scrollHeight, behavior: 'smooth' });

function autoGrow() { const el = $('prompt'); el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 190) + 'px'; }
$('prompt').addEventListener('input', autoGrow);
for (const button of document.querySelectorAll('.suggestions button')) button.onclick = () => { $('prompt').value = button.dataset.prompt || ''; autoGrow(); $('prompt').focus(); };

fetch('/api/config').then(readJSON).then(async data => {
  pricing = data.pricing ?? {};
  connection = { ready: data.configured, source: data.source ?? null, baseUrl: data.baseUrl ?? null };
  fillModels(data.models);
  if (providerConfig.baseUrl && providerConfig.apiKey) {
    try {
      const fresh = await readJSON(await fetch('/api/provider', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(providerConfig) }));
      connection = { ready: fresh.configured, source: fresh.source ?? null, baseUrl: fresh.baseUrl ?? null };
      if (fresh.models?.length) fillModels(fresh.models);
    } catch (e) { notice('Saved provider could not reconnect: ' + e.message); }
  }
  workspace = { ready: Boolean(data.workspace?.ready), root: data.workspace?.root ?? null };
  let savedFolder = '';
  try { savedFolder = localStorage.getItem(LS_WORKSPACE) || ''; } catch { /* ignore */ }
  if (savedFolder) $('projectPath').value = savedFolder;
  updateWorkspaceUI();
  if (savedFolder && !workspace.ready) {
    try {
      const fresh = await readJSON(await fetch('/api/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: savedFolder }) }));
      workspace = { ready: fresh.ready, root: fresh.root ?? null };
      updateWorkspaceUI();
    } catch { notice('The saved project folder could not be reopened — set it again under Project folder.'); }
  }
  updateProviderUI(); updateConnectionUI();
  if (!data.models.length && connection.ready) $('refresh').click();
  if (!activeChat().model) { activeChat().model = currentModel; persist(); }
  if (!connection.ready) notice('Connect your provider under Model & settings to start chatting.');
}).catch(() => {
  notice('Start this app with npm start and open the local URL. Do not open index.html directly.');
  $('connection').textContent = 'Server unavailable';
});
