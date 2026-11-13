// The slash menu (/commands) and the suggestion list for [[pages]],
// ((blocks)) and /commands while typing in a block.

import { api, getPageNames } from './api.js';
import { ENCRYPTED_TAG } from './crypto.js';
import { journalName } from './dates.js';
import { el } from './dom.js';
import { autosize, inFence, lineAt, timeNow, timestamp } from './editor.js';
import { pickImages } from './images.js';
import { esc, findFences, mathSpans } from './render.js';
import { getStatuses } from './tasks.js';

// ---- slash commands ----------------------------------------------------------

export const SLASH_COMMANDS = [
  { id: 'link', label: 'Link', hint: '[text](url)' },
  { id: 'page', label: 'Page reference', hint: '[[ ]]' },
  { id: 'blockref', label: 'Block reference', hint: '(( ))' },
  { id: 'code', label: 'Code block', hint: '```' },
  { id: 'table', label: 'Table', hint: '| a | b |' },
  { id: 'numbered', label: 'Numbered list' },
  { id: 'h1', label: 'Heading 1', hint: '#' },
  { id: 'h2', label: 'Heading 2', hint: '##' },
  { id: 'h3', label: 'Heading 3', hint: '###' },
  { id: 'quote', label: 'Quote line', hint: '>' },
  { id: 'hr', label: 'Horizontal line', hint: '---' },
  { id: 'quoteblock', label: 'Quote block', hint: '#quote (block and children)' },
  { id: 'encrypted', label: 'Encrypted block', hint: '#Encrypted (children are encrypted)' },
  { id: 'tip', label: 'Tip', hint: 'admonition' },
  { id: 'note', label: 'Note', hint: 'admonition' },
  { id: 'important', label: 'Important', hint: 'admonition' },
  { id: 'caution', label: 'Caution', hint: 'admonition' },
  { id: 'warning', label: 'Warning', hint: 'admonition' },
  { id: 'pinned', label: 'Pinned', hint: 'admonition' },
  { id: 'image', label: 'Upload image', hint: 'png, jpg, gif, webp' },
  { id: 'pdf', label: 'Upload PDF', hint: 'link or preview' },
  { id: 'file', label: 'Upload file', hint: 'video, audio, documents…' },
  { id: 'video', label: 'Embed video', hint: 'YouTube or Vimeo link' },
  { id: 'today', label: 'Today', hint: "today's journal" },
  { id: 'time', label: 'Current time', hint: 'e.g. 14:32' },
  { id: 'timestamp', label: 'Timestamp', hint: "today's journal + time" },
  { id: 'math', label: 'Math (LaTeX)', hint: '$$ … $$' },
  { id: 'tomorrow', label: 'Tomorrow' },
  { id: 'yesterday', label: 'Yesterday' },
];

// A bare "/" shows a short menu: common commands, then groups that open
// with Enter or →. Typing anything searches every command (slashMatches).
const SLASH_TOP = ['link', 'page', 'blockref', 'code', 'table', 'numbered', 'quote', 'math', 'encrypted'];
const SLASH_GROUPS = [
  { key: 'headings', label: 'Headings', ids: ['h1', 'h2', 'h3'] },
  { key: 'boxes', label: 'Admonitions & quote block', ids: ['tip', 'note', 'important', 'caution', 'warning', 'pinned', 'quoteblock'] },
  { key: 'media', label: 'Upload & embed', ids: ['image', 'pdf', 'file', 'video'] },
  { key: 'dates', label: 'Dates & times', ids: ['today', 'tomorrow', 'yesterday', 'time', 'timestamp'] },
  { key: 'status', label: 'Task status', ids: null }, // from Settings
];

function statusCommands() {
  return getStatuses().map((s) => ({ id: `status:${s.word}`, label: s.label, hint: 'task status', word: s.word }));
}

function slashMenu(group) {
  const byId = (id) => SLASH_COMMANDS.find((c) => c.id === id);
  const row = (c) => ({ label: `${esc(c.label)}${c.hint ? `<span class="cmd-hint">${esc(c.hint)}</span>` : ''}`, value: c.id });
  if (group) {
    const g = SLASH_GROUPS.find((x) => x.key === group);
    const cmds = g.ids ? g.ids.map(byId) : statusCommands();
    return [{ label: `‹ ${esc(g.label)}`, value: 'back', cls: 'ac-back' }, ...cmds.map(row)];
  }
  return [
    ...SLASH_TOP.map((id) => row(byId(id))),
    ...SLASH_GROUPS.map((g) => {
      const names = (g.ids ? g.ids.map((id) => byId(id).label) : statusCommands().map((c) => c.label));
      const preview = names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : '');
      return { label: `${esc(g.label)}<span class="cmd-hint">${esc(preview)} ›</span>`, value: `group:${g.key}`, cls: 'ac-group' };
    }),
  ];
}

