'use client';

import { useEffect, useState } from 'react';

type Choice = 'light' | 'dark' | 'system';

const KEY = 'buhc-theme';
const OPTIONS: { value: Choice; label: string; icon: string }[] = [
  { value: 'light', label: 'Light', icon: '☀' },
  { value: 'dark', label: 'Dark', icon: '☾' },
  { value: 'system', label: 'System', icon: '◐' },
];

function apply(choice: Choice): void {
  const dark =
    choice === 'dark' ||
    (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

export function ThemeToggle() {
  // Server and first client render agree on `null`, so there is no hydration
  // mismatch; the stored choice is adopted in an effect. ThemeScript has already
  // painted the right colours by then, so nothing visibly changes.
  const [choice, setChoice] = useState<Choice | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem(KEY);
    setChoice(stored === 'light' || stored === 'dark' ? stored : 'system');
  }, []);

  useEffect(() => {
    if (choice !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [choice]);

  function pick(next: Choice) {
    setChoice(next);
    if (next === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
    apply(next);
  }

  return (
    <div className="segmented" role="group" aria-label="Colour theme">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className="segment"
          aria-pressed={choice === option.value}
          title={option.label}
          onClick={() => pick(option.value)}
        >
          <span aria-hidden>{option.icon}</span>
          <span className="segmentLabel">{option.label}</span>
        </button>
      ))}
    </div>
  );
}
