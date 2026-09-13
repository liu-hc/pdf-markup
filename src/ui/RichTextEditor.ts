/**
 * In-place rich text editor for text boxes and callouts.
 *
 * A textarea cannot show mixed sizes, weights or list markers, so this is a
 * contenteditable whose direct children are one <div> per paragraph. Each
 * paragraph carries its own formatting, which is what makes a heading line, a
 * numbered list and a body line possible inside one box.
 *
 * The split of responsibilities matches the data model: the toolbar's left
 * half acts on the SELECTED PARAGRAPHS (size, bold, italic, underline, list,
 * indent, align) and its right half on the WHOLE BOX (line spacing, vertical
 * alignment, margin).
 */
import type { ListStyle, TextParagraph } from '../state/types';
import { LINE_SPACING_OPTIONS, TEXT_MARGIN_OPTIONS, TEXT_SIZE_OPTIONS } from '../state/types';
import { INDENT_STEP, listMarker } from '../markups/textLayout';

/** Box-level formatting the toolbar can change. */
export interface BoxFormatting {
  lineSpacing: number;
  valign: 'top' | 'middle' | 'bottom';
  margin: number;
}

export interface RichEditorOptions {
  /** Element the editor is positioned inside (the PageView element). */
  host: HTMLElement;
  /** CSS px per page point. */
  scale: number;
  leftPx: number;
  topPx: number;
  widthPx: number;
  heightPx: number;
  paragraphs: TextParagraph[];
  box: BoxFormatting;
  /** Box font defaults a paragraph inherits when it sets nothing. */
  fontSize: number;
  fontFamily: string;
  color: string;
  /** Blend into the markup beneath (callout box) instead of showing a panel. */
  transparent?: boolean;
  onCommit: (paragraphs: TextParagraph[], wPx: number, hPx: number, box: BoxFormatting) => void;
  onCancel: () => void;
}

const ALIGN_ICONS: Record<'left' | 'center' | 'right', string> = {
  left: `<svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="1.5" y1="2.5" x2="10.5" y2="2.5"/><line x1="1.5" y1="6" x2="7" y2="6"/><line x1="1.5" y1="9.5" x2="9" y2="9.5"/></svg>`,
  center: `<svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="1.5" y1="2.5" x2="10.5" y2="2.5"/><line x1="3.5" y1="6" x2="8.5" y2="6"/><line x1="2.5" y1="9.5" x2="9.5" y2="9.5"/></svg>`,
  right: `<svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="1.5" y1="2.5" x2="10.5" y2="2.5"/><line x1="5" y1="6" x2="10.5" y2="6"/><line x1="3" y1="9.5" x2="10.5" y2="9.5"/></svg>`,
};

const VALIGN_ICONS: Record<'top' | 'middle' | 'bottom', string> = {
  top: `<svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="1.5" y1="1.5" x2="10.5" y2="1.5"/><path d="M6 10.5V4.5M6 4.5l-2 2M6 4.5l2 2"/></svg>`,
  middle: `<svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="1.5" y1="6" x2="10.5" y2="6"/><path d="M6 1.5v2.2M6 10.5V8.3"/></svg>`,
  bottom: `<svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="1.5" y1="10.5" x2="10.5" y2="10.5"/><path d="M6 1.5v6M6 7.5l-2-2M6 7.5l2-2"/></svg>`,
};

const LIST_ICONS: Record<Exclude<ListStyle, 'none'>, string> = {
  bullet: `<svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="2" cy="3" r="1.2" fill="currentColor" stroke="none"/><circle cx="2" cy="9" r="1.2" fill="currentColor" stroke="none"/><line x1="5" y1="3" x2="10.5" y2="3"/><line x1="5" y1="9" x2="10.5" y2="9"/></svg>`,
  circle: `<svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="2" cy="3" r="1.2" fill="none"/><circle cx="2" cy="9" r="1.2" fill="none"/><line x1="5" y1="3" x2="10.5" y2="3"/><line x1="5" y1="9" x2="10.5" y2="9"/></svg>`,
  number: `<svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><text x="0" y="5" font-size="5" fill="currentColor" stroke="none">1</text><text x="0" y="11" font-size="5" fill="currentColor" stroke="none">2</text><line x1="5" y1="3" x2="10.5" y2="3"/><line x1="5" y1="9" x2="10.5" y2="9"/></svg>`,
  letter: `<svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><text x="0" y="5" font-size="5" fill="currentColor" stroke="none">a</text><text x="0" y="11" font-size="5" fill="currentColor" stroke="none">b</text><line x1="5" y1="3" x2="10.5" y2="3"/><line x1="5" y1="9" x2="10.5" y2="9"/></svg>`,
};

