import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** The width a card needs before it starts squeezing its own contents. */
const MIN_COLUMN = 430;
/** Has to match the gap in `.specimen-grid` — it's part of the column maths. */
const GAP = 12;

/**
 * Cards in independent columns instead of grid rows. Grid rows share a top
 * edge, so one card growing — dragging its notes open to read them all — shoved
 * every card on the rows below it down the page. In columns, a taller card only
 * moves the cards under it in its own column.
 *
 * A card's column is decided by its position and nothing else (index % count).
 * Packing by measured height would even the columns out, but then a card would
 * hop to another column the moment you opened its notes, which is the jumping
 * around this is here to stop.
 */
export function CardColumns<T>({
  items,
  itemKey,
  children,
}: {
  items: T[];
  itemKey: (item: T) => string;
  children: (item: T) => ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(1);

  // Measured off the container rather than the viewport, so the count follows
  // the space the cards actually have — the same thing `auto-fill` was doing.
  // Layout effect, not a plain one: the first count lands before paint.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      const fits = Math.floor((host.clientWidth + GAP) / (MIN_COLUMN + GAP));
      setColumns(Math.max(1, fits));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const lanes: T[][] = Array.from({ length: columns }, () => []);
  items.forEach((item, i) => lanes[i % columns].push(item));

  return (
    <div className="specimen-grid" ref={hostRef}>
      {lanes.map((lane, i) => (
        <div className="specimen-column" key={i}>
          {lane.map((item) => (
            <Fragment key={itemKey(item)}>{children(item)}</Fragment>
          ))}
        </div>
      ))}
    </div>
  );
}
