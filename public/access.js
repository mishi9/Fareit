// Invite-only access. A phone is let in once, by opening a one-time invite link (or, for the
// owner, with the owner code), and gets a key that rides on every /api call. No logins, no names.
//
// iPhone: Safari and a Home Screen app keep separate storage, so the invite has to be redeemed
// by the Home Screen app itself. In Safari we keep ?invite= in the address and point the
// manifest at it, then ask the driver to Add to Home Screen; the Home Screen app opens with the
// invite and lets itself in. ("Use in Safari instead" is there for anyone who won't.)

const KEY = 'agaration-key';
const KIND = 'agaration-kind';
const DEVICE = 'agaration-device';
const HIDE = 'agaration-hide-workings';
const TOKEN_RE = /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;

const get = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const set = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* storage blocked */ } };

export const accessKind = () => get(KIND); // 'owner' | 'driver' | ''
export const isOwnerPhone = () => get(KEY) !== '' && get(KIND) === 'owner';
// The owner sees how the estimate is worked out, unless they've hidden it (e.g. to see what testers see).
export const isOwner = () => isOwnerPhone() && get(HIDE) !== '1';
export const hideWorkings = (hide) => set(HIDE, hide ? '1' : '');

function device() {
  let d = get(DEVICE);
  if (!d) {
    d = `ph-${crypto.getRandomValues(new Uint32Array(3)).join('-')}`.slice(0, 64);
    set(DEVICE, d);
  }
  return d;
}

// Every same-site /api call carries this phone's key. If the server says the key is no longer
// good (revoked), the app locks and shows the invite screen.
const realFetch = window.fetch.bind(window);
let onLocked = null;
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
  const key = get(KEY);
  const headers = new Headers(init.headers || (typeof input === 'string' ? undefined : input.headers));
  if (key) headers.set('x-agaration-key', key);
  const res = await realFetch(input, { ...init, headers });
  if (res.status === 401 && onLocked) {
    res.clone().json().then((b) => { if (b && b.locked) onLocked(); }).catch(() => {});
  }
  return res;
};

async function post(path, body) {
  const res = await realFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}

function letIn({ key, kind }) {
  set(KEY, key);
  set(KIND, kind);
}

export async function claimOwner(code) {
  letIn(await post('/api/owner/claim', { code: String(code || '').trim(), device: device() }));
}

// A new phone (or a cleared app): back in as the same driver with the recovery code.
export async function recover(code) {
  const c = String(code || '').trim();
  letIn(await post('/api/access/recover', { code: c, device: device() }));
  set('agaration-recovery', c.toUpperCase());
  set('agaration-recovery-saved', '1'); // they just used it, so they have it
}

async function redeem(token) {
  letIn(await post('/api/access/redeem', { token, device: device() }));
}

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

// A pasted invite link, or just the code.
const tokenFrom = (text) => {
  const s = String(text || '').trim();
  let t = s;
  try { t = new URL(s).searchParams.get('invite') || s; } catch { /* not a link */ }
  t = t.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return t.length === 12 ? `${t.slice(0, 4)}-${t.slice(4, 8)}-${t.slice(8)}` : '';
};

function dropInviteFromAddress() {
  const u = new URL(location.href);
  if (!u.searchParams.has('invite')) return;
  u.searchParams.delete('invite');
  history.replaceState(null, '', u.pathname + u.search + u.hash);
}

