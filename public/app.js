const $ = id => document.getElementById(id);
const LS_CHATS = 'riverchat.chats.v2';
const LS_SETTINGS = 'riverchat.settings.v2';

let pricing = {};
let state = { chats: [], activeId: null };
let settings = { temperature: '', top_p: '', stop: '', tools: true, effort: '', systemPrompt: '' };
let attachments = [];
let active = null;
let busy = false;
const FS_SUPPORTED = typeof window.showDirectoryPicker === 'function';
let outputDir = null;
let folderGranted = false;

const shortName = id => String(id || '').split('/').pop();
const activeChat = () => state.chats.find(c => c.id === state.activeId) ?? state.chats[0];
function notice(text) { $('notice').textContent = text; }
function scroll() { $('conversation').scrollTop = $('conversation').scrollHeight; }
function setBusy(b) { busy = b; for (const id of ['send', 'newChat', 'model', 'tokens', 'refresh', 'effort', 'attach']) $(id).disabled = b; $('stop').hidden = !b; }
function readJSON(response) { return response.json().then(data => { if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); return data; }); }

// ---- persistence ----

function newChatRecord() {
  return { id: crypto.randomUUID(), title: 'New conversation', model: $('model')?.value || '', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
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
      if (!FS_SUPPORTED) { target.append(pre); return; }
      const block = document.createElement('div'); block.className = 'code-block';
      const bar = document.createElement('div'); bar.className = 'code-bar';
      const name = fenceTarget(info);
      const save = document.createElement('button');
      save.type = 'button'; save.className = 'code-save';
      save.textContent = name ? `💾 Save as ${name}` : '💾 Save code';
      save.title = 'Save this code into your chosen folder';
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
  const label = document.createElement('div'); label.className = 'label'; label.textContent = record.role === 'user' ? 'YOU' : 'RIVER';
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
  if (finish === 'tool_limit') bits.push('Tool limit reached after 5 rounds.');
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
  scroll();
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
  state.activeId = id;
  const chat = activeChat();
  if (chat.model && [...$('model').options].some(option => option.value === chat.model)) $('model').value = chat.model;
  else if (!chat.model) chat.model = $('model').value;
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

// ---- saving code to a folder ----

let folderDB = null;
function openFolderDB() {
  if (folderDB) return Promise.resolve(folderDB);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('riverchat.files', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('kv');
    request.onsuccess = () => { folderDB = request.result; resolve(folderDB); };
    request.onerror = () => reject(request.error);
  });
}
async function folderStore(mode, action) {
  const db = await openFolderDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode);
    const request = action(tx.objectStore('kv'));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
const folderGet = key => folderStore('readonly', store => store.get(key));
const folderSet = (key, value) => folderStore('readwrite', store => store.put(value, key));

function updateFolderUI() {
  if (!FS_SUPPORTED) return;
  $('folderBox').hidden = false;
  if (!outputDir) {
    $('folderBtn').textContent = '📁 Choose folder for saved code…';
    $('folderHint').textContent = 'Save buttons under code blocks write files there.';
  } else if (folderGranted) {
    $('folderBtn').textContent = '📁 ' + outputDir.name + ' · change';
    $('folderHint').textContent = 'Code files you save go into this folder.';
  } else {
    $('folderBtn').textContent = '📁 Re-allow "' + outputDir.name + '"';
    $('folderHint').textContent = 'The browser needs one click to re-open the folder.';
  }
}
async function pickFolder() {
  try {
    const handle = await window.showDirectoryPicker({ id: 'riverchat-code', mode: 'readwrite' });
    outputDir = handle; folderGranted = true;
    folderSet('outputDir', handle).catch(() => { /* remember for next time only */ });
    updateFolderUI();
    notice('Code files will be saved to the "' + handle.name + '" folder.');
    return true;
  } catch (e) {
    if (e?.name !== 'AbortError') notice('Could not use that folder: ' + (e?.message || e?.name || 'unknown error'));
    return false;
  }
}
async function ensureDirAccess() {
  if (!FS_SUPPORTED) throw new Error('Saving to a folder needs Chrome or Edge.');
  if (!outputDir && !(await pickFolder())) throw new Error('Pick a folder to save code into.');
  if (!folderGranted) {
    let granted = false;
    try { granted = (await outputDir.requestPermission({ mode: 'readwrite' })) === 'granted'; } catch { /* denied */ }
    folderGranted = granted;
    updateFolderUI();
    if (!granted) throw new Error('Folder access was not granted. Pick the folder again.');
  }
  return outputDir;
}
async function writeCodeFile(dir, relPath, content) {
  const segments = relPath.split('/');
  const fileName = segments.pop();
  let target = dir;
  for (const segment of segments) target = await target.getDirectoryHandle(segment, { create: true });
  let exists = false;
  try { await target.getFileHandle(fileName); exists = true; } catch { /* new file */ }
  if (exists && !confirm('"' + relPath + '" already exists in "' + dir.name + '". Overwrite it?')) return null;
  const file = await target.getFileHandle(fileName, { create: true });
  const writable = await file.createWritable();
  await writable.write(content);
  await writable.close();
  return relPath;
}
async function saveCodeBlock(codeText, info) {
  try {
    const dir = await ensureDirAccess();
    let relPath = sanitizeRelPath(fenceTarget(info));
    if (!relPath) {
      const language = String(info || '').trim().split(/\s+/)[0] || '';
      const entered = prompt('File name for this code (subfolders like src/app.js are allowed):', 'snippet.' + languageExt(language));
      relPath = entered ? sanitizeRelPath(entered) : null;
      if (entered && !relPath) { notice('That file name is not valid. Use letters, numbers, dots, dashes and / for subfolders.'); return; }
      if (!relPath) return;
    }
    const saved = await writeCodeFile(dir, relPath, codeText);
    if (saved) notice('Saved "' + saved + '" into the "' + dir.name + '" folder.');
  } catch (e) {
    if (e?.name !== 'AbortError') notice(e?.message || 'Could not save the file.');
  }
}

// ---- model + settings wiring ----

function effortChoices(model) {
  const name = String(model).toLowerCase();
  if (name.includes('deepseek')) return [['', 'Model default'], ['none', 'None — fastest'], ['high', 'High'], ['max', 'Max']];
  if (name.includes('glm')) return [['', 'Model default'], ['low', 'Low'], ['high', 'High'], ['max', 'Max']];
  return [];
}
function updateEffort() {
  const choices = effortChoices($('model').value);
  $('effortBox').hidden = choices.length === 0;
  const previous = $('effort').value;
  $('effort').replaceChildren(...choices.map(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; return option; }));
  const wanted = [previous, settings.effort].find(value => choices.some(([v]) => v === value));
  $('effort').value = wanted ?? '';
}
function fillModels(models) {
  const select = $('model');
  const keep = select.value || activeChat()?.model || '';
  const all = [...new Set([...models, ...(keep ? [keep] : [])])];
  select.replaceChildren(...all.map(id => { const option = document.createElement('option'); option.value = id; option.textContent = shortName(id); option.title = id; return option; }));
  select.value = all.includes(keep) ? keep : (all[0] ?? '');
  updateEffort();
}
function hydrateSettings() {
  $('temperature').value = settings.temperature ?? '';
  $('top_p').value = settings.top_p ?? '';
  $('stop').value = settings.stop ?? '';
  $('tools').checked = settings.tools !== false;
  $('systemPrompt').value = settings.systemPrompt ?? '';
}

