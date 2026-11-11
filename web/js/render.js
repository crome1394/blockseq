// Turns block text (Logseq-flavoured Markdown) into HTML for display.

export function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function safeUrl(url) {
  return /^(https?:|mailto:|\/|#|\.)/i.test(url) ? url : '#';
}

// Images are stored Logseq-style as ../assets/<name>; the server serves them
// at /assets/<name>.
export function assetUrl(url) {
  return url.startsWith('../assets/') ? '/assets/' + url.slice('../assets/'.length) : safeUrl(url);
}

// ![alt](url){:align "center"} — the {...} part is Logseq's image metadata.
export const IMAGE_SRC = '!\\[([^\\]\\n]*)\\]\\(([^)\\s]+)\\)(?:\\{([^}\\n]*)\\})?';

export function imageAlign(meta) {
  return /:align\s+"?(center|right|left)"?/.exec(meta || '')?.[1] || 'left';
}

// Counts images while rendering one block, so each image knows its position
// (the image menu uses it to find the image in the block text).
let imageIndex = 0;

const INLINE = [
  '`(?<code>[^`\\n]+)`',
  '!\\[(?<imgAlt>[^\\]\\n]*)\\]\\((?<imgUrl>[^)\\s]+)\\)(?:\\{(?<imgMeta>[^}\\n]*)\\})?',
  '\\[(?<linkText>[^\\]]+)\\]\\((?<linkUrl>[^)\\s]+)\\)',
  '#\\[\\[(?<tagb>[^\\]\\n]+)\\]\\]',
  '\\[\\[(?<page>[^\\]\\n]+)\\]\\]',
  '\\(\\((?<bref>[0-9a-fA-F-]{36})\\)\\)',
  '\\*\\*(?<bold>[^*\\n]+)\\*\\*',
  '~~(?<strike>[^~\\n]+)~~',
  '==(?<hl>[^=\\n]+)==',
  '(?<![\\w*])\\*(?<it1>[^*\\s](?:[^*\\n]*[^*\\s])?)\\*(?![\\w*])',
  '(?<![\\w])_(?<it2>[^_\\s](?:[^_\\n]*[^_\\s])?)_(?![\\w])',
  '(?<url>https?:\\/\\/[^\\s<>()]*[^\\s<>().,;:!?\'"])',
  '(?<![^\\s(])#(?<tag>[^\\s#,.!?;:()\\[\\]"\'`]+)',
].join('|');

export function pageLink(name, tag = false) {
  const href = `#/page/${encodeURIComponent(name)}`;
  if (tag) return `<a class="page-ref tag" data-page="${esc(name)}" href="${href}">#${esc(name)}</a>`;
  return `<a class="page-ref" data-page="${esc(name)}" href="${href}"><span class="brackets">[[</span>${esc(name)}<span class="brackets">]]</span></a>`;
}

export function inline(text) {
  const re = new RegExp(INLINE, 'g');
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index));
    const g = m.groups;
    if (g.code !== undefined) out += `<code>${esc(g.code)}</code>`;
    else if (g.imgUrl !== undefined) {
      const align = imageAlign(g.imgMeta);
      out += `<span class="img-wrap align-${align}" data-index="${imageIndex++}"><span class="img-box">`
        + `<img src="${esc(assetUrl(g.imgUrl))}" alt="${esc(g.imgAlt)}" loading="lazy">`
        + '<button class="img-menu" type="button" title="Image options">⋮</button></span></span>';
    }
    else if (g.linkUrl !== undefined) out += `<a class="ext" href="${esc(safeUrl(g.linkUrl))}" target="_blank" rel="noopener">${inline(g.linkText)}</a>`;
    else if (g.tagb !== undefined) out += pageLink(g.tagb, true);
    else if (g.page !== undefined) out += pageLink(g.page);
    else if (g.bref !== undefined) out += `<span class="block-ref" data-ref="${esc(g.bref.toLowerCase())}">((${esc(g.bref)}))</span>`;
    else if (g.bold !== undefined) out += `<strong>${inline(g.bold)}</strong>`;
    else if (g.strike !== undefined) out += `<del>${inline(g.strike)}</del>`;
    else if (g.hl !== undefined) out += `<mark>${inline(g.hl)}</mark>`;
    else if (g.it1 !== undefined) out += `<em>${inline(g.it1)}</em>`;
    else if (g.it2 !== undefined) out += `<em>${inline(g.it2)}</em>`;
    else if (g.url !== undefined) out += `<a class="ext" href="${esc(g.url)}" target="_blank" rel="noopener">${esc(g.url)}</a>`;
    else if (g.tag !== undefined) out += pageLink(g.tag, true);
    last = re.lastIndex;
  }
  return out + esc(text.slice(last));
}

const MARKER = /^(TODO|DOING|DONE|LATER|NOW|CANCELED) /;