/** Read a paragraph element back into the data model. Only what actually
 *  differs from the box default is recorded, so a plain paragraph stays a
 *  bare `{ text }` and the saved metadata does not bloat. */
function readParagraph(el: HTMLElement, fontSize: number): TextParagraph {
  const p: TextParagraph = { text: el.innerText.replace(/\n+$/, '') };
  const size = Number(el.dataset.size);
  if (Number.isFinite(size) && size > 0 && size !== fontSize) p.size = size;
  if (el.dataset.bold === '1') p.bold = true;
  if (el.dataset.italic === '1') p.italic = true;
  if (el.dataset.underline === '1') p.underline = true;
  const align = el.dataset.align as TextParagraph['align'] | undefined;
  if (align && align !== 'left') p.align = align;
  const indent = Number(el.dataset.indent) || 0;
  if (indent > 0) p.indent = indent;
  const list = (el.dataset.list as ListStyle) || 'none';
  if (list !== 'none') p.list = list;
  return p;
}

export function spawnRichTextEditor(opts: RichEditorOptions): () => void {
  const { scale } = opts;
  const root = document.createElement('div');
  root.className = 'rich-text-editor' + (opts.transparent ? ' rich-text-editor--bare' : '');
  root.contentEditable = 'true';
  root.spellcheck = false;
  root.style.left = `${opts.leftPx}px`;
  root.style.top = `${opts.topPx}px`;
  root.style.width = `${opts.widthPx}px`;
  root.style.minHeight = `${opts.heightPx}px`;
  root.style.fontFamily = `"${opts.fontFamily}", sans-serif`;
  root.style.color = opts.color;

  const boxFmt: BoxFormatting = { ...opts.box };

  /** Push the box-level values onto the editor shell. */
  const applyBox = (): void => {
    root.style.lineHeight = String(boxFmt.lineSpacing);
    root.style.padding = `${boxFmt.margin * scale}px`;
    root.style.justifyContent =
      boxFmt.valign === 'middle' ? 'center' : boxFmt.valign === 'bottom' ? 'flex-end' : 'flex-start';
  };

  /** Push a paragraph's data-* values onto its own styling. */
  const applyPara = (el: HTMLElement): void => {
    const size = Number(el.dataset.size) || opts.fontSize;
    const indent = Number(el.dataset.indent) || 0;
    el.style.fontSize = `${size * scale}px`;
    el.style.fontWeight = el.dataset.bold === '1' ? '700' : '400';
    el.style.fontStyle = el.dataset.italic === '1' ? 'italic' : 'normal';
    el.style.textDecoration = el.dataset.underline === '1' ? 'underline' : 'none';
    el.style.textAlign = el.dataset.align || 'left';
    el.style.paddingLeft = `${indent * INDENT_STEP * scale}px`;
    // A list item hangs: the marker sits in the padding, text lines up after it
    const list = (el.dataset.list as ListStyle) || 'none';
    el.classList.toggle('rtp-list', list !== 'none');
    el.style.setProperty('--marker-gap', `${size * 0.45 * scale}px`);
  };

  /** Every direct child is a paragraph; wrap anything the browser left bare. */
  const paragraphs = (): HTMLElement[] => {
    for (const node of Array.from(root.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        const d = document.createElement('div');
        d.className = 'rtp';
        d.textContent = node.textContent ?? '';
        root.replaceChild(d, node);
      } else if (node instanceof HTMLElement && !node.classList.contains('rtp')) {
        node.className = 'rtp';
      }
    }
    if (!root.childNodes.length) root.appendChild(newPara({}));
    return Array.from(root.children) as HTMLElement[];
  };

  const newPara = (attrs: Partial<Record<string, string>>, text = ''): HTMLElement => {
    const d = document.createElement('div');
    d.className = 'rtp';
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined) d.dataset[k] = v;
    d.textContent = text;
    applyPara(d);
    return d;
  };

  /** Recompute list markers. Numbering restarts when the run breaks, matching
   *  the renderer exactly, so the editor previews the real markers. */
  const renumber = (): void => {
    let runStyle: ListStyle = 'none';
    let runIndent = -1;
    let n = 0;
    for (const el of paragraphs()) {
      const list = (el.dataset.list as ListStyle) || 'none';
      const indent = Number(el.dataset.indent) || 0;
      if (list === 'none') {
        runStyle = 'none';
        runIndent = -1;
        n = 0;
      } else if (list === runStyle && indent === runIndent) {
        n += 1;
      } else {
        runStyle = list;
        runIndent = indent;
        n = 1;
      }
      el.dataset.marker = listMarker(list, n);
      applyPara(el);
    }
  };

  // ── seed the content
  for (const p of opts.paragraphs.length ? opts.paragraphs : [{ text: '' }]) {
    root.appendChild(
      newPara(
        {
          size: p.size !== undefined ? String(p.size) : undefined,
          bold: p.bold ? '1' : undefined,
          italic: p.italic ? '1' : undefined,
          underline: p.underline ? '1' : undefined,
          align: p.align,
          indent: p.indent ? String(p.indent) : undefined,
          list: p.list && p.list !== 'none' ? p.list : undefined,
        },
        p.text,
      ),
    );
  }
  applyBox();
  renumber();

  // ── which paragraphs the caret or selection touches
  const selectedParas = (): HTMLElement[] => {
    const sel = window.getSelection();
    const all = paragraphs();
    if (!sel || sel.rangeCount === 0) return all.slice(0, 1);
    const range = sel.getRangeAt(0);
    const hit = all.filter((el) => range.intersectsNode(el));
    return hit.length ? hit : all.slice(0, 1);
  };

  let bar: HTMLElement | null = null;
  const syncers: (() => void)[] = [];

  const editParas = (fn: (el: HTMLElement) => void): void => {
    selectedParas().forEach(fn);
    renumber();
    syncers.forEach((f) => f());
    root.focus();
  };

  // ── toolbar
  bar = document.createElement('div');
  bar.className = 'text-format-bar';
  for (const ev of ['pointermove', 'pointerup', 'dblclick', 'wheel', 'contextmenu']) {
    bar.addEventListener(ev, (e) => e.stopPropagation());
  }
  // Buttons must never take focus — losing it commits the edit
  bar.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    if ((e.target as HTMLElement).tagName !== 'SELECT') e.preventDefault();
  });

  const addBtn = (html: string, title: string, isOn: () => boolean, onClick: () => void): void => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tfb-btn';
    b.innerHTML = html;
    b.title = title;
    b.addEventListener('click', () => {
      onClick();
      syncers.forEach((f) => f());
    });
    syncers.push(() => b.classList.toggle('on', isOn()));
    bar!.appendChild(b);
  };
  const addSep = (): void => {
    const sp = document.createElement('span');
    sp.className = 'tfb-sep';
    bar!.appendChild(sp);
  };
  /** True when every selected paragraph already has this flag. */
  const allHave = (test: (el: HTMLElement) => boolean): boolean => {
    const sel = selectedParas();
    return sel.length > 0 && sel.every(test);
  };
  const toggleFlag = (key: 'bold' | 'italic' | 'underline'): void => {
    const on = allHave((el) => el.dataset[key] === '1');
    editParas((el) => {
      if (on) delete el.dataset[key];
      else el.dataset[key] = '1';
    });
  };

  // Paragraph size — the control that makes mixed sizes in one box possible
  const sizeSel = document.createElement('select');
  sizeSel.className = 'tfb-size';
  sizeSel.title = 'Text size for the selected paragraphs';
  sizeSel.innerHTML = TEXT_SIZE_OPTIONS.map((v) => `<option value="${v}">${v}</option>`).join('');
  sizeSel.addEventListener('change', () => {
    const v = sizeSel.value;
    editParas((el) => (el.dataset.size = v));
  });
  syncers.push(() => {
    const sel = selectedParas();
    const first = sel[0];
    sizeSel.value = String((first && Number(first.dataset.size)) || opts.fontSize);
  });
  bar.appendChild(sizeSel);

  addBtn('<b>B</b>', 'Bold', () => allHave((el) => el.dataset.bold === '1'), () => toggleFlag('bold'));
  addBtn('<i>I</i>', 'Italic', () => allHave((el) => el.dataset.italic === '1'), () => toggleFlag('italic'));
  addBtn('<u>U</u>', 'Underline', () => allHave((el) => el.dataset.underline === '1'), () => toggleFlag('underline'));
  addSep();

  // Lists
  for (const style of ['bullet', 'circle', 'number', 'letter'] as const) {
    const label = { bullet: 'Bulleted list', circle: 'Circle list', number: 'Numbered list', letter: 'Lettered list' }[style];
    addBtn(
      LIST_ICONS[style],
      label,
      () => allHave((el) => el.dataset.list === style),
      () => {
        const on = allHave((el) => el.dataset.list === style);
        editParas((el) => {
          if (on) delete el.dataset.list;
          else el.dataset.list = style;
        });
      },
    );
  }
  addSep();
  addBtn('⇤', 'Decrease indent', () => false, () =>
    editParas((el) => {
      const v = Math.max(0, (Number(el.dataset.indent) || 0) - 1);
      if (v) el.dataset.indent = String(v);
      else delete el.dataset.indent;
    }),
  );
  addBtn('⇥', 'Increase indent', () => allHave((el) => (Number(el.dataset.indent) || 0) > 0), () =>
    editParas((el) => (el.dataset.indent = String(Math.min(8, (Number(el.dataset.indent) || 0) + 1)))),
  );
  addSep();
  for (const a of ['left', 'center', 'right'] as const) {
    addBtn(ALIGN_ICONS[a], `Align ${a}`, () => allHave((el) => (el.dataset.align || 'left') === a), () =>
      editParas((el) => {
        if (a === 'left') delete el.dataset.align;
        else el.dataset.align = a;
      }),
    );
  }
  addSep();

  // ── box-level controls
  for (const v of ['top', 'middle', 'bottom'] as const) {
    addBtn(VALIGN_ICONS[v], `Vertical align ${v}`, () => boxFmt.valign === v, () => {
      boxFmt.valign = v;
      applyBox();
    });
  }
  const spacing = document.createElement('select');
  spacing.className = 'tfb-spacing';
  spacing.title = 'Line spacing (whole box)';
  spacing.innerHTML = LINE_SPACING_OPTIONS.map(
    (v) => `<option value="${v}" ${v === boxFmt.lineSpacing ? 'selected' : ''}>${v === 1 ? '1.0' : v}×</option>`,
  ).join('');
  spacing.addEventListener('change', () => {
    boxFmt.lineSpacing = Number(spacing.value);
    applyBox();
    root.focus();
  });
  bar.appendChild(spacing);

  const margin = document.createElement('select');
  margin.className = 'tfb-margin';
  margin.title = 'Inner margin (whole box)';
  margin.innerHTML = TEXT_MARGIN_OPTIONS.map(
    (v) => `<option value="${v}" ${v === boxFmt.margin ? 'selected' : ''}>${v}pt</option>`,
  ).join('');
  margin.addEventListener('change', () => {
    boxFmt.margin = Number(margin.value);
    applyBox();
    root.focus();
  });
  bar.appendChild(margin);

  bar.style.left = `${opts.leftPx}px`;
  bar.style.top = `${Math.max(2, opts.topPx - 34)}px`;

  // ── behaviour
  let done = false;
  const finish = (commit: boolean): void => {
    if (done) return;
    done = true;
    const paras = paragraphs().map((el) => readParagraph(el, opts.fontSize));
    const w = root.offsetWidth;
    const h = root.offsetHeight;
    root.remove();
    bar?.remove();
    document.removeEventListener('selectionchange', onSelChange);
    const hasText = paras.some((p) => p.text.trim().length);
    if (commit && hasText) opts.onCommit(paras, w, h, boxFmt);
    else opts.onCancel();
  };

  const onSelChange = (): void => {
    if (document.activeElement === root) syncers.forEach((f) => f());
  };
  document.addEventListener('selectionchange', onSelChange);

  root.addEventListener('keydown', (e) => {
    e.stopPropagation(); // the app's own shortcuts must not fire while typing
    if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      finish(true);
      return;
    }
    if (e.key === 'Enter') {
      // Carry the current paragraph's formatting onto the new one, so a list
      // keeps listing and a heading size does not leak into the body text
      // unless the user asked for it.
      e.preventDefault();
      const cur = selectedParas()[0];
      const attrs: Record<string, string> = {};
      if (cur) {
        for (const k of ['size', 'bold', 'italic', 'underline', 'align', 'indent', 'list'] as const) {
          const v = cur.dataset[k];
          if (v !== undefined) attrs[k] = v;
        }
      }
      const next = newPara(attrs);
      if (cur?.nextSibling) root.insertBefore(next, cur.nextSibling);
      else root.appendChild(next);
      renumber();
      const range = document.createRange();
      range.setStart(next, 0);
      range.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      syncers.forEach((f) => f());
    }
  });
  // Keep the structure sane after typing, deleting or pasting
  root.addEventListener('input', () => renumber());
  root.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain') ?? '';
    document.execCommand('insertText', false, text);
  });
  root.addEventListener('blur', () => finish(true));
  for (const ev of ['pointerdown', 'pointerup', 'pointermove', 'dblclick', 'wheel', 'contextmenu']) {
    root.addEventListener(ev, (e) => e.stopPropagation());
  }

  opts.host.appendChild(root);
  opts.host.appendChild(bar);
  root.focus();
  // Caret at the end of the last paragraph
  const sel = window.getSelection();
  const last = root.lastElementChild;
  if (sel && last) {
    const range = document.createRange();
    range.selectNodeContents(last);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  syncers.forEach((f) => f());

  return () => finish(false);
}
