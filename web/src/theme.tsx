import { useCallback, useEffect, useState, type ReactElement } from 'react';

/**
 * Three ways to light the terrarium. `system` is the default and isn't a look
 * of its own — it's a standing subscription to whatever the OS is doing, so a
 * Mac that dims itself at sunset dims this too, live, without a reload.
 */
export type ThemeChoice = 'light' | 'dark' | 'system';

const THEME_KEY = 'terrarium.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function loadChoice(): ThemeChoice {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    // Private windows and locked-down profiles can refuse storage; the terrarium
    // still has to open, it just forgets the preference between visits.
  }
  return 'system';
}

function resolve(choice: ThemeChoice): 'light' | 'dark' {
  if (choice !== 'system') return choice;
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

const OPTIONS: { id: ThemeChoice; label: string; title: string; icon: () => React.ReactElement }[] = [
  { id: 'light', label: 'Light', title: 'Daylight', icon: SunIcon },
  { id: 'dark', label: 'Dark', title: 'Lamplight', icon: MoonIcon },
  { id: 'system', label: 'System', title: 'Follow the system', icon: AutoIcon },
];

export function ThemePill() {
  const [choice, setChoice] = useState<ThemeChoice>(loadChoice);

  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset.theme = resolve(choice);
    };
    apply();
    if (choice !== 'system') return;
    // Only worth listening while following along — a fixed choice ignores the OS.
    const media = window.matchMedia(DARK_QUERY);
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [choice]);

  const pick = useCallback((next: ThemeChoice) => {
    setChoice(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // See loadChoice: an unwritable store costs the memory, not the mode.
    }
  }, []);

  return (
    <div className="theme-pill" data-choice={choice} role="radiogroup" aria-label="Colour theme">
      <span className="theme-thumb" aria-hidden="true" />
      {OPTIONS.map(({ id, label, title, icon: Icon }) => (
        <button
          key={id}
          type="button"
          className="theme-opt"
          role="radio"
          aria-checked={choice === id}
          title={title}
          aria-label={`${label} — ${title.toLowerCase()}`}
          onClick={() => pick(id)}
        >
          <Icon />
          <span className="sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}

/* The glyphs: one stroke weight, one viewbox, drawn in currentColor so the
   active segment picks up its moss without a second copy of each icon. */

function SunIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.1v1.5M8 13.4v1.5M14.9 8h-1.5M2.6 8H1.1M12.88 3.12l-1.06 1.06M4.18 11.82l-1.06 1.06M12.88 12.88l-1.06-1.06M4.18 4.18L3.12 3.12" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
      <path d="M13.4 9.9A5.9 5.9 0 0 1 6.1 2.6 5.9 5.9 0 1 0 13.4 9.9Z" />
    </svg>
  );
}

/* Half lit, half dark, with the diameter drawn in: at a glance it is one dial
   showing both states at once, which is what "follow the system" means. */
function AutoIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="8" cy="8" r="5.8" />
      <path d="M8 2.2a5.8 5.8 0 0 0 0 11.6z" fill="currentColor" stroke="none" />
      <path d="M8 2.2v11.6" />
    </svg>
  );
}
