// Settings → Backup: download the current workbook as a zip, restore a zip
// as a new workbook, and re-encrypt restored #Encrypted blocks whose backup
// used a different password. See src/backup.rs for what a backup holds.

import { el } from './dom.js';
import { api, explain } from './api.js';
import * as sec from './crypto.js';
import { unlockDialog } from './secure-ui.js';
import { openModal, closeModal, toast } from './ui.js';
import { workbook, withWb } from './workbook.js';

function button(label, cls = '') {
  const b = el('button', cls, label);
  b.type = 'button';
  return b;
}

const workbookLabel = () => (workbook() === 'main' ? 'Main' : workbook());

export function downloadBackup() {
  const a = document.createElement('a');
  a.href = withWb('/api/export');
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
  toast(`Preparing the backup of ${workbookLabel()}… the download starts when it is ready`);
}

// "blockseq-Home-Lab-2026-11-11.zip" → "Home Lab"; "My graph.zip" → "My graph".
function nameFromFile(file) {
  let n = file.name.replace(/\.zip$/i, '').replace(/^blockseq-/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  n = n.replace(/-/g, ' ').replace(/[^\p{L}\p{N} _.]/gu, '').replace(/^[ .]+|[ .]+$/g, '').slice(0, 64);
  if (!n) n = 'Restored';
  if (n.toLowerCase() === 'main') n = 'Main restored';
  return n;
}

// Uploads with progress (fetch can't report upload progress).
function upload(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { data = { error: xhr.responseText }; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(explain(data, `HTTP ${xhr.status}`)));
    };
    xhr.onerror = () => reject(new Error('The upload failed (connection lost?)'));
    xhr.send(file);
  });
}

// Picks a zip, asks for the new workbook's name, uploads and opens it.
export function importDialog(file) {
  if (!file) {
    const input = el('input');
    input.type = 'file';
    input.accept = '.zip,application/zip';
    input.addEventListener('change', () => input.files[0] && importDialog(input.files[0]));
    input.click();
    return;
  }
  const body = el('div', 'dialog-form');
  body.append(el('p', 'small', `Restore ${file.name} (${(file.size / 1048576).toFixed(1)} MB).`));
  const choice = (value, label, checked) => {
    const row = el('label', 'check-row');
    const radio = el('input');
    radio.type = 'radio';
    radio.name = 'restore-target';
    radio.value = value;
    radio.checked = checked;
    row.append(radio, el('span', '', label));
    return row;
  };
  const asNew = choice('new', 'As a new workbook (nothing that exists now is changed)', true);
  const asMain = choice('main', 'Into Main, in place of what Main holds now', false);
  const field = el('label', 'field');
  field.append(el('span', '', 'Workbook name'));
  const input = el('input');
  input.value = nameFromFile(file);
  input.maxLength = 64;
  field.append(input);
  // Into Main: what happens to the current Main.
  const mainBox = el('div', 'restore-main');
  const keepRow = el('label', 'check-row');
  const keepCheck = el('input');
  keepCheck.type = 'checkbox';
  keepRow.append(keepCheck, el('span', '', 'Also keep the current Main as a workbook named'));
  const keepName = el('input');
  keepName.value = `Main before restore ${new Date().toISOString().slice(0, 10)}`;
  keepName.maxLength = 64;
  keepName.disabled = true;
  keepCheck.addEventListener('change', () => { keepName.disabled = !keepCheck.checked; if (keepCheck.checked) keepName.select(); });
  const keepField = el('label', 'field');
  keepField.append(keepName);
  mainBox.append(
    el('p', 'muted small', 'If Main holds anything, a backup zip of it is saved on the server first (listed under Settings → Backup). Then its files move to the trash, or to the workbook named here. Nothing is deleted.'),
    keepRow,
    keepField,
  );
  // .field sets display, which would override the hidden attribute.
  const show = (node, on) => { node.style.display = on ? '' : 'none'; };
  show(mainBox, false);
  const err = el('p', 'error small');
  body.append(asNew, asMain, field, mainBox, el('p', 'muted small', 'A Blockseq backup or a zipped Logseq graph (with pages/ and journals/) both work.'), err);
  const intoMain = () => asMain.querySelector('input').checked;
  for (const r of [asNew, asMain]) {
    r.querySelector('input').addEventListener('change', () => {
      show(field, !intoMain());
      show(mainBox, intoMain());
    });
  }
  const box = openModal('Import backup', body, [['Cancel'], ['Import', () => false, 'primary']]);
  box.classList.add('no-overlay-close');
  const go = box.querySelector('.modal-actions .primary');
  const run = async () => {
    const main = intoMain();
    const name = input.value.trim();
    const keep = keepCheck.checked ? keepName.value.trim() : '';
    if (main ? keepCheck.checked && !keep : !name) return;
    if (main && !confirm(`Replace what is in Main with ${file.name}?${keep ? ` The current Main is kept as “${keep}”.` : ' The current Main is saved as a zip and moved to the trash.'}`)) return;
    err.textContent = '';
    go.disabled = true;
    const url = main
      ? `/api/import?into=main${keep ? `&keep=${encodeURIComponent(keep)}` : ''}`
      : `/api/import?name=${encodeURIComponent(name)}`;
    try {
      const data = await upload(url, file, (f) => {
        go.textContent = f < 1 ? `Uploading ${Math.round(f * 100)}%` : 'Unpacking…';
      });
      closeModal();
      afterImport(data);
    } catch (e) {
      err.textContent = e.message;
      go.textContent = 'Import';
      go.disabled = false;
    }
  };
  go.addEventListener('click', run);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  input.select();
}

