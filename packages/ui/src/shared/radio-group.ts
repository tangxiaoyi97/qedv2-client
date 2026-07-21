/**
 * Arrow-key navigation for role="radiogroup" containers (WAI-ARIA radio
 * pattern): Left/Up moves backwards, Right/Down forwards — moving focus
 * also selects, wrapping at both ends. Attach as @keydown on the element
 * carrying role="radiogroup":
 *
 *   <div role="radiogroup" @keydown="onRadioGroupKeydown">
 */
export function onRadioGroupKeydown(ev: KeyboardEvent): void {
  if (
    ev.key !== 'ArrowLeft' &&
    ev.key !== 'ArrowRight' &&
    ev.key !== 'ArrowUp' &&
    ev.key !== 'ArrowDown'
  ) {
    return;
  }
  const group = ev.currentTarget as HTMLElement | null;
  if (!group) return;
  const items = Array.from(
    group.querySelectorAll<HTMLElement>('[role="radio"]:not([disabled])'),
  );
  const idx = items.indexOf(document.activeElement as HTMLElement);
  if (idx === -1) return;
  ev.preventDefault();
  const forward = ev.key === 'ArrowRight' || ev.key === 'ArrowDown';
  const next = forward ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
  const el = items[next];
  el?.focus();
  el?.click();
}
