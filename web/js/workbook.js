// The workbook this browser is showing. Every API call and asset URL carries
// it as ?wb=<id>; "main" is the server's original data folder.

const KEY = 'blockseq.workbook';
let current = 'main';
try { current = localStorage.getItem(KEY) || 'main'; } catch { /* storage blocked */ }

export function workbook() {
  return current;
}

export function setWorkbook(id) {
  current = id || 'main';
  try { localStorage.setItem(KEY, current); } catch { /* not persisted */ }
}

// Adds ?wb= (or &wb=) to a same-origin URL.
export function withWb(url) {
  return `${url}${url.includes('?') ? '&' : '?'}wb=${encodeURIComponent(current)}`;
}
