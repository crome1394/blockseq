// Dialogs and the Settings → Security panel for #Encrypted blocks.

import { el } from './dom.js';
import * as sec from './crypto.js';
import { openModal, closeModal, toast, copyText } from './ui.js';
import { signOut } from './signin.js';
import { api } from './api.js';

function passwordField(label, autocomplete = 'current-password') {
  const wrap = el('label', 'field');
  wrap.append(el('span', '', label));
  const input = el('input');
  input.type = 'password';
  input.autocomplete = autocomplete;
  wrap.append(input);
  return [wrap, input];
}

function textField(label, placeholder = '') {
  const wrap = el('label', 'field');
  wrap.append(el('span', '', label));
  const input = el('input');
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.autocomplete = 'off';
  wrap.append(input);
  return [wrap, input];
}

// Runs an async action from a dialog button, showing progress and errors.
function busy(button, err, fn) {
  return async () => {
    err.textContent = '';
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Working…';
    try {
      await fn();
    } catch (e) {
      err.textContent = e.message || String(e);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  };
}

function needsHttps() {
  if (sec.available()) return false;
  openModal('Encrypted blocks need HTTPS', el('p', '', 'Browsers only allow encryption on secure (https://) pages. Open Blockseq at your HTTPS address (e.g. through Caddy) to set a password or unlock encrypted blocks.'));
  return true;
}

// Asks for the password and unlocks every encrypted block.
export async function unlockDialog() {
  if (needsHttps()) return;
  if (!(await sec.isConfigured())) return setupDialog();
  const body = el('div', 'dialog-form');
  const [field, input] = passwordField('Password');
  const err = el('p', 'error small');
  const forgot = el('button', 'link-button', 'Forgot the password?');
  forgot.type = 'button';
  forgot.addEventListener('click', () => recoveryDialog());
  body.append(field, err, forgot);
  const box = openModal('Unlock encrypted blocks', body, [['Cancel'], ['Unlock', () => false, 'primary']]);
  const go = box.querySelector('.modal-actions .primary');
  const run = busy(go, err, async () => {
    await sec.unlock(input.value);
    closeModal();
    toast('Unlocked');
  });
  go.addEventListener('click', run);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  input.focus();
}

function newPasswordFields(body) {
  const [f1, p1] = passwordField('New password', 'new-password');
  const [f2, p2] = passwordField('Repeat it', 'new-password');
  body.append(f1, f2);
  return () => {
    if (p1.value.length < 8) throw new Error('Use at least 8 characters');
    if (p1.value !== p2.value) throw new Error("The passwords don't match");
    return p1.value;
  };
}

// First-time setup, then shows the recovery key once.
export function setupDialog() {
  if (needsHttps()) return;
  const body = el('div', 'dialog-form');
  body.append(el('p', 'small', 'This password unlocks every #Encrypted block in every workbook. Blocks are encrypted in your browser; the server only stores scrambled text.'));
  const read = newPasswordFields(body);
  const err = el('p', 'error small');
  body.append(err);
  const box = openModal('Set an encryption password', body, [['Cancel'], ['Set password', () => false, 'primary']]);
  const go = box.querySelector('.modal-actions .primary');
  go.addEventListener('click', busy(go, err, async () => {
    const recovery = await sec.setUp(read());
    showRecoveryKey(recovery);
  }));
  body.querySelector('input').focus();
}

function showRecoveryKey(key) {
  const body = el('div', 'dialog-form');
  body.append(el('p', '', 'Save this recovery key somewhere safe (a password manager, or printed). It is the only way back in if you forget the password; it is shown only once.'));
  body.append(el('div', 'recovery-key', key));
  const tools = el('div', 'status-actions');
  const copy = el('button', '', 'Copy');
  copy.type = 'button';
  copy.addEventListener('click', () => { copyText(key); toast('Recovery key copied'); });
  const save = el('button', '', 'Download as text file');
  save.type = 'button';
  save.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`Blockseq recovery key\n\n${key}\n\nReset the password in Settings > Security, or on the server:\n  blockseq reset-encryption-password\n`], { type: 'text/plain' }));
    a.download = 'blockseq-recovery-key.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  tools.append(copy, save);
  const okLabel = el('label', 'check');
  const ok = el('input');
  ok.type = 'checkbox';
  okLabel.append(ok, ' I have saved my recovery key');
  body.append(tools, okLabel);
  const box = openModal('Your recovery key', body, [['Done', () => ok.checked || (toast('Tick the box once the key is saved'), false), 'primary']]);
  box.classList.add('no-overlay-close');
}

