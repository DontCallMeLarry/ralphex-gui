import { useEffect, useRef, type ReactNode } from 'react';

/**
 * The scrim every modal sits on, and the one place the two ways out of a modal
 * are written down: click the dark, or press Escape. Both mean "put it back the
 * way it was" — a dialog dismissed this way never does the thing it was asking
 * about, so dismissing is always the safe key to reach for.
 *
 * The click has to both start and end on the scrim. Without that, dragging to
 * select a line of the brief and releasing past the dialog's edge counts as a
 * click on the scrim, and the modal closes underneath the selection.
 */
/** Open modals, innermost last: only that one answers to Escape. */
const stack: object[] = [];

export function Overlay({
  onDismiss,
  className,
  children,
}: {
  /** Called for a scrim click or Escape. Pass a no-op to hold the modal open. */
  onDismiss: () => void;
  className?: string;
  children: ReactNode;
}) {
  const fromScrim = useRef(false);
  // Held on a ref so the listener below can be registered once. A modal that
  // re-registered whenever its parent re-rendered would keep jumping to the top
  // of the stack, and Escape would close the wrong one.
  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    const self = {};
    stack.push(self);
    const onKey = (event: KeyboardEvent) => {
      // One Escape closes one modal. A breakdown opened from inside the bench
      // must not take the bench with it on the way out.
      if (event.key === 'Escape' && stack[stack.length - 1] === self) dismiss.current();
    };
    // On the document, not the scrim: the modal's own fields hold focus, and
    // Escape has to work from inside them too.
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const at = stack.indexOf(self);
      if (at !== -1) stack.splice(at, 1);
    };
  }, []);

  return (
    <div
      className={`overlay${className ? ` ${className}` : ''}`}
      role="presentation"
      onMouseDown={(event) => {
        fromScrim.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && fromScrim.current) onDismiss();
      }}
    >
      {children}
    </div>
  );
}
