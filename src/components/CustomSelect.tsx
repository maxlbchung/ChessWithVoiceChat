import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Native <select> renders its option list as an OS-level popup that CSS
// (including custom cursor URLs) can't touch. This is a drop-in replacement
// rendered entirely in the DOM, so every hover/click inside the open list
// inherits the app's custom cursor.

export type CustomSelectOption<T extends string> = {
  value: T;
  label: string;
};

type Props<T extends string> = {
  value: T;
  options: CustomSelectOption<T>[];
  onChange: (next: T) => void;
  className?: string;
  ['aria-label']?: string;
  // Optional: render a non-default visual for the trigger (e.g. just the
  // label without the chevron). Defaults to a normal `.free-play-select`.
  triggerClassName?: string;
  // Pulled through to <button> data attributes so the existing global
  // `[data-no-sfx]` SFX-suppression hook keeps working.
  ['data-no-sfx']?: boolean;
};

export function CustomSelect<T extends string>({
  value,
  options,
  onChange,
  className,
  triggerClassName,
  'aria-label': ariaLabel,
  'data-no-sfx': dataNoSfx,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  // The popover is portalled to <body> with fixed positioning so it's not
  // trapped by ancestor stacking contexts (a chess piece SVG kept stealing
  // pointer events when this was absolute-inside-the-flow).
  // `openUp` flips the popover to grow upward from the trigger's top edge
  // when there's not enough room below — keeps long lists (e.g. the 9-hero
  // picker) inside the viewport rather than spilling off the bottom.
  const [coords, setCoords] = useState<{
    top: number | undefined;
    bottom: number | undefined;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const update = () => {
      const r = wrapRef.current!.getBoundingClientRect();
      const margin = 8;
      const spaceBelow = window.innerHeight - r.bottom - margin;
      const spaceAbove = r.top - margin;
      // Prefer below; flip up only when below is genuinely cramped and the
      // above side is bigger. The 160 px threshold roughly fits 5 options.
      const openUp = spaceBelow < 160 && spaceAbove > spaceBelow;
      const maxHeight = Math.max(80, openUp ? spaceAbove : spaceBelow);
      setCoords({
        top:    openUp ? undefined : r.bottom + 4,
        bottom: openUp ? window.innerHeight - r.top + 4 : undefined,
        left: r.left,
        width: r.width,
        maxHeight,
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  // Outside-click closes the popover. Checks both the wrap and the portalled
  // popover since the popover lives outside the wrap in DOM order.
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div className="custom-select-wrap" ref={wrapRef}>
      <button
        type="button"
        className={triggerClassName ?? className ?? 'free-play-select'}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-no-sfx={dataNoSfx}
        onClick={() => setOpen((v) => !v)}
      >
        {current?.label ?? value}
      </button>
      {open && coords && createPortal(
        <div
          ref={popRef}
          className="custom-select-popover"
          role="listbox"
          style={{
            position: 'fixed',
            top: coords.top,
            bottom: coords.bottom,
            left: coords.left,
            width: coords.width,
            // Overrides the CSS `max-height: 18rem` rule so the popover
            // never spills past the viewport edge.
            maxHeight: coords.maxHeight,
          }}
        >
          {options.map((opt) => {
            const isSelected = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                className={`custom-select-option${isSelected ? ' selected' : ''}`}
                role="option"
                aria-selected={isSelected}
                data-no-sfx={dataNoSfx}
                title={opt.label}
                onClick={() => { onChange(opt.value); setOpen(false); }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