// Block properties Blockseq manages itself. They are stored in the block text
// the way Logseq writes them (so the Markdown mirror stays compatible), but
// hidden while viewing and editing.
export const HIDDEN_PROPS = ['logseq.order-list-type', 'background-color', 'heading'];
const ALWAYS_HIDDEN = new Set(['id', 'collapsed', ...HIDDEN_PROPS]);

// Splits managed properties out of block text: {content, props}.
export function splitProps(text) {
  const props = {};
  const keep = [];
  text.split('\n').forEach((line, i) => {
    const m = /^([\w.-]+):: *(.*)$/.exec(line);
    if (i > 0 && m && HIDDEN_PROPS.includes(m[1])) props[m[1]] = m[2].trim();
    else keep.push(line);
  });
  return { content: keep.join('\n'), props };
}

// Puts managed properties back after the first line, where Logseq expects them.
export function joinProps(content, props) {
  const entries = Object.entries(props || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!entries.length) return content;
  const lines = entries.map(([k, v]) => `${k}:: ${v}`);
  const [first, ...rest] = content.split('\n');
  // A block that starts with code or a table keeps them intact: props go last.
  if (first.startsWith('```') || /^\s*\|/.test(first)) return [content, ...lines].join('\n');
  return [first, ...lines, ...rest].join('\n');
}

// A ``` code fence: group 1 is the language, group 2 the code.
const FENCE_SRC = '^```([^\\n`]*)\\n([\\s\\S]*?)(?:\\n```[ \\t]*(?=\\n|(?![\\s\\S]))|(?![\\s\\S]))';

// Finds the code fences in a block's raw text, in the same order the renderer
// numbers them (data-fence). Positions are offsets into `text`.
export function findFences(text) {
  const offset = MARKER.exec(text)?.[0].length || 0;
  const body = text.slice(offset);
  const re = new RegExp(FENCE_SRC, 'gm');
  const out = [];
  let m;
  while ((m = re.exec(body))) {
    const start = offset + m.index;
    const langStart = start + 3;
    const codeStart = langStart + m[1].length + 1;
    out.push({
      start,
      end: start + m[0].length,
      lang: m[1].trim(),
      langStart,
      langEnd: langStart + m[1].length,
      code: m[2],
      codeStart,
      codeEnd: codeStart + m[2].length,
    });
  }
  return out;
}

// True when the block is nothing but one code fence.
export function isPureCode(text) {
  const f = findFences(text);
  return f.length === 1 && f[0].start === 0 && text.slice(f[0].end).trim() === '';
}

const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const isTableRule = (l) => /^\s*\|(\s*:?-{1,}:?\s*\|)+\s*$/.test(l);
const cells = (l) => l.trim().slice(1, -1).split('|').map((c) => c.trim());

