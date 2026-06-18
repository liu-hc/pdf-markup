import type { Markup } from '../state/types';

/** Draw order is array order within a page: earlier = drawn first = behind,
 *  later = drawn on top. These helpers reorder a markup among the other
 *  markups *on the same page* while leaving other pages' markups untouched. */

/** Ids of the markups on `pageIndex`, in back→front (array) order. */
export function pageOrder(markups: Markup[], pageIndex: number): string[] {
  return markups.filter((m) => m.pageIndex === pageIndex).map((m) => m.id);
}

/** Rebuild the full markup list so that `pageIndex`'s markups follow
 *  `orderedIds` (back→front), keeping every other markup in place. */
export function applyPageOrder(markups: Markup[], pageIndex: number, orderedIds: string[]): Markup[] {
  const byId = new Map(markups.filter((m) => m.pageIndex === pageIndex).map((m) => [m.id, m]));
  const ordered = orderedIds.map((id) => byId.get(id)).filter((m): m is Markup => !!m);
  let i = 0;
  return markups.map((m) => (m.pageIndex === pageIndex ? ordered[i++]! : m));
}

/** Move `id` to the back (drawn first) among its page's markups. */
export function moveToBack(markups: Markup[], id: string): Markup[] {
  const m = markups.find((x) => x.id === id);
  if (!m) return markups;
  const order = pageOrder(markups, m.pageIndex).filter((x) => x !== id);
  order.unshift(id);
  return applyPageOrder(markups, m.pageIndex, order);
}

/** Move `id` to the front (drawn last / on top) among its page's markups. */
export function moveToFront(markups: Markup[], id: string): Markup[] {
  const m = markups.find((x) => x.id === id);
  if (!m) return markups;
  const order = pageOrder(markups, m.pageIndex).filter((x) => x !== id);
  order.push(id);
  return applyPageOrder(markups, m.pageIndex, order);
}

/** Nudge `id` one step in draw order (dir -1 = back, +1 = front). */
export function nudgeOrder(markups: Markup[], id: string, dir: -1 | 1): Markup[] {
  const m = markups.find((x) => x.id === id);
  if (!m) return markups;
  const order = pageOrder(markups, m.pageIndex);
  const pos = order.indexOf(id);
  const target = pos + dir;
  if (pos < 0 || target < 0 || target >= order.length) return markups;
  [order[pos], order[target]] = [order[target]!, order[pos]!];
  return applyPageOrder(markups, m.pageIndex, order);
}
