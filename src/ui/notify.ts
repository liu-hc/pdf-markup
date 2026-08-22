/** Minimal modal error surface. Kept free of app imports so any layer
 *  (loader, controller, shell) can report a failure without an import cycle. */

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function showErrorDialog(title: string, message: string): void {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-card" style="max-width:440px">
    <div class="modal-head"><span>${escapeHtml(title)}</span><button class="modal-close" title="Close">✕</button></div>
    <div class="modal-body"><p style="margin:0 0 14px">${escapeHtml(message)}</p>
      <div class="modal-actions"><button class="modal-btn" data-r="ok">OK</button></div>
    </div></div>`;
  const close = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' || e.key === 'Enter') close();
  };
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector('.modal-close')?.addEventListener('click', close);
  overlay.querySelector('[data-r="ok"]')?.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
}