function renderTable(rows) {
  let head = null;
  let aligns = [];
  let body = rows;
  if (rows.length >= 2 && isTableRule(rows[1])) {
    head = cells(rows[0]);
    aligns = cells(rows[1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
    body = rows.slice(2);
  }
  const td = (tag, text, i) => `<${tag}${aligns[i] ? ` style="text-align:${aligns[i]}"` : ''}>${inline(text)}</${tag}>`;
  let html = '<div class="table-wrap"><table>';
  if (head) html += `<thead><tr>${head.map((c, i) => td('th', c, i)).join('')}</tr></thead>`;
  html += `<tbody>${body.map((r) => `<tr>${cells(r).map((c, i) => td('td', c, i)).join('')}</tr>`).join('')}</tbody>`;
  return html + '</table></div>';
}

function renderLine(line, pre) {
  const prop = /^([\w.-]+):: ?(.*)$/.exec(line);
  if (prop) {
    if (ALWAYS_HIDDEN.has(prop[1])) return '';
    return `<div class="prop"><span class="prop-key">${esc(prop[1])}</span> ${inline(prop[2])}</div>`;
  }
  const h = /^(#{1,6}) (.*)$/.exec(line);
  if (h) return `<div class="h${h[1].length}">${pre}${inline(h[2])}</div>`;
  const q = /^> ?(.*)$/.exec(line);
  if (q) return `<blockquote>${pre}${inline(q[1])}</blockquote>`;
  return `<div>${pre}${inline(line) || (pre ? '' : '<br>')}</div>`;
}

function renderLines(text, prefix) {
  const lines = text.split('\n');
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const pre = i === 0 ? prefix : '';
    if (isTableRow(lines[i])) {
      let j = i;
      while (j < lines.length && isTableRow(lines[j])) j++;
      if (pre) out += `<div>${pre}</div>`;
      out += renderTable(lines.slice(i, j));
      i = j - 1;
      continue;
    }
    out += renderLine(lines[i], pre);
  }
  return out;
}

const TAG_TOKEN = /#\[\[([^\]\n]+)\]\]|#([^\s#,.!?;:()[\]"'`]+)/g;
const TRAILING_TAGS = /(^|\s)((?:#\[\[[^\]\n]+\]\]|#[^\s#,.!?;:()[\]"'`]+)(?:\s+(?:#\[\[[^\]\n]+\]\]|#[^\s#,.!?;:()[\]"'`]+))*)\s*$/;

// Tags at the end of a block's first line are shown on the right-hand side.
function pullTrailingTags(src) {
  const nl = src.indexOf('\n');
  const first = nl === -1 ? src : src.slice(0, nl);
  if (first.startsWith('```') || isTableRow(first)) return { src, tags: [] };
  const m = TRAILING_TAGS.exec(first);
  if (!m) return { src, tags: [] };
  const text = first.slice(0, m.index + m[1].length).trimEnd();
  if (!text.replace(/^#{1,6} /, '').trim()) return { src, tags: [] }; // block is only tags
  const tags = [...m[2].matchAll(TAG_TOKEN)].map((t) => t[1] ?? t[2]);
  return { src: text + (nl === -1 ? '' : src.slice(nl)), tags };
}

// Renders a block's full text. Code fences become <pre>, everything else is
// rendered line by line. opts.inlineTags keeps trailing tags in the text
// (used for block refs shown inside other text).
export function renderContent(src, opts = {}) {
  if (!src.trim()) return '<span class="empty"></span>';
  imageIndex = 0;
  let prefix = '';
  let cls = '';
  const marker = MARKER.exec(src);
  if (marker) {
    const done = marker[1] === 'DONE';
    const off = marker[1] === 'CANCELED';
    cls = done ? 'is-done' : off ? 'is-canceled' : '';
    prefix = `<input type="checkbox" class="todo" ${done ? 'checked' : ''}><span class="marker m-${marker[1].toLowerCase()}">${marker[1]}</span> `;
    src = src.slice(marker[0].length);
  }
  let tags = [];
  if (!opts.inlineTags) ({ src, tags } = pullTrailingTags(src));
  let html = '';
  const fence = new RegExp(FENCE_SRC, 'gm');
  let fenceIndex = 0;
  let last = 0;
  let m;
  while ((m = fence.exec(src))) {
    const before = src.slice(last, m.index).replace(/\n$/, '');
    if (before || (last === 0 && prefix)) html += renderLines(before, last === 0 ? prefix : '');
    const lang = m[1].trim();
    html += `<pre class="code" data-fence="${fenceIndex++}"${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(m[2])}</code></pre>`;
    last = fence.lastIndex;
    if (src[last] === '\n') last++;
  }
  if (last < src.length || last === 0) html += renderLines(src.slice(last), last === 0 ? prefix : '');
  const tagHtml = tags.length ? `<div class="block-tags">${tags.map((t) => pageLink(t, true)).join('')}</div>` : '';
  return `<div class="rendered ${cls}"><div class="body">${html}</div>${tagHtml}</div>`;
}

// Parses pasted Logseq-style Markdown ("- item" lines, tab or space indented)
// into a list of {id, content, collapsed, children}. Returns null if the text
// does not look like an outline.
export function parseOutline(text, makeId) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const first = lines.find((l) => l.trim());
  if (!first || !/^\s*-( |$)/.test(first)) return null;
  const width = (ws) => [...ws].reduce((n, c) => n + (c === '\t' ? 4 : 1), 0);
  const roots = [];
  const stack = []; // {indent, raw, node}
  let current = null;
  for (const line of lines) {
    const m = /^(\s*)-(?: (.*)|$)/.exec(line);
    if (m) {
      const indent = width(m[1]);
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const node = { id: makeId(), content: m[2] || '', collapsed: false, children: [] };
      (stack.length ? stack[stack.length - 1].node.children : roots).push(node);
      stack.push({ indent, raw: m[1].length, node });
      current = stack[stack.length - 1];
      continue;
    }
    if (!current) continue;
    // Continuation line: drop the block's indentation plus the "- " width.
    const strip = current.raw + 2;
    const lead = /^\s*/.exec(line)[0].length;
    const body = line.slice(Math.min(lead, strip));
    const prop = /^\s*(id|collapsed):: *(.*)$/.exec(body);
    if (prop) {
      if (prop[1] === 'id' && /^[0-9a-f-]{36}$/i.test(prop[2].trim())) current.node.id = prop[2].trim().toLowerCase();
      if (prop[1] === 'collapsed') current.node.collapsed = prop[2].trim() === 'true';
      continue;
    }
    current.node.content += '\n' + body;
  }
  const trim = (nodes) => nodes.forEach((n) => { n.content = n.content.replace(/\n+$/, ''); trim(n.children); });
  trim(roots);
  return roots;
}
