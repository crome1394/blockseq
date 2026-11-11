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
