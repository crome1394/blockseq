// Shows a PDF in the right-hand pane, using the browser's own PDF viewer.

import { openPane } from './pane.js';
import { downloadImage } from './images.js';

export function openPdfPane(url, name) {
  const frame = document.createElement('iframe');
  frame.className = 'pane-pdf';
  frame.src = url;
  frame.title = name;
  openPane({
    kind: 'pdf',
    key: url,
    title: name,
    body: frame,
    actions: [
      ['Open in new tab', () => window.open(url, '_blank', 'noopener'), 'Open in a new browser tab'],
      ['Download', () => downloadImage(url)],
    ],
  });
}

// Opens any uploaded file the best way for its kind: PDFs, text, video and
// audio in the side pane; other files download.
export function openFilePane(url, name, kind) {
  if (kind === 'pdf') return openPdfPane(url, name);
  if (kind === 'other') return downloadImage(url);
  if (kind === 'tab') return window.open(url, '_blank', 'noopener');
  let body;
  if (kind === 'video' || kind === 'audio') {
    body = document.createElement('div');
    body.className = 'pane-media';
    const media = document.createElement(kind);
    media.src = url;
    media.controls = true;
    media.autoplay = true;
    body.append(media);
  } else {
    body = document.createElement('iframe');
    body.className = 'pane-pdf pane-text';
    body.src = url;
    body.title = name;
  }
  openPane({
    kind: 'file',
    key: url,
    title: name,
    body,
    actions: [
      ['Open in new tab', () => window.open(url, '_blank', 'noopener'), 'Open in a new browser tab'],
      ['Download', () => downloadImage(url)],
    ],
  });
}
