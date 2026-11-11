// Images: upload, full-size preview, copy/download, and editing an image's
// Markdown (alignment, delete) inside a block's text.

import { clientId } from './api.js';
import { IMAGE_SRC, assetUrl } from './render.js';
import { toast } from './ui.js';

export function imageFiles(dataTransfer) {
  return [...(dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
}

// Uploads one image; resolves to the Markdown that shows it.
export async function uploadImage(file) {
  const res = await fetch('/api/assets', {
    method: 'POST',
    // Header values must be plain ASCII; the server cleans the name further.
    headers: { 'X-Client-Id': clientId, 'X-Filename': (file.name || 'image').replace(/[^\w.-]+/g, '_') },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return `![${altFrom(file.name)}](${data.path})`;
}

function altFrom(name) {
  const base = (name || 'image').replace(/\.[^.]+$/, '').replace(/[[\]\n]/g, '').trim();
  return base || 'image';
}

// Opens a file picker for images; resolves to the chosen files.
export function pickImages() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
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

// Returns the text with the image's alignment changed ('left' = default).
export function withAlign(text, index, align) {
  const m = nthImage(text, index);
  if (!m) return text;
  let meta = (m[3] || '').replace(/,?\s*:align\s+"?\w+"?/, '').trim().replace(/^,\s*/, '');
  if (align !== 'left') meta = meta ? `${meta}, :align "${align}"` : `:align "${align}"`;
  const md = `![${m[1]}](${m[2]})${meta ? `{${meta}}` : ''}`;
  return text.slice(0, m.index) + md + text.slice(m.index + m[0].length);
}

export function withoutImage(text, index) {
  const m = nthImage(text, index);
  if (!m) return text;
  const before = text.slice(0, m.index).replace(/[ \t]+$/, '');
  const after = text.slice(m.index + m[0].length).replace(/^[ \t]+/, '');
  return (before && after && !before.endsWith('\n') && !after.startsWith('\n') ? `${before} ${after}` : before + after).trim();
}

// ---- actions -------------------------------------------------------------------

export function openLightbox(url, alt = '') {
  document.querySelector('.lightbox')?.remove();
  const box = document.createElement('div');
  box.className = 'lightbox';
  const img = document.createElement('img');
  img.src = url;
  img.alt = alt;
  box.append(img);
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  box.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
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
  a.download = decodeURIComponent(url.split('/').pop() || 'image');
  document.body.append(a);
  a.click();
  a.remove();
}
