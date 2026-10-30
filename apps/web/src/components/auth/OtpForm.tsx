// src/components/auth/OtpForm.tsx
// Why: the 6-digit code step shared by the admin and candidate logins. Paste is
// allowed here (this is the login form, not the exam). The static dev OTP is
// deliberately never hinted at in the UI.

import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';

const LENGTH = 6;

export function OtpForm({
  onSubmit,
  onResend,
  submitting = false,
  error,
  cooldownSeconds = 60,
}: {
  onSubmit: (code: string) => void;
  onResend: () => void;
  submitting?: boolean;
  error?: string | null;
  cooldownSeconds?: number;
}) {
  const [digits, setDigits] = useState<string[]>(() => Array<string>(LENGTH).fill(''));
  const [cooldown, setCooldown] = useState(cooldownSeconds);
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const code = digits.join('');

  const setAt = (i: number, v: string) => setDigits((d) => d.map((x, idx) => (idx === i ? v : x)));

  const onChange = (i: number, raw: string) => {
    const v = raw.replace(/\D/g, '').slice(-1);
    setAt(i, v);
    if (v && i < LENGTH - 1) refs.current[i + 1]?.focus();
  };

  const onKeyDown = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[i] && i > 0) refs.current[i - 1]?.focus();
    if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus();
    if (e.key === 'ArrowRight' && i < LENGTH - 1) refs.current[i + 1]?.focus();
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, LENGTH);
    if (!pasted) return;
    e.preventDefault();
    setDigits(Array.from({ length: LENGTH }, (_, i) => pasted[i] ?? ''));
    refs.current[Math.min(pasted.length, LENGTH - 1)]?.focus();
  };

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (code.length === LENGTH && !submitting) onSubmit(code);
      }}
    >
      <div className="flex justify-between gap-2" role="group" aria-label="One-time code">
        {digits.map((d, i) => (
          <input
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            value={d}
            onChange={(e) => onChange(i, e.target.value)}
            onKeyDown={(e) => onKeyDown(i, e)}
            onPaste={onPaste}
            inputMode="numeric"
            autoComplete={i === 0 ? 'one-time-code' : 'off'}
            autoFocus={i === 0}
            maxLength={1}
            aria-label={`Digit ${i + 1}`}
            className="h-12 w-full min-w-0 rounded-lg border border-input bg-background text-center text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-ring"
          />
        ))}
      </div>
      <div aria-live="polite">
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
      <Button type="submit" className="w-full" disabled={code.length !== LENGTH || submitting}>
        {submitting ? 'Verifying…' : 'Verify'}
      </Button>
      <Button
        type="button"
        variant="ghost"
        className="w-full"
        disabled={cooldown > 0}
        onClick={() => {
          setCooldown(cooldownSeconds);
          onResend();
        }}
      >
        {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
      </Button>
    </form>
  );
}
