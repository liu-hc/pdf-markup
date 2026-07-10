/**
 * Passcode gate — a full-screen lock shown before the app boots.
 *
 * A single shared passcode is compared as a SHA-256 hash (the plaintext never
 * appears in the source or the bundle). Successful entry is remembered in
 * localStorage so returning visitors go straight in.
 *
 * NOTE: this is a client-side gate for casually sharing the link — it keeps
 * strangers out, but anyone technical enough to read the bundle can bypass
 * it. Do not treat it as protection for sensitive documents.
 */

/** SHA-256 of the shared passcode. */
const PASS_HASH = 'b0b48476a6b88ec694761ac98f8ebb7575ae8bd5a05ece43ca0090161077cd48';

const STORAGE_KEY = 'markup-studio-access';

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Resolves once the visitor has entered the correct passcode (or already
 *  did on a previous visit). The app shell is only built after this. */
export function ensureAccess(): Promise<void> {
  try {
    if (localStorage.getItem(STORAGE_KEY) === PASS_HASH) return Promise.resolve();
  } catch {
    /* storage unavailable (private mode) — fall through to the prompt */
  }

  return new Promise((resolve) => {
    const gate = document.createElement('div');
    gate.className = 'pass-gate';
    gate.innerHTML = `
      <div class="pass-card">
        <div class="pass-mark"><svg width="22" height="22" viewBox="0 0 20 20" fill="none"><rect x="2" y="1.5" width="10" height="13" rx="1.2" stroke="rgba(255,255,255,0.55)" stroke-width="1.3"/><rect x="8" y="5.5" width="10" height="13" rx="1.2" fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.85)" stroke-width="1.3"/><path d="M10 13.5l4.5-4.5 1.5 1.5-4.5 4.5L10 16z" fill="#fff"/></svg></div>
        <h1>Markup Studio</h1>
        <p class="pass-hint">Enter the passcode to continue</p>
        <form class="pass-form">
          <input type="password" class="pass-input" placeholder="Passcode" autocomplete="current-password" autofocus spellcheck="false">
          <button type="submit" class="pass-btn">Enter</button>
        </form>
        <p class="pass-error" role="alert"></p>
      </div>`;
    document.body.appendChild(gate);

    const card = gate.querySelector('.pass-card') as HTMLElement;
    const form = gate.querySelector('.pass-form') as HTMLFormElement;
    const input = gate.querySelector('.pass-input') as HTMLInputElement;
    const error = gate.querySelector('.pass-error') as HTMLElement;
    input.focus();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const hash = await sha256Hex(input.value);
      if (hash === PASS_HASH) {
        try {
          localStorage.setItem(STORAGE_KEY, PASS_HASH);
        } catch {
          /* private mode — access lasts for this visit only */
        }
        gate.classList.add('pass-gate--open');
        setTimeout(() => gate.remove(), 450);
        resolve();
      } else {
        error.textContent = 'Incorrect passcode — try again.';
        input.value = '';
        input.focus();
        card.classList.remove('pass-card--shake');
        // Restart the shake animation on every failed attempt
        void card.offsetWidth;
        card.classList.add('pass-card--shake');
      }
    });
  });
}
