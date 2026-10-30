// src/components/auth/AuthPageShell.tsx
// The signed-out page frame (backdrop, brand, card, footer) shared by the admin
// and candidate login screens, plus the error notice they show.

import type { ReactNode } from 'react';

export function AuthPageShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center relative overflow-hidden">
      {/* Background gradient orbs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -left-40 w-80 h-80 bg-primary/10 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -right-40 w-96 h-96 bg-primary/5 rounded-full blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-purple-500/5 rounded-full blur-3xl" />
      </div>

      {/* Grid pattern overlay */}
      <div
        className="absolute inset-0 opacity-[0.02]"
        style={{
          backgroundImage: `linear-gradient(hsl(var(--foreground)) 1px, transparent 1px),
                            linear-gradient(to right, hsl(var(--foreground)) 1px, transparent 1px)`,
          backgroundSize: '4rem 4rem',
        }}
      />

      <div className="relative z-10 w-full max-w-md px-4 animate-fade-in">
        {/* Logo & brand */}
        <div className="text-center mb-8">
          {/* Two variants: the brand purple loses contrast on the dark background. */}
          <img src="/logo-light.svg" alt="Arihant Capital" className="mx-auto h-14 w-auto mb-4 dark:hidden" />
          <img src="/logo-dark.svg" alt="Arihant Capital" className="mx-auto hidden h-14 w-auto mb-4 dark:block" />
          <h1 className="text-2xl font-bold text-foreground tracking-tight">
            Arihant Capital
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Recruitment Assessment
          </p>
        </div>

        {/* Card */}
        <div className="glass rounded-2xl p-8 shadow-2xl">
          <div className="mb-6">
            <h2 className="text-xl font-semibold text-foreground">{title}</h2>
            <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>
          </div>
          {children}
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-muted-foreground mt-6">
          SEBI Registration No: INZ000177535 · NSE & BSE · ARN-77748
        </p>
      </div>
    </div>
  );
}

export function ServerErrorNotice({ message }: { message: string }) {
  return (
    <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 animate-fade-in">
      <p className="text-sm text-destructive">{message}</p>
    </div>
  );
}
