// #Encrypted blocks in the editor: sealing children before a save, opening
// them after unlocking, and how a locked block is shown. Plaintext never
// leaves the browser (see crypto.js).

import { uuid } from './api.js';
import { rekeyDialog } from './backup-ui.js';
import { available as cryptoAvailable, decryptText, ENCRYPTED_TAG, encryptText, isUnlocked } from './crypto.js';
import { el } from './dom.js';
import { isInside, makeNode, subtreeMarkdown } from './editor.js';
import { parseOutline, splitProps } from './render.js';
import { unlockDialog } from './secure-ui.js';

class SecretsMethods {
  // Every #Encrypted block, innermost first (so nested ones seal before the
  // block that contains them).
  secretRoots() {
    const out = [];
    const walk = (n) => n.children.forEach((c) => {
      walk(c);
      if (ENCRYPTED_TAG.test(c.content) || c.props.encrypted) out.push(c);
    });
    walk(this.root);
    return out;
  }

  // Decrypts every locked encrypted block on the page (when unlocked).
  async openSecrets() {
    if (!isUnlocked()) return;
    if (this.needsSealing()) this.sealNow();
    let changed = false;
    for (const r of this.secretRoots()) {
      if (!r.props.encrypted || r.unsealed) continue;
      try {
        const text = await decryptText(r.props.encrypted);
        if (this.disposed || r.unsealed) return;
        const kids = text.trim() ? (parseOutline(text, uuid) || []) : [];
        const existing = new Set(this.flatten().map((b) => b.id));
        const adopt = (n, parent) => {
          if (existing.has(n.id)) n.id = uuid();
          existing.add(n.id);
          n.parent = parent;
          const split = splitProps(n.content);
          n.content = split.content;
          n.props = split.props;
          n.children.forEach((c) => adopt(c, n));
        };
        kids.forEach((k) => adopt(k, r));
        r.children = [...kids, ...r.children]; // keep blocks added while locked
        r.unsealed = true;
        r.sealedText = text;
        r.decryptError = false;
        changed = true;
      } catch {
        r.decryptError = true;
        changed = true;
      }
    }
    if (changed && !this.disposed) {
      this.refresh(this.editing, this.ta?.selectionStart);
      // Opening a block may reveal encrypted blocks nested inside it.
      if (this.secretRoots().some((r) => r.props.encrypted && !r.unsealed && !r.decryptError)) this.openSecrets();
    }
  }

  // Before saving: encrypt the children of every #Encrypted block. Children
  // are only ever sent to the server inside the encrypted property.
  async sealSecrets() {
    for (const r of this.secretRoots()) {
      const tagged = ENCRYPTED_TAG.test(r.content);
      if (!tagged && r.props.encrypted && r.unsealed) {
        // Tag removed while unlocked: store the children as normal blocks again.
        delete r.props.encrypted;
        r.unsealed = false;
        this.decorateSecret(r);
        continue;
      }
      if (!tagged || !isUnlocked()) continue;
      if (r.props.encrypted && !r.unsealed) continue; // still locked
      const text = r.children.map((c) => subtreeMarkdown(c, { ids: true })).join('\n');
      if (!r.props.encrypted || text !== r.sealedText) {
        r.props.encrypted = await encryptText(text);
        r.sealedText = text;
      }
      const was = r.unsealed;
      r.unsealed = true;
      if (!was) this.decorateSecret(r);
    }
  }

  // #Encrypted blocks whose children are still plain text (tagged before a
  // password existed, or while locked).
  needsSealing() {
    return this.secretRoots().some((r) => ENCRYPTED_TAG.test(r.content) && !r.props.encrypted && r.children.length);
  }

  // Encrypt such blocks now (needs the key). Resolves once saved.
  async sealNow() {
    if (!isUnlocked() || !this.needsSealing()) return;
    this.dirty = true;
    this.changeSeq++;
    await this.save();
  }

