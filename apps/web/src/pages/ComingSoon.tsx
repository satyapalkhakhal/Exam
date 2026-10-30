// src/pages/ComingSoon.tsx
// Why: stand-in for pages that later tasks build, so routing and guards work now.

export function ComingSoon({ title }: { title: string }) {
  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold text-foreground">{title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">Coming soon.</p>
    </div>
  );
}