// New password using the recovery key (in the browser).
export function recoveryDialog() {
  if (needsHttps()) return;
  const body = el('div', 'dialog-form');
  body.append(el('p', 'small', 'Enter the recovery key you saved when the password was set, then choose a new password. Your encrypted blocks stay readable. You can also do this on the server with: blockseq reset-encryption-password'));
  const [rf, rk] = textField('Recovery key', 'XXXX-XXXX-…');
  body.append(rf);
  const read = newPasswordFields(body);
  const err = el('p', 'error small');
  body.append(err);
  const box = openModal('Reset the encryption password', body, [['Cancel'], ['Reset password', () => false, 'primary']]);
  const go = box.querySelector('.modal-actions .primary');
  go.addEventListener('click', busy(go, err, async () => {
    await sec.changePassword({ recovery: rk.value }, read());
    closeModal();
    toast('Password changed and unlocked');
  }));
  rk.focus();
}

export function changeDialog() {
  if (needsHttps()) return;
  const body = el('div', 'dialog-form');
  const [cf, cur] = passwordField('Current password');
  body.append(cf);
  const read = newPasswordFields(body);
  const err = el('p', 'error small');
  body.append(err);
  const box = openModal('Change the encryption password', body, [['Cancel'], ['Change password', () => false, 'primary']]);
  const go = box.querySelector('.modal-actions .primary');
  go.addEventListener('click', busy(go, err, async () => {
    await sec.changePassword({ current: cur.value }, read());
    closeModal();
    toast('Password changed');
  }));
  cur.focus();
}

// The live part of Settings → Security (actions happen right away).
// Settings → Security, when signing in is used: sign out here or everywhere.
async function signInSection(wrap) {
  const info = await api.session().catch(() => null);
  if (!info?.password) return;
  const actions = el('div', 'status-actions security-actions');
  const here = el('button', '', 'Sign out');
  here.type = 'button';
  here.addEventListener('click', () => signOut());
  const all = el('button', '', 'Sign out everywhere…');
  all.type = 'button';
  all.addEventListener('click', () => {
    if (confirm('Sign out every browser, including this one? Each one signs in again with the password. Paired devices stay paired; revoke them below.')) signOut(true);
  });
  actions.append(here, all);
  wrap.append(
    el('h4', 'settings-subheading', 'Signing in'),
    el('p', 'small', 'This browser stays signed in for 90 days after it was last used. Changing BLOCKSEQ_PASSWORD signs every browser out.'),
    actions,
    el('h4', 'settings-subheading', 'Paired devices'),
  );
  const list = el('div', 'device-list');
  wrap.append(list, el('h4', 'settings-subheading', 'Encrypted blocks'));
  await drawDevices(list);
}

// Apps paired with their own token (the password is not stored on them).
async function drawDevices(list) {
  const devices = await api.devices().catch(() => null);
  if (!devices) { list.replaceChildren(el('p', 'muted small', 'Could not load the paired devices.')); return; }
  if (!devices.length) {
    list.replaceChildren(el('p', 'muted small', 'No devices yet. The Blockseq app pairs with your server address and password once; it then uses a token of its own, which you can revoke here.'));
    return;
  }
  const when = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  list.replaceChildren(...devices.map((d) => {
    const row = el('div', 'device-row');
    const info = el('div', '');
    info.append(el('strong', '', d.name), el('div', 'muted small', `Paired ${when(d.created)} · last used ${when(d.last_seen)}`));
    const revoke = el('button', '', 'Revoke');
    revoke.type = 'button';
    revoke.addEventListener('click', async () => {
      if (!confirm(`Revoke “${d.name}”? It stops working until it is paired again with the password.`)) return;
      const r = await api.revokeDevice(d.id);
      if (!r.ok && r.status !== 404) { toast('Could not revoke it'); return; }
      toast(`Revoked ${d.name}`);
      drawDevices(list);
    });
    row.append(info, revoke);
    return row;
  }));
}

export async function securityPanel() {
  const wrap = el('div', 'security-panel');
  await signInSection(wrap);
  if (!sec.available()) {
    wrap.append(el('p', 'error small', 'Encryption needs HTTPS. Open Blockseq at your https:// address to set a password or unlock encrypted blocks.'));
    return wrap;
  }
  const configured = await sec.isConfigured().catch(() => false);
  const state = el('p', 'small');
  const actions = el('div', 'status-actions security-actions');
  const button = (label, fn, cls = '') => {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', fn);
    actions.append(b);
  };
  if (!configured) {
    state.textContent = 'No encryption password is set yet. Tag a block #Encrypted to encrypt everything nested under it.';
    button('Set password…', () => setupDialog(), 'primary');
  } else {
    state.textContent = sec.isUnlocked() ? '🔓 Encrypted blocks are unlocked in this tab.' : '🔒 Encrypted blocks are locked.';
    if (sec.isUnlocked()) button('Lock now', () => sec.lock());
    else button('Unlock…', () => unlockDialog(), 'primary');
    button('Change password…', () => changeDialog());
    button('Forgot password…', () => recoveryDialog());
  }
  wrap.append(state, actions, el('p', 'muted small', 'If the password is forgotten, run this on the server with the recovery key: blockseq reset-encryption-password'));
  return wrap;
}
