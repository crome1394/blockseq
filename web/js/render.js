// Turns block text (Logseq-flavoured Markdown) into HTML for display.

import { texToMathML } from './math.js';
import { getSetting } from './settings.js';
import { withWb } from './workbook.js';
import { statusOf, badgeHtml } from './tasks.js';

export function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function safeUrl(url) {
  return /^(https?:|mailto:|\/|#|\.)/i.test(url) ? url : '#';
}

// Images and PDFs are stored Logseq-style as ../assets/<name>; the server
// serves them at /assets/<name>?wb=<workbook>.
export function assetUrl(url) {
  return url.startsWith('../assets/') ? withWb('/assets/' + url.slice('../assets/'.length)) : safeUrl(url);
}

// target="_blank" when Settings > Open links in a new tab is on.
function linkTarget() {
  return getSetting('linksNewTab') ? ' target="_blank" rel="noopener"' : ' rel="noopener"';
}

export function imageSize(meta) {
  return /:size\s+"?(original|half|quarter|small)"?/.exec(meta || '')?.[1] || '';
}

export function pdfView(meta) {
  return /:view\s+"?preview"?/.test(meta || '') ? 'preview' : 'link';
}

const COPY_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
export { COPY_ICON, CHECK_ICON };

const FILE_ICON = '<svg class="file-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';

// File kinds by extension (matches the server's assets::kind_of).
const KINDS = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'],
  pdf: ['pdf'],
  video: ['mp4', 'm4v', 'webm', 'mkv', 'mov', 'ogv'],
  audio: ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac'],
  text: ['txt', 'md', 'markdown', 'csv', 'tsv', 'log', 'json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'sh', 'py', 'rs', 'go', 'c', 'h', 'cpp', 'java', 'sql', 'env'],
};
export function fileExt(url) {
  return (/\.([a-z0-9]+)$/i.exec(url.split(/[?#]/)[0])?.[1] || '').toLowerCase();
}
export function fileKind(url) {
  const ext = fileExt(url);
  return Object.keys(KINDS).find((k) => KINDS[k].includes(ext)) || 'other';
}
const isAsset = (url) => url.startsWith('../assets/');

// A downloadable / openable file. `md` says how the block text holds it:
// "image" for ![name](…) (counted with images), "link" for [name](…).
function fileChip(url, label, index, md) {
  const kind = fileKind(url);
  const ext = fileExt(url).toUpperCase() || 'FILE';
  return `<span class="file-wrap" data-md="${md}" data-index="${index}" data-src="${esc(url)}" data-kind="${kind}">`
    + `<button type="button" class="file-open" title="${kind === 'other' ? 'Download' : 'Open'}">${FILE_ICON}<span class="file-name">${esc(label)}</span><span class="file-ext">${esc(ext)}</span></button>`
    + '<button type="button" class="file-menu" title="File options">⋮</button></span>';
}

function mediaHtml(url, alt, meta, index) {
  const kind = fileKind(url);
  const label = alt || decodeURIComponent(url.split('?')[0].split('/').pop());
  if (kind === 'video' || kind === 'audio') {
    const tag = kind === 'video'
      ? `<video src="${esc(url)}" controls preload="metadata" playsinline></video>`
      : `<audio src="${esc(url)}" controls preload="metadata"></audio>`;
    return `<span class="media-wrap ${kind}-wrap" data-md="image" data-index="${index}" data-src="${esc(url)}" data-kind="${kind}" title="${esc(label)}">`
      + `${tag}<button type="button" class="file-menu" title="${kind === 'video' ? 'Video' : 'Audio'} options">⋮</button></span>`;
  }
  return fileChip(url, label, index, 'image');
}

// {{video URL}}: YouTube / Vimeo players, or a plain <video> for a file URL.
export function youtubeId(url) {
  const m = /^(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/|v\/)|youtu\.be\/)([\w-]{11})/i.exec(url)
    || /^([\w-]{11})$/.exec(url);
  return m ? m[1] : null;
}
export function vimeoId(url) {
  return /^(?:https?:\/\/)?(?:www\.|player\.)?vimeo\.com\/(?:video\/)?(\d+)/i.exec(url)?.[1] || null;
}
export function isVideoUrl(url) {
  return !!(youtubeId(url) && /[/.]/.test(url)) || !!vimeoId(url);
}

function embedHtml(url) {
  const yt = youtubeId(url);
  const frame = (src, title) => `<span class="embed-wrap"><iframe src="${esc(src)}" title="${title}" loading="lazy" `
    + 'allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" '
    + 'referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></span>';
  if (yt) {
    const t = /[?&#](?:t|start)=(\d+)/.exec(url)?.[1];
    return frame(`https://www.youtube-nocookie.com/embed/${yt}${t ? `?start=${t}` : ''}`, 'YouTube video');
  }
  const vm = vimeoId(url);
  if (vm) return frame(`https://player.vimeo.com/video/${vm}`, 'Vimeo video');
  if (/^https?:\/\//i.test(url) && fileKind(url) === 'video') {
    return `<span class="embed-wrap embed-file"><video src="${esc(url)}" controls preload="metadata"></video></span>`;
  }
  return `<a class="ext" href="${esc(safeUrl(url))}"${linkTarget()}>${esc(url)}</a>`;
}

function pdfHtml(url, alt, meta, index) {
  const name = esc(alt || decodeURIComponent(url.split('?')[0].split('/').pop()));
  const open = `<button type="button" class="pdf-open" title="Open in side pane">${FILE_ICON}<span>${name}</span></button>`
    + '<button type="button" class="pdf-menu" title="PDF options">⋮</button>';
  if (pdfView(meta) === 'preview') {
    return `<span class="pdf-wrap pdf-preview" data-index="${index}" data-src="${esc(url)}"><span class="pdf-head">${open}</span>`
      + `<iframe class="pdf-frame" src="${esc(url)}#view=FitH" loading="lazy" title="${name}"></iframe></span>`;
  }
  return `<span class="pdf-wrap" data-index="${index}" data-src="${esc(url)}">${open}</span>`;
}

// ![alt](url){:align "center"} — the {...} part is Logseq's image metadata.
export const IMAGE_SRC = '!\\[([^\\]\\n]*)\\]\\(([^)\\s]+)\\)(?:\\{([^}\\n]*)\\})?';

export function imageAlign(meta) {
  return /:align\s+"?(center|right|left)"?/.exec(meta || '')?.[1] || 'left';
}

// Counts images while rendering one block, so each image knows its position
// (the image menu uses it to find the image in the block text).
let imageIndex = 0;
let linkIndex = 0; // [name](../assets/…) file links, counted separately

const INLINE = [
  '``(?<code2>[^\\n]+?)``',
  '`(?<code>[^`\\n]+)`',
  // LaTeX maths: $$…$$ and \[…\] (display), \(…\) and $…$ (inline). A lone
  // $ needs text right inside it and no digit after it, so "$5 and $10" stays text.
  '\\$\\$(?<mathD>[^$\\n]+?)\\$\\$',
  '\\\\\\[(?<mathD2>.+?)\\\\\\]',
  '\\\\\\((?<mathI>.+?)\\\\\\)',
  '(?<![\\\\\\w$])\\$(?<mathI2>[^\\s$](?:[^$\\n]*?[^\\s$\\\\])?)\\$(?![\\w$])',
  '\\{\\{(?:video|youtube|vimeo)\\s+(?<embed>[^}\\s]+)\\s*\\}\\}',
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
  '(?<![^\\s(])#(?<tag>[^\\s#,.!?;:()\\[\\]"\'`+][^\\s#,.!?;:()\\[\\]"\'`]*)',
].join('|');

// Where the maths is in a block's raw text, in the order it is drawn:
// [{start, end, tex, display, delim: 'dollar' | 'tex'}]. Skips code; looks
// inside bold, italics, highlights and link text, like inline() does.
export function mathSpans(src) {
  const out = [];
  const fences = [];
  let m;
  const fence = new RegExp(FENCE_SRC, 'gm');
  while ((m = fence.exec(src))) fences.push([m.index, m.index + m[0].length]);
  const inFence = (i) => fences.some(([a, b]) => i >= a && i < b);
  const delim = (s) => (s.startsWith('\\') ? 'tex' : 'dollar');
  const multi = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g;
  while ((m = multi.exec(src))) {
    if (m[0].includes('\n') && !inFence(m.index)) {
      out.push({ start: m.index, end: m.index + m[0].length, tex: m[1] ?? m[2], display: true, delim: delim(m[0]) });
    }
  }
  const covered = (i) => inFence(i) || out.some((x) => i >= x.start && i < x.end);
  const scan = (text, offset) => {
    const re = new RegExp(INLINE, 'g');
    let k;
    while ((k = re.exec(text))) {
      const at = offset + k.index;
      if (covered(at)) continue;
      const g = k.groups;
      const tex = g.mathD ?? g.mathD2 ?? g.mathI ?? g.mathI2;
      if (tex !== undefined) {
        out.push({ start: at, end: at + k[0].length, tex, display: g.mathD !== undefined || g.mathD2 !== undefined, delim: delim(k[0]) });
        continue;
      }
      const inner = g.bold ?? g.strike ?? g.hl ?? g.it1 ?? g.it2 ?? g.linkText;
      if (inner) scan(inner, at + k[0].indexOf(inner));
    }
  };
  scan(src, 0);
  return out.sort((a, b) => a.start - b.start);
}

// Hues that stay distinct from each other in light and dark themes.
const TAG_HUES = [355, 22, 42, 95, 145, 172, 195, 215, 240, 265, 290, 322];

// A stable hue for a tag name, so each tag keeps its own colour everywhere.
export function tagHue(name) {
  let h = 2166136261;
  for (const c of name.toLowerCase()) h = Math.imul(h ^ c.codePointAt(0), 16777619);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; // mix the bits
  return TAG_HUES[(h >>> 0) % TAG_HUES.length];
}

export function pageLink(name, tag = false) {
  const href = `#/page/${encodeURIComponent(name)}`;
  if (tag) return `<a class="page-ref tag" style="--tag-h:${tagHue(name)}" data-page="${esc(name)}" href="${href}">#${esc(name)}</a>`;
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
    if (g.code2 !== undefined) {
      // ``text`` is code with a copy button. Like Markdown, one space just
      // inside the backticks is dropped (so `` `x` `` can hold backticks).
      const code = g.code2.replace(/^ (.*) $/, '$1');
      out += `<span class="code-copyable"><code>${esc(code)}</code><button type="button" class="inline-copy" data-copy="${esc(code)}" title="Copy" aria-label="Copy">${COPY_ICON}</button></span>`;
    }
    else if (g.code !== undefined) out += `<code>${esc(g.code)}</code>`;
    else if (g.mathD !== undefined || g.mathD2 !== undefined) out += texToMathML(g.mathD ?? g.mathD2, true);
    else if (g.mathI !== undefined || g.mathI2 !== undefined) out += texToMathML(g.mathI ?? g.mathI2, false);
    else if (g.embed !== undefined) out += embedHtml(g.embed);
    else if (g.imgUrl !== undefined && /\.pdf$/i.test(g.imgUrl.split('?')[0])) {
      out += pdfHtml(assetUrl(g.imgUrl), g.imgAlt, g.imgMeta, imageIndex++);
    }
    else if (g.imgUrl !== undefined && fileKind(g.imgUrl) !== 'image' && isAsset(g.imgUrl)) {
      out += mediaHtml(assetUrl(g.imgUrl), g.imgAlt, g.imgMeta, imageIndex++);
    }
    else if (g.imgUrl !== undefined) {
      const align = imageAlign(g.imgMeta);
      const size = imageSize(g.imgMeta);
      out += `<span class="img-wrap align-${align}" data-index="${imageIndex++}"><span class="img-box">`
        + `<img src="${esc(assetUrl(g.imgUrl))}" alt="${esc(g.imgAlt)}" loading="lazy"${size ? ` data-size="${size}"` : ''}>`
        + '<button class="img-menu" type="button" title="Image options">⋮</button></span></span>';
    }
    else if (g.linkUrl !== undefined && isAsset(g.linkUrl)) out += fileChip(assetUrl(g.linkUrl), g.linkText, linkIndex++, 'link');
    else if (g.linkUrl !== undefined) out += `<a class="ext" href="${esc(safeUrl(g.linkUrl))}"${linkTarget()}>${inline(g.linkText)}</a>`;
    else if (g.tagb !== undefined) out += pageLink(g.tagb, true);
    else if (g.page !== undefined) out += pageLink(g.page);
    else if (g.bref !== undefined) out += `<span class="block-ref" data-ref="${esc(g.bref.toLowerCase())}">((${esc(g.bref)}))</span>`;
    else if (g.bold !== undefined) out += `<strong>${inline(g.bold)}</strong>`;
    else if (g.strike !== undefined) out += `<del>${inline(g.strike)}</del>`;
    else if (g.hl !== undefined) out += `<mark>${inline(g.hl)}</mark>`;
    else if (g.it1 !== undefined) out += `<em>${inline(g.it1)}</em>`;
    else if (g.it2 !== undefined) out += `<em>${inline(g.it2)}</em>`;
    else if (g.url !== undefined) out += `<a class="ext" href="${esc(g.url)}"${linkTarget()}>${esc(g.url)}</a>`;
    else if (g.tag !== undefined) out += pageLink(g.tag, true);
    last = re.lastIndex;
  }
  return out + esc(text.slice(last));
}

// Block properties Blockseq manages itself. They are stored in the block text
// the way Logseq writes them (so the Markdown mirror stays compatible), but
// hidden while viewing and editing.
export const HIDDEN_PROPS = ['logseq.order-list-type', 'background-color', 'heading', 'encrypted'];
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
  const st = statusOf(text);
  const offset = st ? st.word.length + (text[st.word.length] === ' ' ? 1 : 0) : 0;
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
  // Spaces or tabs at the start of a line indent it, as in the editor. The
  // indent keeps its exact width, and wrapped text stays lined up with it.
  const ws = /^[ \t]+/.exec(line)?.[0];
  if (ws && line.trim()) {
    return `<div class="indent-line"><span class="indent">${ws}</span><div class="indent-body">${renderLine(line.slice(ws.length), pre)}</div></div>`;
  }
  const prop = /^([\w.-]+):: ?(.*)$/.exec(line);
  if (prop) {
    if (ALWAYS_HIDDEN.has(prop[1])) return '';
    return `<div class="prop"><span class="prop-key">${esc(prop[1])}</span> ${inline(prop[2])}</div>`;
  }
  const h = /^(#{1,6}) (.*)$/.exec(line);
  if (h) return `<div class="h${h[1].length}">${pre}${inline(h[2])}</div>`;
  // Two or more images / PDFs alone on a line sit side by side, shrinking
  // together to fit the width.
  const media = line.match(new RegExp(IMAGE_SRC, 'g'));
  if (media && media.length > 1 && !line.replace(new RegExp(IMAGE_SRC, 'g'), '').trim()) {
    return `${pre ? `<div>${pre}</div>` : ''}<div class="media-row">${inline(line)}</div>`;
  }
  const q = /^> ?(.*)$/.exec(line);
  if (q) return `<blockquote class="md-quote">${pre}${inline(q[1])}</blockquote>`;
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

// Admonitions, written the way Logseq does: #+BEGIN_TIP … #+END_TIP.
const ADMON_SRC = '^#\\+BEGIN_(NOTE|TIP|IMPORTANT|CAUTION|WARNING|PINNED|QUOTE)[^\\n]*\\n?([\\s\\S]*?)\\n?^#\\+END_\\1[ \\t]*$';
export const ADMON_KINDS = ['tip', 'note', 'important', 'caution', 'warning', 'pinned'];
const svg = (d) => `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ADMON_ICONS = {
  tip: svg('M9 18h6M10 21h4M12 3a6 6 0 0 0-3.8 10.6c.6.6.8 1.3.8 2.4h6c0-1.1.2-1.8.8-2.4A6 6 0 0 0 12 3zM12 7v0'),
  note: svg('M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9 8h6M9 12h6M9 16h4'),
  pinned: svg('M12 16v5M8.5 3h7l-1 5.5L18 12v1.5H6V12l3.5-3.5z'),
  important: svg('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5v5.5M12 16.5v.01'),
  caution: svg('M12 3c.8 3.2 5 5.4 5 10.2A5 5 0 0 1 7 13.2c0-2.3 1.2-3.9 2.4-5 .3 1.9 1.3 3 2.4 3.2-.4-3.1.2-5.9.2-8.4z'),
  warning: svg('M12 3.5 22 20.5H2zM12 10v5M12 17.8v.01'),
};

function renderAdmonition(kind, inner) {
  kind = kind.toLowerCase();
  const body = inner.trim() ? renderLines(inner, '') : '<div><br></div>';
  if (kind === 'quote') return `<blockquote class="md-quote">${body}</blockquote>`;
  return `<div class="admonition adm-${kind}"><span class="adm-icon" title="${kind}">${ADMON_ICONS[kind]}</span><div class="adm-body">${body}</div></div>`;
}

// Display maths spanning several lines ($$ or \[ on one line, the closing
// one later). One-line maths is handled by inline().
function renderMathLines(text, prefix) {
  const re = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g;
  let out = '';
  let last = 0;
  let first = true;
  let m;
  while ((m = re.exec(text))) {
    if (!m[0].includes('\n')) continue;
    const before = text.slice(last, m.index).replace(/\n$/, '');
    if (before || (first && prefix)) out += renderLines(before, first ? prefix : '');
    first = false;
    out += `<div class="math-display">${texToMathML(m[1] ?? m[2], true)}</div>`;
    last = re.lastIndex;
    if (text[last] === '\n') last++;
  }
  if (last < text.length || first) out += renderLines(text.slice(last), first ? prefix : '');
  return out;
}

// Text between code fences: admonitions, then ordinary lines.
function renderBody(text, prefix) {
  const re = new RegExp(ADMON_SRC, 'gim');
  let out = '';
  let last = 0;
  let first = true;
  let m;
  while ((m = re.exec(text))) {
    const before = text.slice(last, m.index).replace(/\n$/, '');
    if (before || (first && prefix)) out += renderMathLines(before, first ? prefix : '');
    first = false;
    out += renderAdmonition(m[1], m[2]);
    last = re.lastIndex;
    if (text[last] === '\n') last++;
  }
  if (last < text.length || first) out += renderMathLines(text.slice(last), first ? prefix : '');
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
  linkIndex = 0;
  let prefix = '';
  let cls = '';
  const st = statusOf(src);
  if (st) {
    cls = st.done ? 'is-done' : 'is-task';
    prefix = `${badgeHtml(st)} `;
    src = src.slice(st.word.length).replace(/^ /, '');
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
    if (before || (last === 0 && prefix)) html += renderBody(before, last === 0 ? prefix : '');
    const lang = m[1].trim();
    html += `<pre class="code" data-fence="${fenceIndex++}"${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(m[2])}</code></pre>`;
    last = fence.lastIndex;
    if (src[last] === '\n') last++;
  }
  if (last < src.length || last === 0) html += renderBody(src.slice(last), last === 0 ? prefix : '');
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
