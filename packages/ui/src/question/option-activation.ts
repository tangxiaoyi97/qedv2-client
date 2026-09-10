/** A scroll, drag or text selection inside an answer is reading, not a pick.
 * Leave native panning/selection untouched and suppress only its trailing click.
 * Keyboard activation (including the radio-group helper) stays native. */
export function createOptionActivation() {
  let gesture: { pointerId: number; x: number; y: number; moved: boolean } | undefined;

  function pointerDown(event: PointerEvent): void {
    if (event.isPrimary === false || event.button !== 0) return;
    gesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  }

  function pointerMove(event: PointerEvent): void {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) >= 8) gesture.moved = true;
  }

  function pointerCancel(): void {
    if (gesture) gesture.moved = true;
  }

  function accepts(event: MouseEvent): boolean {
    if (event.detail === 0) return true;
    if (gesture?.moved) {
      gesture = undefined;
      return false;
    }
    gesture = undefined;
    const selection = window.getSelection();
    const option = event.currentTarget as HTMLElement | null;
    return !selection || selection.isCollapsed || !option
      || !(option.contains(selection.anchorNode) || option.contains(selection.focusNode));
  }

  return { pointerDown, pointerMove, pointerCancel, accepts };
}