$('model').addEventListener('change', () => {
  const chat = activeChat();
  chat.model = $('model').value;
  chat.updatedAt = Date.now();
  updateEffort(); persist(); renderChatList();
});
for (const [id, key] of [['temperature', 'temperature'], ['top_p', 'top_p'], ['stop', 'stop'], ['systemPrompt', 'systemPrompt']]) {
  $(id).addEventListener('input', () => { settings[key] = $(id).value.trim(); persist(); });
}
$('tools').addEventListener('change', () => { settings.tools = $('tools').checked; persist(); });
$('effort').addEventListener('change', () => { settings.effort = $('effort').value; persist(); });
$('refresh').onclick = async () => {
  $('refresh').disabled = true; notice('Loading models…');
  try {
    const data = await readJSON(await fetch('/api/models'));
    if (!data.models.length) throw new Error('No models returned for this key. Check your provider dashboard.');
    fillModels(data.models); notice('Available models updated.');
  } catch (e) { notice(e.message); }
  finally { $('refresh').disabled = false; }
};
$('newChat').onclick = () => {
  if (busy) return;
  const chat = newChatRecord();
  if (!chat.model) chat.model = $('model').value;
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
  refs.body.textContent = 'Connecting…';

  const body = { model: chat.model || $('model').value, messages: outgoing, max_tokens: Number($('tokens').value), tools: $('tools').checked };
  const temperature = parseFloat($('temperature').value);
  if (!Number.isNaN(temperature)) body.temperature = temperature;
  const top_p = parseFloat($('top_p').value);
  if (!Number.isNaN(top_p)) body.top_p = top_p;
  const stops = $('stop').value.split(',').map(s => s.trim()).filter(Boolean).slice(0, 4);
  if (stops.length) body.stop = stops;
  if ($('effort').value) body.reasoning_effort = $('effort').value;
  const systemPrompt = $('systemPrompt').value.trim();
  if (systemPrompt) body.systemPrompt = systemPrompt;

  $('prompt').value = ''; attachments = []; renderAttachments(); notice('');
  active = new AbortController(); setBusy(true);

  let text = '', reasoning = '', usage = null, finish = null, done = false, streamError = null;
  const toolTrace = [];
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
      if (item.type === 'content') { text += item.text; refs.body.textContent = text; scroll(); }
      else if (item.type === 'reasoning') { reasoning += item.text; ensureThinking(refs, true).textContent = reasoning; if (!text) refs.body.textContent = 'Thinking…'; scroll(); }
      else if (item.type === 'tool') { toolTrace.push({ name: item.name, args: item.args, result: item.result, ok: item.ok, ms: item.ms }); ensureTools(refs, true).append(toolRow(toolTrace.at(-1))); refs.toolsSummary.textContent = `Using tools… (${toolTrace.length})`; scroll(); }
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
    renderText(refs.body, text);
    refs.meta.textContent = usageLine(body.model, usage, finish);
    addCopy(refs.card, text);
    const assistantRecord = { role: 'assistant', text };
    if (reasoning) assistantRecord.reasoning = reasoning;
    if (toolTrace.length) assistantRecord.tools = toolTrace;
    if (usage) assistantRecord.usage = usage;
    if (finish) assistantRecord.finish = finish;
    chat.messages.push(userRecord, assistantRecord);
    chat.updatedAt = Date.now();
    if (chat.title === 'New conversation') chat.title = truncate(promptText || 'Image question', 42);
    chat.model = body.model;
    persist(); renderChatList();
  } catch (e) {
    refs.meta.textContent = e.name === 'AbortError' ? 'Stopped. This exchange was not added to the next request.' : e.message;
    if (!text) refs.body.textContent = 'No reply received.';
    else renderText(refs.body, text);
    if (!$('prompt').value) $('prompt').value = promptText;
    if (content !== promptText) { attachments = parts.filter(p => p.type === 'image_url').map(p => ({ url: p.image_url.url, name: 'image' })); renderAttachments(); notice('Images were kept so you can retry.'); }
  } finally {
    active = null; setBusy(false); $('prompt').focus(); scroll();
  }
};