// ---------- the screen shown until a phone is let in ----------
function gate({ token, mode, error }) {
  return new Promise((resolve) => {
    document.querySelector('.gate')?.remove();
    const el = document.createElement('div');
    el.className = 'gate';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Agaration is invite-only');
    const homeScreen = mode === 'ios-install';
    el.innerHTML = `
      <div class="gate-card stack">
        <div class="gate-logo"><span class="logo" role="img" aria-label="Agaration"><svg class="logo-up" viewBox="0 0 60 73" aria-hidden="true"><path class="up-g" d="M5 28.5 30 4.5l25 24"/><path class="up-a" d="M5 48.5l25-24 25 24"/><path class="up-r" d="M5 68.5l25-24 25 24"/></svg><span aria-hidden="true">garation</span></span></div>
        ${homeScreen ? `
          <h2>One step: add it to your Home Screen</h2>
          <ol class="gate-steps">
            <li>Tap the <b>Share</b> button <span aria-hidden="true">(the square with an arrow)</span> at the bottom of Safari.</li>
            <li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li>
            <li>Open <b>Agaration</b> from your Home Screen. It lets itself in.</li>
          </ol>
          <p class="note">Your invite link works for <b>60 minutes</b> from when you first opened it, so do this now. Once the Home Screen app is in, it stays unlocked.</p>
          <p class="note">Already have Agaration on your Home Screen? Open it and enter this code: <b class="gate-code">${escapeHtml(token)}</b></p>
          <button type="button" class="ghost small" id="gate-safari">Use it in Safari instead</button>
        ` : `
          <h2>Agaration is invite-only</h2>
          <p class="note">Open the invite link you were sent on this phone, or paste it here.</p>
          <div class="field"><label for="gate-token">Invite link or code</label>
            <input id="gate-token" type="text" autocomplete="off" autocapitalize="characters" placeholder="ABCD-EFGH-JKMN"></div>
          <button type="button" class="primary" id="gate-go">Let me in</button>
          <details class="gate-owner" id="gate-recover-box"><summary>New phone? I have a recovery code</summary>
            <div class="row2">
              <div class="field"><label for="gate-recover">Recovery code</label>
                <input id="gate-recover" type="text" autocomplete="off" autocapitalize="characters" placeholder="RXXX-XXXX-XXXX"></div>
              <button type="button" class="ghost" id="gate-recover-go">Get back in</button>
            </div>
            <p class="note">The code from Settings → This phone on your old phone. You'll be the same animal, with your points and jobs.</p>
          </details>
          <details class="gate-owner"><summary>I’m the owner</summary>
            <div class="row2">
              <div class="field"><label for="gate-code">Owner code</label>
                <input id="gate-code" type="text" inputmode="numeric" autocomplete="off" placeholder="Code"></div>
              <button type="button" class="ghost" id="gate-owner">Unlock</button>
            </div>
          </details>
        `}
        <p class="msg${error ? ' err' : ''}" id="gate-msg" role="status">${error ? escapeHtml(error) : ''}</p>
      </div>`;
    document.body.append(el);
    document.body.classList.add('gated');
    const msg = (text, bad) => {
      const m = el.querySelector('#gate-msg');
      m.textContent = text;
      m.classList.toggle('err', Boolean(bad));
    };
    const done = () => {
      el.remove();
      document.body.classList.remove('gated');
      dropInviteFromAddress();
      resolve();
    };
    const attempt = async (fn, busyText) => {
      for (const b of el.querySelectorAll('button')) b.disabled = true;
      msg(busyText);
      try { await fn(); done(); } catch (e) {
        msg(navigator.onLine ? e.message : 'You’re offline. Connect and try again.', true);
        for (const b of el.querySelectorAll('button')) b.disabled = false;
      }
    };
    if (homeScreen) {
      el.querySelector('#gate-safari').addEventListener('click', () => attempt(() => redeem(token), 'Letting you in…'));
      return;
    }
    const tokenInput = el.querySelector('#gate-token');
    if (token) tokenInput.value = token;
    el.querySelector('#gate-go').addEventListener('click', () => {
      const t = tokenFrom(tokenInput.value);
      if (!TOKEN_RE.test(t)) { msg('That doesn’t look like an invite. It’s 12 letters and numbers.', true); return; }
      attempt(() => redeem(t), 'Letting you in…');
    });
    el.querySelector('#gate-owner').addEventListener('click', () => attempt(() => claimOwner(el.querySelector('#gate-code').value), 'Checking…'));
    el.querySelector('#gate-recover-go').addEventListener('click', () => attempt(() => recover(el.querySelector('#gate-recover').value), 'Checking…'));
  });
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Lock this phone (its key was revoked) and show the invite screen again.
function lockOut() {
  set(KEY, '');
  set(KIND, '');
  gate({ error: 'This phone’s access was turned off: either you moved to a new phone with your recovery code, or the owner turned it off.' }).then(() => location.reload());
}

// Resolves once this phone may use the app. Call before the app starts.
export async function ready() {
  const token = tokenFrom(new URL(location.href).searchParams.get('invite'));
  onLocked = lockOut;

  if (get(KEY)) {
    dropInviteFromAddress(); // already in: an invite link opened again isn't used up
    // Still good? Checked in the background; offline is fine, the app works from the phone.
    realFetch('/api/access', { headers: { 'x-agaration-key': get(KEY) } })
      .then((r) => (r.status === 401 ? r.json() : null)).then((b) => { if (b && b.locked) lockOut(); }).catch(() => {});
    return;
  }

  let inviteOnly = true;
  try {
    const s = await (await realFetch('/api/status')).json();
    inviteOnly = s.inviteOnly === true;
  } catch { /* offline: assume it's locked */ }
  if (!inviteOnly) { dropInviteFromAddress(); return; }

  if (token && isIos() && !isStandalone()) {
    // Opening the link starts its 60 minutes; say so now if it's already expired.
    try { await post('/api/access/open', { token }); } catch (e) {
      await gate({ token, error: e.message });
      return;
    }
    await gate({ token, mode: 'ios-install' });
    return;
  }
  if (token) {
    try { await redeem(token); dropInviteFromAddress(); return; } catch (e) {
      await gate({ token, error: e.message });
      return;
    }
  }
  await gate({});
}

// ---------- owner: invites ----------
export async function ownerApi(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Couldn’t reach the server.');
  return data;
}
export const inviteLink = (token) => `${location.origin}/?invite=${token}`;
