// Applies the theme and sidebar state before first paint (no flash). A
// plain (blocking) script in <head>, kept in its own file because the
// Content-Security-Policy allows no inline scripts.
try {
  const s = JSON.parse(localStorage.getItem('blockseq.settings') || '{}');
  if (s.theme && s.theme !== 'auto') document.documentElement.dataset.theme = s.theme;
  if (s.sidebar === false) document.documentElement.classList.add('sidebar-hidden');
} catch { /* storage blocked */ }