function afterImport({ workbook: wb, report, previous }) {
  const what = report.kind === 'logseq' ? 'Logseq graph' : 'backup';
  document.dispatchEvent(new CustomEvent('blockseq:open-workbook', { detail: { id: wb.id } }));
  if (previous) {
    // Into Main: say where the previous Main went.
    const parts = [];
    if (previous.zip) parts.push(`saved as ${previous.zip} (Settings → Backup)`);
    parts.push(previous.kept ? `kept as the workbook “${previous.moved_to.split('/').pop()}”` : 'moved to the trash');
    toast(`Restored the ${what} into Main. The previous Main was ${parts.join(' and ')}.`, 10000);
    if (report.key === 'different') setTimeout(() => rekeyDialog(true), 600);
    return;
  }
  if (report.key === 'adopted') {
    toast(`Restored the ${what} as ${wb.name}. This server now uses the backup's encryption password.`);
  } else if (report.key === 'different') {
    // Let the workbook switch finish first.
    setTimeout(() => rekeyDialog(true), 600);
  } else {
    toast(`Restored the ${what} as ${wb.name} (${report.files} files)`);
  }
}

// Re-encrypts the current workbook's blocks from the backup's key.
export async function rekeyDialog(justImported = false) {
  if (!sec.available()) {
    openModal('Encrypted blocks need HTTPS', el('p', '', 'Open Blockseq at your https:// address to re-encrypt these blocks.'));
    return;
  }
  const cfg = (await api.importedKey()).encryption;
  if (!cfg) return toast('Every encrypted block here already uses your current password');
  if (!sec.isUnlocked()) {
    document.addEventListener('blockseq:unlocked', () => setTimeout(() => rekeyDialog(justImported), 100), { once: true });
    toast('Unlock with your current password first');
    return unlockDialog();
  }
  const body = el('div', 'dialog-form');
  body.append(el('p', 'small', `${justImported ? 'The backup was made with a different encryption password. ' : ''}Its #Encrypted blocks still use that old password. Enter it once to re-encrypt them with your current password.`));
  const field = el('label', 'field');
  const label = el('span', '', "The backup's password");
  const input = el('input');
  input.type = 'password';
  input.autocomplete = 'off';
  field.append(label, input);
  let useRecovery = false;
  const toggle = button("Use the backup's recovery key instead", 'link-button');
  toggle.addEventListener('click', () => {
    useRecovery = !useRecovery;
    label.textContent = useRecovery ? "The backup's recovery key" : "The backup's password";
    input.type = useRecovery ? 'text' : 'password';
    input.placeholder = useRecovery ? 'XXXX-XXXX-…' : '';
    toggle.textContent = useRecovery ? "Use the backup's password instead" : "Use the backup's recovery key instead";
    input.focus();
  });
  const err = el('p', 'error small');
  body.append(field, toggle, err);
  const box = openModal('Re-encrypt restored blocks', body, [['Later'], ['Re-encrypt', () => false, 'primary']]);
  const go = box.querySelector('.modal-actions .primary');
  const run = async () => {
    err.textContent = '';
    go.disabled = true;
    go.textContent = 'Checking…';
    try {
      const oldKey = await sec.keyFromSetup(cfg, useRecovery ? { recovery: input.value } : { password: input.value });
      const result = await rekeyAll(oldKey, (done, total) => { go.textContent = `Page ${done} of ${total}…`; });
      if (result.failed) {
        err.textContent = `${result.failed} block(s) could not be decrypted with either password and were left as they are. Run this again to retry.`;
      } else {
        await api.importedKeyDone();
        closeModal();
        toast(`Re-encrypted ${result.count} block(s) on ${result.pages} page(s)`);
      }
      document.dispatchEvent(new CustomEvent('blockseq:resync'));
    } catch (e) {
      err.textContent = e.message || String(e);
    } finally {
      go.disabled = false;
      go.textContent = 'Re-encrypt';
    }
  };
  go.addEventListener('click', run);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  input.focus();
}

