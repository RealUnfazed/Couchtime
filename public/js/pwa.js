// Registers the service worker and adds an "Install" button to the top bar when the browser allows it.
//
// Chrome, Edge and Android offer installation through the "beforeinstallprompt" event. Safari on iPhone
// and iPad has no such event: people use Share, then "Add to Home Screen" (the page already has the
// icon and meta tags for that), so no button is shown there.

import { h, icon } from './ui.js';

let offered = null;
let button = null;

const installed = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function showButton() {
  if (button || installed()) return;
  const account = document.getElementById('account');
  if (!account) return;
  button = h('button', {
    class: 'btn btn-ghost btn-sm', id: 'install-btn', type: 'button', title: 'Install this app', 'aria-label': 'Install this app',
    onclick: async () => {
      if (!offered) return;
      offered.prompt();
      try { await offered.userChoice; } catch (_) { /* dismissed */ }
      offered = null;
      hideButton();
    },
  }, icon('download'), h('span', { class: 'label-long' }, 'Install'));
  account.before(button);
}

function hideButton() {
  if (button) button.remove();
  button = null;
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // keep the event so our own button can trigger the prompt
  offered = e;
  showButton();
});

window.addEventListener('appinstalled', () => { offered = null; hideButton(); });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('[pwa] service worker not registered:', err.message));
  });
}
