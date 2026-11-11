// Journal page names use Logseq's default format: "Nov 11th, 2026".

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function ordinal(d) {
  if (d % 100 >= 11 && d % 100 <= 13) return 'th';
  return { 1: 'st', 2: 'nd', 3: 'rd' }[d % 10] || 'th';
}

export function journalName(date) {
  const d = date.getDate();
  return `${MONTHS[date.getMonth()]} ${d}${ordinal(d)}, ${date.getFullYear()}`;
}

// yyyymmdd as a number, matching the server's journal_day.
export function journalDay(date) {
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

export function formatTime(ms) {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}