  // After /encrypted: open an empty child for the secret text, and ask to
  // unlock first if needed so nothing is saved as plain text.
  startSecretChild(node) {
    const child = makeNode();
    this.insertChild(node, child, 0);
    node.collapsed = false;
    this.refresh(child, 'end');
    if (!isUnlocked()) {
      // The password prompt takes the focus; come back to the child after it.
      const reopen = () => setTimeout(() => {
        const n = this.findNode(child.id);
        if (n && !this.disposed) this.edit(n, 'end');
      }, 50);
      document.addEventListener('blockseq:unlocked', reopen, { once: true });
      unlockDialog();
    }
  }

  // Called while locking: save (encrypting with the key one last time).
  async beforeLock() {
    if (this.editing && this.secretRoots().some((r) => isInside(this.editing, r))) this.stopEdit();
    if (this.codeEdit && this.secretRoots().some((r) => isInside(this.codeEdit.node, r))) this.closeCodeEditor();
    if (this.dirty || this.needsSealing()) {
      this.dirty = true;
      await this.save();
    }
  }

  // After locking: drop decrypted text from memory (and undo history).
  afterLock() {
    let any = false;
    for (const r of this.secretRoots()) {
      if (r.props.encrypted && r.unsealed) {
        if (this.editing && isInside(this.editing, r)) this.stopEdit();
        r.children = [];
        r.unsealed = false;
        r.sealedText = null;
        any = true;
      }
    }
    if (any) {
      this.undoStack = [];
      this.redoStack = [];
      this.refresh(this.editing, this.ta?.selectionStart);
    }
  }

  // Lock button, styling and the locked / not-encrypted notice of an
  // #Encrypted block. Re-run whenever its state changes.
  decorateSecret(node) {
    const wrap = node.el;
    if (!wrap) return;
    const row = wrap.querySelector(':scope > .block-row');
    wrap.querySelector(':scope > .secret-box')?.remove();
    row?.querySelector(':scope > .secret-lock')?.remove();
    const secret = ENCRYPTED_TAG.test(node.content) || !!node.props.encrypted;
    wrap.classList.toggle('secret-root', secret);
    wrap.classList.toggle('unlocked', secret && !!node.unsealed);
    if (!secret) return;
    if (node.unsealed && row) {
      const lockBtn = el('button', 'secret-lock', '🔓 Lock');
      lockBtn.type = 'button';
      lockBtn.title = 'Lock all encrypted blocks now';
      lockBtn.addEventListener('mousedown', (e) => e.preventDefault());
      lockBtn.addEventListener('click', () => import('./crypto.js').then((m) => m.lock()));
      row.append(lockBtn);
    } else if (node.props.encrypted || node.children.length) {
      wrap.append(this.secretNotice(node));
    }
  }

  // The box shown under a locked #Encrypted block (or one not encrypted yet).
  secretNotice(node) {
    const box = el('div', 'children secret-box');
    const btn = el('button', 'secret-unlock');
    btn.type = 'button';
    if (!node.props.encrypted) {
      btn.textContent = isUnlocked()
        ? '⚠ Encrypting…'
        : '⚠ Not encrypted yet: these blocks are still stored as plain text. Click to unlock and encrypt them now.';
      btn.classList.add('warn');
    } else if (!cryptoAvailable()) {
      btn.textContent = '🔒 Encrypted. Open Blockseq over HTTPS to unlock it.';
      btn.disabled = true;
    } else if (node.decryptError) {
      btn.textContent = "🔒 Encrypted with a different password (restored from a backup?). Click to re-encrypt it with your current password.";
      btn.classList.add('warn');
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => rekeyDialog());
      box.append(btn);
      return box;
    } else {
      btn.textContent = '🔒 Encrypted. Click to unlock.';
    }
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => unlockDialog());
    box.append(btn);
    return box;
  }
}

// Adds the methods above to the editor class.
export function installSecrets(cls) {
  for (const name of Object.getOwnPropertyNames(SecretsMethods.prototype)) {
    if (name === 'constructor') continue;
    Object.defineProperty(cls.prototype, name, Object.getOwnPropertyDescriptor(SecretsMethods.prototype, name));
  }
}
