import { api } from './api.js';
import { session, rememberName } from './session.js';
import { h, icon, avatar, openModal, toast } from './ui.js';

export const COLORS = ['#ff7a8a', '#ffb547', '#9be564', '#4fd1c5', '#63b3ff', '#a78bfa', '#f38bd8', '#ff9966', '#7bdff2', '#c3e88d'];

export function openAuthModal({ start = 'login', onDone } = {}) {
  let mode = start;
  const err = h('p', { class: 'err', role: 'alert' });
  const user = h('input', { class: 'field', id: 'au-user', autocomplete: 'username', maxLength: 24, required: true });
  const pass = h('input', { class: 'field', id: 'au-pass', type: 'password', autocomplete: 'current-password', maxLength: 128, required: true });
  const nick = h('input', { class: 'field', id: 'au-nick', maxLength: 24, value: (session.me && session.me.name) || '', placeholder: 'What friends will see' });
  const nickRow = h('div', null, h('label', { class: 'lbl', for: 'au-nick' }, 'Display name'), nick);
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Sign in');
  const tabLogin = h('button', { type: 'button', role: 'tab', onclick: () => setMode('login') }, 'Sign in');
  const tabReg = h('button', { type: 'button', role: 'tab', onclick: () => setMode('register') }, 'Create account');
  const note = h('p', { class: 'hint' });

  const form = h('form', { class: 'stack', novalidate: true },
    h('div', { class: 'tabs-inline', role: 'tablist' }, tabLogin, tabReg),
    h('div', null, h('label', { class: 'lbl', for: 'au-user' }, 'Username'), user),
    h('div', null, h('label', { class: 'lbl', for: 'au-pass' }, 'Password'), pass),
    nickRow, note, err
  );

  function setMode(m) {
    mode = m;
    tabLogin.setAttribute('aria-selected', String(m === 'login'));
    tabReg.setAttribute('aria-selected', String(m === 'register'));
    nickRow.hidden = m === 'login';
    pass.autocomplete = m === 'login' ? 'current-password' : 'new-password';
    submit.textContent = m === 'login' ? 'Sign in' : 'Create account';
    note.textContent = m === 'register'
      ? 'Accounts are free. You can keep rooms forever, pick your own room address and use the same name everywhere.'
      : 'Rooms you made as a guest on this browser move to your account.';
    err.textContent = '';
  }
  setMode(mode);

  const modal = openModal({
    title: 'Your account',
    content: form,
    actions: [h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => modal.close() }, 'Cancel'), submit],
  });
  submit.setAttribute('form', 'au-form');
  form.id = 'au-form';

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    submit.disabled = true;
    try {
      const body = { username: user.value.trim(), password: pass.value };
      if (mode === 'register') body.displayName = nick.value;
      const { me } = await api(mode === 'login' ? '/auth/login' : '/auth/register', { method: 'POST', body });
      session.me = me;
      rememberName(me.name);
      modal.close();
      toast(mode === 'login' ? `Welcome back, ${me.name}.` : `Account created. Welcome, ${me.name}.`);
      if (onDone) onDone(me);
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      submit.disabled = false;
    }
  });
}

export function openProfileModal({ onDone } = {}) {
  const me = session.me;
  let color = me.color;
  const name = h('input', { class: 'field', id: 'pf-name', maxLength: 24, value: me.name });
  const err = h('p', { class: 'err', role: 'alert' });
  const swatches = h('div', { class: 'swatches' });
  const paint = () => {
    swatches.replaceChildren(...COLORS.map((c) => h('button', {
      type: 'button', style: { background: c }, 'aria-label': `Color ${c}`, 'aria-pressed': String(c === color),
      onclick: () => { color = c; paint(); },
    })));
  };
  paint();

  const extra = me.kind === 'user'
    ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: async () => {
      await api('/auth/logout', { method: 'POST' });
      session.me = null;
      modal.close();
      if (onDone) onDone(null);
    } }, icon('logout'), 'Sign out')
    : h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { modal.close(); openAuthModal({ start: 'register', onDone }); } }, icon('user'), 'Sign in or create account');

  const save = h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
    err.textContent = '';
    try {
      const res = await api('/auth/profile', { method: 'PATCH', body: { name: name.value, color } });
      session.me = res.me;
      rememberName(res.me.name);
      modal.close();
      if (onDone) onDone(res.me);
    } catch (ex) { err.textContent = ex.message; }
  } }, 'Save');

  const modal = openModal({
    title: me.kind === 'user' ? 'Your profile' : 'Your nickname',
    sub: me.kind === 'guest' ? 'You are using a guest nickname on this browser.' : undefined,
    content: h('div', { class: 'stack' },
      h('div', null, h('label', { class: 'lbl', for: 'pf-name' }, 'Display name'), name),
      h('div', null, h('span', { class: 'lbl' }, 'Color'), swatches),
      err),
    actions: [extra, save],
  });
}

// The small account widget in the top bar.
export function mountAccount(host, { onChange } = {}) {
  const render = () => {
    const me = session.me;
    host.replaceChildren();
    if (!me || me.kind !== 'user') {
      host.append(h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => openAuthModal({ onDone: () => { render(); onChange && onChange(); } }) }, 'Sign in'));
    }
    if (me) {
      host.append(h('button', {
        class: 'btn btn-ghost btn-sm', type: 'button', title: 'Edit your name and color',
        onclick: () => openProfileModal({ onDone: () => { render(); onChange && onChange(); } }),
      }, avatar(me, 22), h('span', { dir: 'auto' }, me.name)));
    }
  };
  render();
  return render;
}
