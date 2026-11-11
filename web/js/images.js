// Images: upload, full-size preview, copy/download, and editing an image's
// Markdown (alignment, delete) inside a block's text.

import { clientId } from './api.js';
import { IMAGE_SRC, assetUrl } from './render.js';
import { toast } from './ui.js';
import { withWb } from './workbook.js';

// Files from a drop, paste or file picker (any type).
export function imageFiles(dataTransfer) {
  return [...(dataTransfer?.files || [])];
}

// Uploads one image or PDF; resolves to the Markdown that shows it.
// Both use Logseq's syntax: ![name](../assets/file).
export async function uploadImage(file) {
  const res = await fetch(withWb('/api/assets'), {
    method: 'POST',
    // Header values must be plain ASCII; the server cleans the name further.
    headers: { 'X-Client-Id': clientId, 'X-Filename': (file.name || 'image').replace(/[^\w.-]+/g, '_') },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  // Images, PDFs, video and audio are embedded (![…]); other files are links
  // labelled with their original name, like Logseq does.
  if (['image', 'pdf', 'video', 'audio'].includes(data.kind)) return `![${altFrom(file.name)}](${data.path})`;
  const label = (file.name || 'file').replace(/[[\]\n]/g, '').trim() || 'file';
  return `[${label}](${data.path})`;
}

function altFrom(name) {
  const base = (name || 'image').replace(/\.[^.]+$/, '').replace(/[[\]\n]/g, '').trim();
  return base || 'image';
}

// Opens a file picker for images; resolves to the chosen files.
export function pickImages(accept = 'image/*') {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = true;
    input.addEventListener('change', () => resolve(imageFiles({ files: input.files })));
    input.click();
  });
}

// ---- finding an image in block text ------------------------------------------

function nthImage(text, index) {
  const re = new RegExp(IMAGE_SRC, 'g');
  let m;
  let i = 0;
  while ((m = re.exec(text))) {
    if (i++ === index) return m;
  }
  return null;
}

export function imageAt(text, index) {
  const m = nthImage(text, index);
  return m ? { alt: m[1], src: m[2], url: assetUrl(m[2]), meta: m[3] || '' } : null;
}

// Returns the text with one {:key "value"} setting of the image (or PDF)
// changed; `value` null removes it.
export function withMeta(text, index, key, value) {
  const m = nthImage(text, index);
  if (!m) return text;
  let meta = (m[3] || '').replace(new RegExp(`,?\\s*:${key}\\s+"?[\\w-]+"?`), '').trim().replace(/^,\s*/, '');
  if (value) meta = meta ? `${meta}, :${key} "${value}"` : `:${key} "${value}"`;
  const md = `![${m[1]}](${m[2]})${meta ? `{${meta}}` : ''}`;
  return text.slice(0, m.index) + md + text.slice(m.index + m[0].length);
}

// Returns the text with the image's alignment changed ('left' = default).
export function withAlign(text, index, align) {
  return withMeta(text, index, 'align', align === 'left' ? null : align);
}

const ASSET_LINK = '(?<!!)\\[([^\\]\\n]+)\\]\\((\\.\\./assets/[^)\\s]+)\\)';

// Removes the index-th [name](../assets/…) file link.
export function withoutFileLink(text, index) {
  const re = new RegExp(ASSET_LINK, 'g');
  let m;
  let i = 0;
  while ((m = re.exec(text))) {
    if (i++ === index) {
      const before = text.slice(0, m.index).replace(/[ \t]+$/, '');
      const after = text.slice(m.index + m[0].length).replace(/^[ \t]+/, '');
      return (before && after && !before.endsWith('\n') && !after.startsWith('\n') ? `${before} ${after}` : before + after).trim();
    }
  }
  return text;
}

export function withoutImage(text, index) {
  const m = nthImage(text, index);
  if (!m) return text;
  const before = text.slice(0, m.index).replace(/[ \t]+$/, '');
  const after = text.slice(m.index + m[0].length).replace(/^[ \t]+/, '');
  return (before && after && !before.endsWith('\n') && !after.startsWith('\n') ? `${before} ${after}` : before + after).trim();
}

// ---- actions -------------------------------------------------------------------

// Full-size preview. `images` is a list of {src, alt}; with more than one
// (images on the same row) ‹ › arrows and ←/→ step through them.
export function openLightbox(images, start = 0) {
  document.querySelector('.lightbox')?.remove();
  let index = start;
  const box = document.createElement('div');
  box.className = 'lightbox';
  const img = document.createElement('img');
  box.append(img);
  const counter = document.createElement('div');
  counter.className = 'lb-count';
  const many = images.length > 1;
  const show = (i) => {
    index = (i + images.length) % images.length;
    img.src = images[index].src;
    img.alt = images[index].alt || '';
    counter.textContent = `${index + 1} / ${images.length}`;
  };
  const arrow = (cls, text, dir, label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `lb-arrow ${cls}`;
    b.textContent = text;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', (e) => { e.stopPropagation(); show(index + dir); });
    return b;
  };
  if (many) box.classList.add('many');
  if (many) box.append(arrow('lb-prev', '‹', -1, 'Previous image (←)'), arrow('lb-next', '›', 1, 'Next image (→)'), counter);
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); }
    else if (many && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.stopPropagation();
      e.preventDefault();
      show(index + (e.key === 'ArrowLeft' ? -1 : 1));
    }
  };
  box.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
  show(start);
  document.body.append(box);
}

export async function copyImage(url) {
  if (!window.isSecureContext || !window.ClipboardItem || !navigator.clipboard?.write) {
    toast('Copying images needs HTTPS. Open Blockseq through your Caddy address.');
    return;
  }
  try {
    // Browsers reliably accept PNG on the clipboard, so convert other types.
    const png = fetch(url).then((r) => r.blob()).then((b) => (b.type === 'image/png' ? b : toPng(b)));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    toast('Image copied');
  } catch {
    toast('Could not copy the image');
  }
}

async function toPng(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

export function downloadImage(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = decodeURIComponent(url.split('?')[0].split('/').pop() || 'file');
  document.body.append(a);
  a.click();
  a.remove();
}