function slashMatches(query) {
  const q = query.toLowerCase();
  // Task statuses come from Settings, so they are added each time.
  const statusCmds = statusCommands();
  const hit = (c) => c.id.startsWith(q) || c.label.toLowerCase().includes(q) || c.word?.toLowerCase().startsWith(q);
  const first = (c) => c.id.startsWith(q) || c.label.toLowerCase().startsWith(q) || !!c.word?.toLowerCase().startsWith(q);
  return [...SLASH_COMMANDS, ...statusCmds].filter(hit).sort((a, b) => first(b) - first(a));
}

export function runSlash(editor, node, ta, cmd, at) {
  // `at` is where the "/query" text was; it has already been removed.
  const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return `[[${journalName(d)}]]`; };
  switch (cmd) {
    case 'link': return editor.replaceText(node, ta, at, at, '[text](https://)', 1, 5);
    case 'page':
      editor.replaceText(node, ta, at, at, '[[]]', 2);
      return updateAutocomplete(editor, node, ta);
    case 'blockref':
      editor.replaceText(node, ta, at, at, '(())', 2);
      return updateAutocomplete(editor, node, ta);
    case 'code': {
      const lead = at > 0 && ta.value[at - 1] !== '\n' ? '\n' : '';
      editor.replaceText(node, ta, at, at, `${lead}\`\`\`\n\n\`\`\``, lead.length + 4);
      const idx = findFences(node.content).findIndex((f) => f.start === at + lead.length);
      return editor.openCodeEditor(node, Math.max(0, idx), 0);
    }
    case 'table': {
      const lead = at > 0 && ta.value[at - 1] !== '\n' ? '\n' : '';
      const t = `${lead}| Column 1 | Column 2 |\n| --- | --- |\n|  |  |`;
      return editor.replaceText(node, ta, at, at, t, lead.length + 2, lead.length + 10);
    }
    case 'tip': case 'note': case 'important': case 'caution': case 'warning': case 'pinned': {
      const lead = at > 0 && ta.value[at - 1] !== '\n' ? '\n' : '';
      const kind = cmd.toUpperCase();
      return editor.replaceText(node, ta, at, at, `${lead}#+BEGIN_${kind}\n\n#+END_${kind}`, lead.length + kind.length + 9);
    }
    case 'encrypted': {
      // This block becomes the readable label; the secret goes in a child.
      const first = ta.value.split('\n')[0];
      if (!ENCRYPTED_TAG.test(first)) {
        const label = first.trim() ? `${first.trimEnd()} ` : 'Encrypted ';
        editor.replaceText(node, ta, 0, first.length, `${label}#Encrypted`);
      }
      return editor.startSecretChild(node);
    }
    case 'quoteblock': {
      const first = ta.value.split('\n')[0];
      if (/(^|\s)#quote(\s|$)/i.test(first)) return;
      const pos = first.length;
      return editor.replaceText(node, ta, pos, pos, `${first.trim() ? ' ' : ''}#quote`, ta.selectionStart - pos);
    }
    case 'pdf':
      return pickImages('application/pdf,.pdf').then((files) => { if (files.length) editor.insertImages(node, files, at); });
    case 'file':
      return pickImages('').then((files) => { if (files.length) editor.insertImages(node, files, at); });
    case 'video':
      return editor.replaceText(node, ta, at, at, '{{video }}', 8);
    case 'numbered': return editor.toggleNumbered(node);
    case 'h1': case 'h2': case 'h3': return editor.setHeading(node, Number(cmd[1]));
    case 'quote': {
      const { start } = lineAt(ta.value, at);
      return editor.replaceText(node, ta, start, start, '> ', ta.selectionStart - start + 2);
    }
    case 'hr': {
      // On a line of its own: here if the line is empty, otherwise after it.
      const { start, end } = lineAt(ta.value, at);
      if (!ta.value.slice(start, end).trim()) return editor.replaceText(node, ta, start, end, '---');
      const last = start + ta.value.slice(start, end).trimEnd().length;
      return editor.replaceText(node, ta, last, end, '\n---');
    }
    case 'image':
      return pickImages().then((files) => { if (files.length) editor.insertImages(node, files, at); });
    case 'today': return editor.replaceText(node, ta, at, at, day(0));
    case 'time': return editor.replaceText(node, ta, at, at, timeNow());
    case 'timestamp': return editor.replaceText(node, ta, at, at, timestamp());
    case 'math': {
      // Inside an existing formula: edit it; otherwise build a new one here.
      const span = mathSpans(ta.value).find((m) => m.start < at && at < m.end);
      return editor.openMath(node, span || null, span ? null : at);
    }
    case 'tomorrow': return editor.replaceText(node, ta, at, at, day(1));
    case 'yesterday': return editor.replaceText(node, ta, at, at, day(-1));
    default:
      if (cmd.startsWith('status:')) return editor.setMarker(node, cmd.slice(7));
  }
}

