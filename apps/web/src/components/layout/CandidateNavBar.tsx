// src/components/layout/CandidateNavBar.tsx
// Why: the candidate pages carry a navigation bar like arihantplus.com's (user request
// 2026-11-11): the ArihantPlus logo, What we offer ▾ · Pricing · Learning ▾ · About ▾ · Partner,
// and "Open demat account". Every ArihantPlus link opens in a new tab so the candidate's
// session is never lost. Signed in, the candidate's name and Sign out sit on the right. There is
// no ArihantPlus "Sign In" button: on this portal "sign in" means the exam sign-in. Never on the
// exam-taking page (it has its own header: timer, save status).

import { useState } from 'react';
import { ChevronDown, Menu, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { CandidateSignOut } from '@/components/layout/CandidateSignOut';
import { ARIHANTPLUS_HOME, ARIHANTPLUS_NAV, OPEN_DEMAT_URL, type NavItem, type NavLink } from '@/lib/arihantPlusNav';
import { cn } from '@/lib/utils';
import { useCandidateAuth } from '@/stores/candidateAuth';

const external = { target: '_blank', rel: 'noopener noreferrer' } as const;
const topLink =
  'inline-flex items-center gap-1 rounded-md px-3 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function Logo() {
  return (
    <a href={ARIHANTPLUS_HOME} {...external} className="shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="ArihantPlus (opens in a new tab)">
      <img src="/arihantplus/logo.svg" alt="ArihantPlus" width={150} height={24} className="h-6 w-auto dark:hidden" />
      <img src="/arihantplus/logo-dark.svg" alt="ArihantPlus" width={150} height={24} className="hidden h-6 w-auto dark:block" />
    </a>
  );
}

function DesktopItem({ item }: { item: NavItem }) {
  if (!('groups' in item) || !item.groups) {
    const link = item as NavLink;
    return <a href={link.href} {...external} className={topLink}>{link.label}</a>;
  }
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger className={topLink}>
        {item.label} <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        {item.groups.map((g, gi) => (
          <div key={g.title}>
            {gi > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-xs uppercase tracking-wide text-muted-foreground">{g.title}</DropdownMenuLabel>
            {g.links.map((l) => (
              <DropdownMenuItem key={l.href} asChild>
                <a href={l.href} {...external}>{l.label}</a>
              </DropdownMenuItem>
            ))}
          </div>
        ))}
        {item.footer && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <a href={item.footer.href} {...external} className="font-medium text-primary">{item.footer.label} →</a>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MobilePanel({ onNavigate }: { onNavigate: () => void }) {
  return (
    <nav aria-label="ArihantPlus" className="space-y-4 border-t bg-card px-4 py-4 lg:hidden">
      {ARIHANTPLUS_NAV.map((item) =>
        'groups' in item && item.groups ? (
          <details key={item.label} className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold text-foreground">
              {item.label}
              <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <div className="mt-2 space-y-3 pl-2">
              {item.groups.map((g) => (
                <div key={g.title}>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{g.title}</p>
                  <ul className="mt-1 space-y-1">
                    {g.links.map((l) => (
                      <li key={l.href}><a href={l.href} {...external} onClick={onNavigate} className="block py-1 text-sm text-foreground/80 hover:text-foreground">{l.label}</a></li>
                    ))}
                  </ul>
                </div>
              ))}
              {item.footer && <a href={item.footer.href} {...external} onClick={onNavigate} className="block text-sm font-medium text-primary">{item.footer.label} →</a>}
            </div>
          </details>
        ) : (
          <a key={item.label} href={(item as NavLink).href} {...external} onClick={onNavigate} className="block text-sm font-semibold text-foreground">{item.label}</a>
        ),
      )}
    </nav>
  );
}

export function CandidateNavBar() {
  const candidate = useCandidateAuth((s) => s.candidate);
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-40 border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80 print:hidden">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4">
        <Logo />
        <nav aria-label="ArihantPlus" className="hidden items-center gap-0.5 lg:flex">
          {ARIHANTPLUS_NAV.map((item) => <DesktopItem key={item.label} item={item} />)}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          {candidate && (
            <div className="hidden items-center gap-3 md:flex">
              <span className="max-w-[12rem] truncate text-sm font-medium text-foreground" title={candidate.fullName}>{candidate.fullName}</span>
              <CandidateSignOut />
            </div>
          )}
          <Button asChild size="sm" className="hidden sm:inline-flex">
            <a href={OPEN_DEMAT_URL} {...external}>Open demat account</a>
          </Button>
          <button
            type="button"
            className={cn('rounded-md p-2 text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden')}
            aria-expanded={open}
            aria-label={open ? 'Close menu' : 'Open menu'}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
          </button>
        </div>
      </div>
      {open && (
        <>
          <MobilePanel onNavigate={() => setOpen(false)} />
          <div className="space-y-3 border-t bg-card px-4 py-3 lg:hidden">
            <Button asChild size="sm" className="w-full sm:hidden">
              <a href={OPEN_DEMAT_URL} {...external}>Open demat account</a>
            </Button>
            {candidate && (
              <div className="flex items-center justify-between md:hidden">
                <span className="truncate text-sm font-medium text-foreground">{candidate.fullName}</span>
                <CandidateSignOut />
              </div>
            )}
          </div>
        </>
      )}
    </header>
  );
}