async function rekeyAll(oldKey, progress) {
  const names = await api.sealedPages();
  let count = 0;
  let failed = 0;
  let pages = 0;
  for (const [i, name] of names.entries()) {
    progress(i + 1, names.length);
    // Retry when the page changes on another device in the meantime.
    for (let attempt = 0; ; attempt++) {
      const data = await api.page(name);
      let changed = 0;
      let bad = 0;
      const blocks = [];
      for (const b of data.blocks) {
        const r = await sec.rekeyText(oldKey, b.content);
        changed += r.count;
        bad += r.failed;
        blocks.push({ id: b.id, parent_id: b.parent_id, content: r.text, collapsed: b.collapsed });
      }
      if (!changed) { failed += bad; break; }
      const res = await api.savePage(name, data.page?.version ?? 0, blocks);
      if (res.ok) { count += changed; failed += bad; pages++; break; }
      if (res.status !== 409 || attempt >= 2) throw new Error(`Could not save ${name}: ${explain(res.data, 'the save was refused')}`);
    }
  }
  return { count, failed, pages };
}

// The Settings → Backup panel.
export async function backupPanel() {
  const wrap = el('div', 'security-panel');
  const exportRow = el('div', 'status-actions security-actions');
  const dl = button(`Download backup of ${workbookLabel()}`, 'primary');
  dl.addEventListener('click', downloadBackup);
  exportRow.append(dl);
  wrap.append(
    el('p', 'small', 'A backup is one .zip of this workbook: the database, every page as Logseq Markdown, all assets, and the settings shared by your devices.'),
    exportRow,
    el('p', 'muted small', '#Encrypted blocks stay encrypted in the zip. It also holds the locked copy of the key, so after a restore your password (or recovery key) opens them again. Keep your recovery key somewhere other than next to the backups.'),
    el('p', 'muted small', 'For automatic backups, run on the server (e.g. from cron): blockseq export --all --out /path/to/backups'),
  );
  const importRow = el('div', 'status-actions security-actions');
  const imp = button('Import backup…');
  imp.addEventListener('click', () => importDialog());
  importRow.append(imp);
  wrap.append(el('h4', 'settings-subheading', 'Restore'),
    el('p', 'small', 'Restores a backup zip as a new workbook next to the ones you have, or into Main. A zipped Logseq graph works too.'),
    importRow);
  try {
    const saved = await api.backups();
    if (saved.length) {
      const list = el('div', 'backup-list');
      for (const b of saved) {
        const row = el('div', 'backup-row');
        const a = el('a', '', b.name);
        a.href = `/api/backups/${encodeURIComponent(b.name)}`;
        a.download = b.name;
        row.append(a, el('span', 'muted small', `${(b.size / 1048576).toFixed(1)} MB`));
        list.append(row);
      }
      wrap.append(el('h4', 'settings-subheading', 'Saved before a restore'),
        el('p', 'muted small', 'Main as it was before each Restore into Main (the last 10). Restore one with Import backup.'),
        list);
    }
  } catch { /* offline */ }
  try {
    if ((await api.importedKey()).encryption) {
      const row = el('div', 'status-actions security-actions');
      const b = button('Re-encrypt restored blocks…', 'primary');
      b.addEventListener('click', () => rekeyDialog());
      row.append(b);
      wrap.append(el('p', 'error small', 'Some #Encrypted blocks in this workbook came from a backup with a different password.'), row);
    }
  } catch { /* offline */ }
  return wrap;
}
