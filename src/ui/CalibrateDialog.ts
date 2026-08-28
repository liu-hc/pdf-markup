/**
 * Calibrate dialog — asks for the real-world length of the line just drawn,
 * as separate FEET and INCHES fields.
 *
 * This deliberately replaces window.prompt(). A prompt is a single free-text
 * box that has to be parsed, and worse, Chrome suppresses it outright once a
 * page has had a dialog dismissed (or in an automated context) — it then
 * returns null with nothing shown, so calibration silently did nothing and
 * looked like the second click had not registered.
 *
 * Lives in its own module rather than AppShell so tools/controller.ts can
 * import it without creating an import cycle.
 */

/** Inches from a field that may hold "6", "6.5", "1/2" or "6 1/2". */
export function parseInchField(raw: string): number {
  const s = raw.trim();
  if (!s) return 0;
  let total = 0;
  for (const part of s.split(/\s+/)) {
    if (part.includes('/')) {
      const [n, d] = part.split('/');
      const num = Number(n);
      const den = Number(d);
      if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return NaN;
      total += num / den;
    } else {
      const v = Number(part);
      if (!Number.isFinite(v)) return NaN;
      total += v;
    }
  }
  return total;
}

/**
 * Resolves to the total length in INCHES, or null if cancelled.
 *
 * `measuredPts` is the length of the drawn line in page points, shown as
 * context so it is obvious which line is being described.
 */
export function showCalibrateDialog(measuredPts: number): Promise<number | null> {
  return new Promise((resolve) => {
    let done = false;
    document.querySelector('.modal-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal-card" style="max-width:400px">
      <div class="modal-head"><span>Calibrate scale</span><button class="modal-close" title="Close">&#10005;</button></div>
      <div class="modal-body">
        <p class="cal-intro">How long is the line you just drew, in the real world?</p>
        <div class="cal-fields">
          <label class="cal-field">Feet
            <input type="number" class="cal-feet" min="0" step="1" value="" inputmode="decimal" autocomplete="off"></label>
          <label class="cal-field">Inches
            <input type="text" class="cal-inches" value="" placeholder="0" inputmode="decimal" autocomplete="off"
                   title="Whole, decimal or fraction — 6, 6.5 or 6 1/2"></label>
        </div>
        <p class="cal-measured">Measured on the sheet: ${measuredPts.toFixed(1)} pt</p>
        <p class="cal-error" role="alert"></p>
        <div class="modal-actions">
          <button class="modal-btn-ghost" data-cal="cancel">Cancel</button>
          <button class="modal-btn" data-cal="ok">Set Scale</button>
        </div>
      </div>
    </div>`;

    const finish = (value: number | null): void => {
      if (done) return;
      done = true;
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };

    const feet = overlay.querySelector<HTMLInputElement>('.cal-feet')!;
    const inches = overlay.querySelector<HTMLInputElement>('.cal-inches')!;
    const error = overlay.querySelector<HTMLElement>('.cal-error')!;

    const submit = (): void => {
      const ft = feet.value.trim() === '' ? 0 : Number(feet.value);
      const inch = parseInchField(inches.value);
      if (!Number.isFinite(ft) || ft < 0 || !Number.isFinite(inch) || inch < 0) {
        error.textContent = 'Enter a number of feet and/or inches.';
        return;
      }
      const total = ft * 12 + inch;
      if (total <= 0) {
        error.textContent = 'The length has to be greater than zero.';
        return;
      }
      finish(total);
    };

    const onKey = (e: KeyboardEvent): void => {
      // Captured, so the app's own shortcuts never see these keys
      e.stopPropagation();
      if (e.key === 'Escape') finish(null);
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    };

    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) finish(null);
    });
    overlay.querySelector('.modal-close')?.addEventListener('click', () => finish(null));
    overlay.querySelector('[data-cal="cancel"]')?.addEventListener('click', () => finish(null));
    overlay.querySelector('[data-cal="ok"]')?.addEventListener('click', submit);
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(overlay);
    feet.focus();
    feet.select();
  });
}
