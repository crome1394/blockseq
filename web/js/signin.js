// Signing out (when BLOCKSEQ_PASSWORD is set; see src/session.rs). The
// header button and Settings → Security use it.

import { api } from './api.js';
import { editors } from './editor.js';
import { toast } from './ui.js';

// Sends unsaved edits first, then ends this browser's session (or every
// browser's with `all`) and shows the sign-in page.
export async function signOut(all = false) {
  await Promise.all([...editors].filter((ed) => ed.dirty).map((ed) => ed.save()));
  if ([...editors].some((ed) => ed.dirty)) {
    toast('Some changes are not saved yet. Try again when the status says Saved.');
    return;
  }
  const r = await api.logout(all).catch(() => null);
  if (!r?.ok) { toast('Could not sign out (is the server reachable?)'); return; }
  location.href = '/login?e=out';
}

// Shows the Sign out button when signing in is used.
export async function showSignOut(button) {
  const info = await api.session().catch(() => null);
  button.hidden = !info?.password;
  return !!info?.password;
}