// ---- init ----

loadAll();
hydrateSettings();
renderAll();
if (FS_SUPPORTED) {
  $('folderBtn').onclick = async () => {
    if (outputDir && !folderGranted) {
      let granted = false;
      try { granted = (await outputDir.requestPermission({ mode: 'readwrite' })) === 'granted'; } catch { /* denied */ }
      if (granted) { folderGranted = true; updateFolderUI(); notice('Writing to "' + outputDir.name + '" is allowed again.'); return; }
    }
    pickFolder();
  };
  (async () => {
    try {
      const stored = await folderGet('outputDir');
      if (stored) {
        outputDir = stored;
        try { folderGranted = (await stored.queryPermission({ mode: 'readwrite' })) === 'granted'; } catch { folderGranted = false; }
      }
    } catch { /* no stored folder */ }
    updateFolderUI();
  })();
}
fetch('/api/config').then(readJSON).then(data => {
  pricing = data.pricing ?? {};
  fillModels(data.models);
  if (!data.models.length) $('refresh').click();
  if (!activeChat().model) { activeChat().model = $('model').value; persist(); }
  $('connection').textContent = data.configured ? 'API key configured' : 'Setup needed';
  if (!data.configured) notice('Add your API key to .env, then restart the server. See README.md.');
}).catch(() => {
  notice('Start this app with npm start and open the local URL. Do not open index.html directly.');
  $('connection').textContent = 'Server unavailable';
});
