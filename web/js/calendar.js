// Month calendar in the sidebar. Clicking a day opens (and if needed creates)
// that day's journal page. Days that have journal entries get a dot.

import { api } from './api.js';
import { journalDay } from './dates.js';
import { getSetting } from './settings.js';

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export class Calendar {
  constructor(container, onPick) {
    this.container = container;
    this.onPick = onPick;
    const now = new Date();
    this.year = now.getFullYear();
    this.month = now.getMonth();
    this.selected = null; // yyyymmdd of the journal being viewed
    this.days = new Set(); // yyyymmdd of journals with content
    this.render();
    this.refresh();
  }

  // Reloads which days have journal entries.
  async refresh() {
    try {
      const side = await api.sidebar();
      document.dispatchEvent(new CustomEvent('blockseq:last-change', { detail: { at: side.newest } }));
      this.days = new Set(side.journal_days);
      this.render();
    } catch { /* offline: keep the old dots */ }
  }

  // Highlights the day being viewed and shows its month.
  select(day) {
    this.selected = day || null;
    if (day) {
      this.year = Math.floor(day / 10000);
      this.month = Math.floor(day / 100) % 100 - 1;
    }
    this.render();
  }

  goToday() {
    const now = new Date();
    this.year = now.getFullYear();
    this.month = now.getMonth();
    this.render();
  }

  shift(months) {
    const d = new Date(this.year, this.month + months, 1);
    this.year = d.getFullYear();
    this.month = d.getMonth();
    this.render();
  }

  render() {
    const today = journalDay(new Date());
    const first = new Date(this.year, this.month, 1);
    const label = first.toLocaleDateString([], { month: 'long', year: 'numeric' });

    const head = document.createElement('div');
    head.className = 'cal-head';
    const prev = button('cal-nav', '‹', 'Previous month', () => this.shift(-1));
    const title = button('cal-title', label, 'Go to this month', () => this.goToday());
    const next = button('cal-nav', '›', 'Next month', () => this.shift(1));
    head.append(prev, title, next);

    const grid = document.createElement('div');
    grid.className = 'cal-grid';
    // Settings → Appearance → First day of the week (0 = Sunday).
    const start = Number(getSetting('weekStart')) || 0;
    for (let i = 0; i < 7; i++) {
      const wd = (start + i) % 7;
      const c = document.createElement('div');
      c.className = 'cal-wd';
      c.textContent = WEEKDAYS[wd];
      c.title = DAY_NAMES[wd];
      grid.append(c);
    }
    // Always six weeks, so the calendar keeps the same height (and its header
    // stays put) from month to month. Days of the months before and after
    // fill the gaps, faded.
    for (let i = 0; i < 42; i++) {
      const date = new Date(this.year, this.month, 1 - ((first.getDay() - start + 7) % 7) + i);
      const day = journalDay(date);
      const cell = button('cal-day', '', date.toDateString(), () => this.onPick(date));
      // The number sits in a circle: filled for today, a ring for the day shown.
      const num = document.createElement('span');
      num.className = 'cal-num';
      num.textContent = String(date.getDate());
      cell.append(num);
      if (date.getMonth() !== this.month) cell.classList.add('other-month');
      if (day === today) cell.classList.add('today');
      if (day === this.selected) cell.classList.add('selected');
      if (this.days.has(day)) cell.classList.add('has-journal');
      grid.append(cell);
    }
    this.container.replaceChildren(head, grid);
  }
}

function button(cls, text, title, fn) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  b.title = title;
  b.addEventListener('click', fn);
  return b;
}
