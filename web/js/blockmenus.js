// The block, image, file and PDF menus (right-click and ⋮ buttons).

import { el } from './dom.js';
import { ALIGN, COLOR, COLORS, HEADING, noteActive, NUMBERED, toggleFirstLine } from './editor.js';
import { copyImage, downloadImage, imageAt, withAlign, withMeta, withoutFileLink, withoutImage } from './images.js';
import { keyFor, prettyKey } from './keys.js';
import { closeMenu, showMenu } from './menus.js';
import { openFilePane, openPdfPane } from './pdfview.js';
import { imageAlign, imageSize, pdfView } from './render.js';
import { stripStatus } from './tasks.js';
import { copyText, toast } from './ui.js';

class BlockMenusMethods {
  showImageMenu(node, index, e) {
    noteActive(this);
    const info = imageAt(node.content, index);
    if (!info) return;
    const align = imageAlign(info.meta);
    const alignItem = (a, label) => ({
      label: `${label}${align === a ? '  ✓' : ''}`,
      fn: () => this.changeText(node, withAlign(node.content, index, a)),
    });
    const size = imageSize(info.meta);
    const sizeItem = (s, label) => ({
      label: `${label}${size === s ? '  ✓' : ''}`,
      fn: () => this.changeText(node, withMeta(node.content, index, 'size', s || null)),
    });
    showMenu(e.clientX, e.clientY, [
      alignItem('left', 'Align left'),
      alignItem('center', 'Align center'),
      alignItem('right', 'Align right'),
      '-',
      sizeItem('', 'Fit to width'),
      sizeItem('original', 'Original size'),
      sizeItem('half', 'Half size'),
      sizeItem('quarter', 'Quarter size'),
      sizeItem('small', 'Very small'),
      '-',
      { label: 'Copy image', fn: () => copyImage(info.url) },
      { label: 'Open in new tab', fn: () => window.open(info.url, '_blank', 'noopener') },
      { label: 'Download', fn: () => downloadImage(info.url) },
      '-',
      { label: 'Delete image', danger: true, fn: () => this.changeText(node, withoutImage(node.content, index)) },
    ]);
  }

  showFileMenu(node, wrap, name, e) {
    noteActive(this);
    const url = wrap.dataset.src;
    const kind = wrap.dataset.kind;
    const index = Number(wrap.dataset.index);
    const remove = () => this.changeText(node, wrap.dataset.md === 'link'
      ? withoutFileLink(node.content, index) : withoutImage(node.content, index));
    showMenu(e.clientX, e.clientY, [
      ...(kind === 'other' ? [] : [{ label: 'Open in side pane', fn: () => openFilePane(url, name, kind) }]),
      { label: 'Open in new tab', fn: () => window.open(url, '_blank', 'noopener') },
      { label: 'Download', fn: () => downloadImage(url) },
      '-',
      { label: 'Remove from block', danger: true, fn: remove },
    ]);
  }

  showPdfMenu(node, index, e) {
    noteActive(this);
    const info = imageAt(node.content, index);
    if (!info) return;
    const name = info.alt || decodeURIComponent(info.url.split('?')[0].split('/').pop());
    const view = pdfView(info.meta);
    showMenu(e.clientX, e.clientY, [
      { label: `Show as link${view === 'link' ? '  ✓' : ''}`, fn: () => this.changeText(node, withMeta(node.content, index, 'view', null)) },
      { label: `Show full preview${view === 'preview' ? '  ✓' : ''}`, fn: () => this.changeText(node, withMeta(node.content, index, 'view', 'preview')) },
      '-',
      { label: 'Open in side pane', fn: () => openPdfPane(info.url, name) },
      { label: 'Open in new tab', fn: () => window.open(info.url, '_blank', 'noopener') },
      { label: 'Download', fn: () => downloadImage(info.url) },
      '-',
      { label: 'Remove from block', danger: true, fn: () => this.changeText(node, withoutImage(node.content, index)) },
    ]);
  }

  // A text change made from a menu: undoable, cursor kept if editing.
  changeText(node, value) {
    this.beginOp();
    this.applyValue(node, value);
  }