// ---- autocomplete for [[pages]], ((blocks)) and /commands -------------------

let ac = null;

export function closeAutocomplete() {
  ac?.el.remove();
  ac = null;
}

export async function updateAutocomplete(editor, node, ta) {
  const before = ta.value.slice(0, ta.selectionStart);
  const page = /\[\[([^[\]\n]*)$/.exec(before);
  const block = !page && /\(\(([^()\n]*)$/.exec(before);
  const slash = !page && !block && !inFence(ta.value, ta.selectionStart) && /(?:^|\s)\/([\w-]*)$/.exec(before);
  const tag = !page && !block && !slash && !inFence(ta.value, ta.selectionStart)
    && /(?:^|\s)#([^\s#,.!?;:()[\]"'`+][^\s#,.!?;:()[\]"'`]*|)$/.exec(before);
  if (!page && !block && !slash && !tag) return closeAutocomplete();
  const query = (page || block || slash || tag)[1];
  const kind = page ? 'page' : block ? 'block' : slash ? 'slash' : 'tag';
  const seq = (ac?.seq || 0) + 1;

  let items = [];
  // An open slash group survives until something is typed after the "/".
  const group = kind === 'slash' && !query && ac?.ta === ta && ac.kind === 'slash' ? ac.group || null : null;
  if (kind === 'slash') {
    items = query ? slashMatches(query).map((c) => ({
      label: `${esc(c.label)}${c.hint ? `<span class="cmd-hint">${esc(c.hint)}</span>` : ''}`,
      value: c.id,
    })) : slashMenu(group);
    if (!items.length) return closeAutocomplete(); // e.g. typing a path like /etc
  }
  if (!ac || ac.ta !== ta) {
    closeAutocomplete();
    const box = el('div', 'popup autocomplete');
    document.body.append(box);
    ac = { el: box, ta, editor, node, items: [], index: 0 };
  }
  ac.seq = seq;
  ac.kind = kind;
  ac.query = query;
  ac.group = group;

  if (kind === 'page') {
    const q = query.toLowerCase();
    const names = await getPageNames();
    items = names
      .filter((n) => n.toLowerCase().includes(q))
      .sort((a, b) => (b.toLowerCase().startsWith(q) - a.toLowerCase().startsWith(q)) || a.length - b.length)
      .slice(0, 8)
      .map((n) => ({ label: esc(n), value: n }));
    if (q && !names.some((n) => n.toLowerCase() === q)) items.push({ label: `New page: <b>${esc(query)}</b>`, value: query });
  } else if (kind === 'tag') {
    // Like Logseq: "New tag …" first, then existing pages that match.
    const q = query.toLowerCase();
    const names = await getPageNames();
    const mark = (n) => {
      const i = n.toLowerCase().indexOf(q);
      return q && i >= 0 ? `${esc(n.slice(0, i))}<mark>${esc(n.slice(i, i + q.length))}</mark>${esc(n.slice(i + q.length))}` : esc(n);
    };
    const found = names
      .filter((n) => !/^[A-Z][a-z]{2} \d{1,2}(st|nd|rd|th), \d{4}$/.test(n) && n.toLowerCase().includes(q))
      .sort((a, b) => (b.toLowerCase().startsWith(q) - a.toLowerCase().startsWith(q)) || a.length - b.length)
      .slice(0, 7)
      .map((n) => ({ label: mark(n), value: n }));
    items = q && !names.some((n) => n.toLowerCase() === q) ? [{ label: `New tag <b>${esc(query)}</b>`, value: query }, ...found] : found;
    if (!q && !items.length) return closeAutocomplete();
  } else if (kind === 'block' && query.trim().length >= 2) {
    try {
      const res = await api.search(query, 8);
      items = res.blocks.filter((b) => b.id !== node.id).map((b) => ({
        label: `${esc(b.content.slice(0, 90))}<small>${esc(b.page_name)}</small>`,
        value: b.id,
      }));
    } catch { items = []; }
  }
  if (!ac || ac.seq !== seq) return;
  if (!items.length) {
    ac.el.innerHTML = `<div class="hint">${kind === 'page' ? 'Type a page name' : 'Type to search blocks'}</div>`;
    ac.items = [];
  } else {
    ac.items = items;
    ac.index = 0;
    ac.el.replaceChildren(...items.map((it, i) => {
      const row = el('div', `item${it.cls ? ` ${it.cls}` : ''}`);
      row.innerHTML = it.label;
      row.addEventListener('mousedown', (e) => { e.preventDefault(); ac.index = i; acceptAutocomplete(e.ctrlKey || e.metaKey); });
      return row;
    }));
    if (kind === 'slash' && !query && !group) {
      const foot = el('div', 'hint ac-foot');
      foot.innerHTML = 'Type to search every command · <kbd>→</kbd> opens a group';
      ac.el.append(foot);
    }
    if (kind === 'tag') {
      const foot = el('div', 'hint ac-foot');
      foot.innerHTML = '<kbd>Ctrl</kbd> <kbd>⏎</kbd> to put the tag here instead of at the end of the line';
      ac.el.append(foot);
    }
    highlight();
  }
  const r = ta.getBoundingClientRect();
  ac.el.style.left = `${r.left + window.scrollX}px`;
  ac.el.style.top = `${r.bottom + window.scrollY + 4}px`;
}

function highlight() {
  [...ac.el.querySelectorAll('.item')].forEach((c, i) => c.classList.toggle('active', i === ac.index));
}

export function handleAutocompleteKey(e) {
  if (!ac) return false;
  if (e.key === 'Escape') { e.preventDefault(); closeAutocomplete(); return true; }
  if (!ac.items.length) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    ac.index = (ac.index + (e.key === 'ArrowDown' ? 1 : -1) + ac.items.length) % ac.items.length;
    highlight();
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    acceptAutocomplete(e.ctrlKey || e.metaKey);
    return true;
  }
  if (ac.kind === 'slash' && e.key === 'ArrowRight' && ac.items[ac.index]?.value.startsWith('group:')) {
    e.preventDefault();
    openSlashGroup(ac.items[ac.index].value.slice(6));
    return true;
  }
  if (ac.kind === 'slash' && e.key === 'ArrowLeft' && ac.group) {
    e.preventDefault();
    openSlashGroup(null);
    return true;
  }
  return false;
}

// Shows one group of the bare "/" menu (null: back to the top).
function openSlashGroup(key) {
  if (!ac) return;
  const { editor, node, ta } = ac;
  const from = ac.group;
  ac.group = key;
  updateAutocomplete(editor, node, ta).then(() => {
    // Coming back highlights the group that was open.
    if (!key && from && ac) {
      const i = ac.items.findIndex((it) => it.value === `group:${from}`);
      if (i >= 0) { ac.index = i; highlight(); }
    } else if (key && ac?.items.length > 1) {
      ac.index = 1;
      highlight();
    }
  });
}

function acceptAutocomplete(inline = false) {
  const { ta, editor, node, kind, query } = ac;
  const item = ac.items[ac.index];
  if (!item) return;
  if (kind === 'slash' && item.value.startsWith('group:')) return openSlashGroup(item.value.slice(6));
  if (kind === 'slash' && item.value === 'back') return openSlashGroup(null);
  const pos = ta.selectionStart;
  closeAutocomplete();
  if (kind === 'tag') {
    editor.beginOp();
    const name = item.value;
    const token = /^[^\s#,.!?;:()[\]"'`+][^\s#,.!?;:()[\]"'`]*$/.test(name) ? `#${name}` : `#[[${name}]]`;
    const at = pos - query.length - 1; // where "#query" starts
    const v = ta.value;
    const firstEnd = v.indexOf('\n') === -1 ? v.length : v.indexOf('\n');
    // Default: the tag goes to the end of the first line (shown on the right).
    if (inline || v.startsWith('```') || at > firstEnd) {
      const space = /^\s/.test(v.slice(pos)) ? '' : ' ';
      editor.replaceText(node, ta, at, pos, token + space, token.length + space.length);
      return;
    }
    const lead = at > 0 && v[at - 1] === ' ' ? 1 : 0;
    let first = v.slice(0, at - lead) + v.slice(pos, firstEnd);
    const has = new RegExp(`(^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'i').test(first);
    if (!has) first = first.trimEnd() + (first.trim() ? ' ' : '') + token;
    ta.value = first + v.slice(firstEnd);
    const caret = at - lead;
    ta.setSelectionRange(caret, caret);
    editor.setContent(node, ta.value);
    autosize(ta);
    return;
  }
  if (kind === 'slash') {
    editor.beginOp();
    const at = pos - query.length - 1; // remove "/query"
    editor.replaceText(node, ta, at, pos, '');
    runSlash(editor, node, ta, item.value, at);
    return;
  }
  const close = kind === 'page' ? ']]' : '))';
  const start = pos - query.length;
  const rest = ta.value.slice(pos).startsWith(close) ? ta.value.slice(pos + 2) : ta.value.slice(pos);
  const insert = item.value + close;
  ta.value = ta.value.slice(0, start) + insert + rest;
  const caret = start + insert.length;
  ta.setSelectionRange(caret, caret);
  editor.setContent(node, ta.value);
  autosize(ta);
}
