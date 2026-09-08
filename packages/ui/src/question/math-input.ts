/** Keep editing native: never rewrite decimal separators, pasted formulas or selection. */
export function onMathInputKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter') return;
  // The Enter that accepts an IME candidate must never submit a practice answer.
  if (event.isComposing || event.keyCode === 229) {
    event.stopPropagation();
    return;
  }
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const input = event.target as HTMLInputElement;
  const group = input.closest('[data-answer-fields]');
  if (!group) return;
  const fields = [...group.querySelectorAll<HTMLInputElement>('input:not([disabled]):not([readonly])')];
  const next = fields[fields.indexOf(input) + 1];
  if (!next) return;
  event.preventDefault();
  event.stopPropagation();
  next.focus();
}
