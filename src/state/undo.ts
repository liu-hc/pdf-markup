import { replaceMarkups } from './store';
import { getActiveDoc } from './store';
import type { Markup } from './types';

export interface Command {
  label: string;
  undo: () => void;
  redo: () => void;
}

const undoStack: Command[] = [];
const redoStack: Command[] = [];
const MAX_UNDO = 100;

export function pushCommand(cmd: Command): void {
  undoStack.push(cmd);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
}

export function undo(): boolean {
  const cmd = undoStack.pop();
  if (!cmd) return false;
  cmd.undo();
  redoStack.push(cmd);
  return true;
}

export function redo(): boolean {
  const cmd = redoStack.pop();
  if (!cmd) return false;
  cmd.redo();
  undoStack.push(cmd);
  return true;
}

export function canUndo(): boolean {
  return undoStack.length > 0;
}

export function canRedo(): boolean {
  return redoStack.length > 0;
}

/** Drop all history. Called after flatten: undoing past a flatten would
 *  resurrect markups on top of the pixels already baked into the page. */
export function clearHistory(): void {
  undoStack.length = 0;
  redoStack.length = 0;
}

export function recordMarkupChange(label: string, before: Markup[], after: Markup[]): void {
  pushCommand({
    label,
    undo: () => replaceMarkups(before),
    redo: () => replaceMarkups(after),
  });
}

export function snapshotMarkups(): Markup[] {
  const doc = getActiveDoc();
  return doc ? [...doc.markups] : [];
}

export function applyMarkupChange(label: string, next: Markup[]): void {
  const before = snapshotMarkups();
  replaceMarkups(next);
  recordMarkupChange(label, before, next);
}