  showBlockMenu(node, e, opts = {}) {
    noteActive(this);
    const colors = el('div', 'menu-swatches');
    for (const c of COLORS) {
      const sw = el('button', `swatch sw-${c}`);
      sw.title = c;
      if (node.props[COLOR] === c) sw.classList.add('active');
      sw.addEventListener('click', () => { closeMenu(); this.setProp(node, COLOR, c); });
      colors.append(sw);
    }
    const none = el('button', 'swatch sw-none');
    none.title = 'No colour';
    none.addEventListener('click', () => { closeMenu(); this.setProp(node, COLOR, null); });
    colors.append(none);

    const heads = el('div', 'menu-headings');
    const current = /^(#{1,6}) /.exec(stripStatus(node.content))?.[1].length || 0;
    const headBtn = (label, title, level, active) => {
      const b = el('button', 'head-btn' + (active ? ' active' : ''), label);
      b.title = title;
      b.addEventListener('click', () => { closeMenu(); this.setHeadingStyle(node, level); });
      heads.append(b);
    };
    for (let i = 1; i <= 6; i++) headBtn(`H${i}`, `Heading ${i}`, i, current === i);
    headBtn('HA', 'Auto heading (size by depth)', 'auto', node.props[HEADING] === 'true');
    headBtn('H', 'Remove heading', 0, false);
    heads.lastChild.classList.add('no-head');

    // Text alignment: left is the default, so it clears the property.
    const aligns = el('div', 'menu-headings menu-align');
    const alignIcon = (lines) => `<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="${lines}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>`;
    const ALIGN_ICONS = {
      left: alignIcon('M3 5h14M3 10h9M3 15h12'),
      center: alignIcon('M3 5h14M5.5 10h9M4 15h12'),
      right: alignIcon('M3 5h14M8 10h9M5 15h12'),
    };
    const currentAlign = node.props[ALIGN] || 'left';
    for (const a of ['left', 'center', 'right']) {
      const b = el('button', 'head-btn' + (currentAlign === a ? ' active' : ''));
      b.innerHTML = ALIGN_ICONS[a];
      b.title = `Align ${a}`;
      b.setAttribute('aria-label', `Align ${a}`);
      b.addEventListener('click', () => { closeMenu(); this.setProp(node, ALIGN, a === 'left' ? null : a); });
      aligns.append(b);
    }

    const entries = [
      { element: colors },
      { element: heads },
      { element: aligns },
      '-',
      { label: 'Add timestamp', fn: () => this.addTimestamp(node) },
      { label: 'Strikethrough', shortcut: prettyKey(keyFor('strike')), fn: () => this.strikeBlock(node) },
      '-',
      { label: 'Copy block ref', fn: () => { copyText(`((${node.id}))`); toast('Block ref copied'); } },
      { label: 'Copy block URL', fn: () => { copyText(this.blockUrl(node)); toast('Block URL copied'); } },
      { label: 'Copy / Export as…', fn: () => this.exportBlock(node) },
      { label: 'Cut', fn: () => this.cut(node) },
      { label: 'Delete block', fn: () => this.removeNode(node), danger: true },
      '-',
      { label: node.props[NUMBERED] === 'number' ? 'Remove number list' : 'Toggle number list', fn: () => this.toggleNumbered(node) },
    ];
    if (node.children.length) {
      entries.push('-',
        { label: 'Expand all', shortcut: 'Ctrl ↓', fn: () => this.setCollapsedDeep(node, false) },
        { label: 'Collapse all', shortcut: 'Ctrl ↑', fn: () => this.setCollapsedDeep(node, true) });
    }
    showMenu(e.clientX, e.clientY, entries, opts);
  }

  // Strikes the block's first line through (or clears it): ~~text~~, with the
  // task status and trailing tags left outside the marks.
  strikeBlock(node) {
    this.changeText(node, toggleFirstLine(node.content, '~~'));
  }
}

// Adds the methods above to the editor class.
export function installBlockMenus(cls) {
  for (const name of Object.getOwnPropertyNames(BlockMenusMethods.prototype)) {
    if (name === 'constructor') continue;
    Object.defineProperty(cls.prototype, name, Object.getOwnPropertyDescriptor(BlockMenusMethods.prototype, name));
  }
}
