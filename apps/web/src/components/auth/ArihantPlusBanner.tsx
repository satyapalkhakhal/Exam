// src/components/auth/ArihantPlusBanner.tsx
// Why: the candidate pages double as a showcase for ArihantPlus, the company's trading app.
// Copy, colours and screenshots follow the app's own App Store listing (approved mockup,
// 2026-11-05). Pricing claims and store ratings are left out on purpose: they change and need
// compliance sign-off. Images live in /public/arihantplus.
//
// Two shapes share the same pieces:
// - ArihantPlusBanner: the tall side panel for AuthPageShell pages (login, location).
// - ArihantPlusStrip: a horizontal card for the bottom of the signed-in pages (dashboard, exam
//   details, submitted). Never on the exam-taking page.

const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.msf.acml';
const APP_STORE_URL = 'https://apps.apple.com/in/app/arihant-plus/id1643484698';
const WEB_URL = 'https://web.arihantplus.com';

const PRODUCTS = ['Stocks', 'F&O', 'ETF', 'IPO', 'NCD', 'Mutual Funds', 'Commodity', 'Currency'];

const FEATURES: { title: string; detail: string }[] = [
  { title: 'Trade from the Option Chain', detail: 'IV, Greeks and OI heatmap' },
  { title: 'Actionable research', detail: 'Stock ideas from Arihant Research' },
  { title: 'Stock SIP & fund SIPs', detail: 'Invest a fixed amount on a schedule' },
  { title: 'Advanced charts', detail: 'Candlesticks and indicators' },
];

const HEADLINE = 'Invest in Stocks, ETF, IPO, NCD & Mutual Funds';

const surface =
  'bg-gradient-to-b from-[#faf5ff] to-[#dcc3f7] text-[#2a1d44] border-[#a35fe0]/25 ' +
  'dark:from-[#1d1430] dark:to-[#3a2161] dark:text-[#f1e9fd] dark:border-[#c08cf2]/30';
const muted = 'text-[#5e4f78] dark:text-[#c3b3dc]';
const headlineColour = 'text-[#5b22a3] dark:text-[#dcc1fb]';

const storeLink =
  'inline-flex items-center gap-2 rounded-[10px] py-[7px] pl-2.5 pr-3.5 no-underline transition-opacity hover:opacity-90 ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00a84f]';
const storeDark = 'bg-[#16101f] text-white dark:bg-[#f3ecfd] dark:text-[#1a1226]';

function Check() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true" className="mt-px h-[18px] w-[18px] shrink-0">
      <circle cx="9" cy="9" r="9" className="fill-[#00a84f] dark:fill-[#3ad58a]" />
      <path
        d="M5 9.3l2.6 2.5L13 6.4"
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-white dark:stroke-[#1d1430]"
      />
    </svg>
  );
}

function Brand({ size }: { size: 'sm' | 'lg' }) {
  return (
    <div className="flex items-center gap-2.5">
      <img
        src="/arihantplus/icon.jpg"
        alt="ArihantPlus app icon"
        width={44}
        height={44}
        className={
          'h-9 w-9 rounded-[9px] shadow-[0_4px_12px_-4px_rgba(91,34,163,0.45)] ' +
          (size === 'lg' ? 'lg:h-10 lg:w-10 lg:rounded-[10px]' : '')
        }
      />
      <span className={`font-display text-[19px] font-bold leading-none tracking-[-0.01em] ${size === 'lg' ? 'lg:text-[21px]' : ''}`}>
        Arihant
        <b className="ml-0.5 text-[0.78em] font-extrabold tracking-[0.04em] text-[#00a84f] dark:text-[#3ad58a]">PLUS</b>
      </span>
    </div>
  );
}

function Eyebrow() {
  return <span className={`text-[11px] font-semibold uppercase tracking-[0.08em] ${muted}`}>Our trading &amp; investing app</span>;
}

function Lede({ className = '' }: { className?: string }) {
  return (
    <p className={`max-w-[46ch] leading-relaxed ${muted} ${className}`}>
      Trade on NSE, BSE, MCX and NCDEX from one app.{' '}
      <strong className="font-semibold text-[#2a1d44] dark:text-[#f1e9fd]">Open a paperless account in under 10 mins.</strong>
    </p>
  );
}

function Products() {
  return (
    <ul aria-label="Products" className="flex flex-wrap gap-1.5">
      {PRODUCTS.map((p) => (
        <li
          key={p}
          className="rounded-full border border-[#a35fe0]/30 bg-white/70 px-2.5 py-1 text-xs font-semibold dark:border-[#c08cf2]/30 dark:bg-white/[0.07]"
        >
          {p}
        </li>
      ))}
    </ul>
  );
}

function StoreLinks() {
  return (
    <div className="flex flex-wrap gap-2">
      <a href={PLAY_STORE_URL} target="_blank" rel="noopener noreferrer" aria-label="Get ArihantPlus on Google Play" className={`${storeLink} ${storeDark}`}>
        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[18px] w-[18px] shrink-0 fill-current">
          <path d="M4 2.8v18.4c0 .5.5.8 1 .6l15.6-8.9c.5-.3.5-1 0-1.2L5 2.2c-.5-.3-1 0-1 .6z" />
        </svg>
        <span className="grid leading-tight">
          <small className="text-[9px] uppercase tracking-[0.04em] opacity-75">Get it on</small>
          <strong className="text-[13px] font-semibold">Google Play</strong>
        </span>
      </a>
      <a href={APP_STORE_URL} target="_blank" rel="noopener noreferrer" aria-label="Download ArihantPlus on the App Store" className={`${storeLink} ${storeDark}`}>
        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[18px] w-[18px] shrink-0 fill-current">
          <path d="M16.4 12.6c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9-.7 0-1.9-.9-3.1-.8-1.6 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3.1.7c1.3 0 2.1-1.1 2.8-2.3.9-1.3 1.3-2.6 1.3-2.6s-2.5-1-2.5-3.8zM14.1 5.8c.6-.8 1.1-1.8 1-2.8-.9 0-2 .6-2.7 1.4-.6.7-1.1 1.7-1 2.7 1 .1 2-.5 2.7-1.3z" />
        </svg>
        <span className="grid leading-tight">
          <small className="text-[9px] uppercase tracking-[0.04em] opacity-75">Download on the</small>
          <strong className="text-[13px] font-semibold">App Store</strong>
        </span>
      </a>
      <a
        href={WEB_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={`${storeLink} border border-[#a35fe0]/30 text-[#5b22a3] dark:border-[#c08cf2]/30 dark:text-[#dcc1fb]`}
      >
        <span className="grid leading-tight">
          <small className="text-[9px] uppercase tracking-[0.04em] opacity-75">Trade on web</small>
          <strong className="text-[13px] font-semibold">web.arihantplus.com</strong>
        </span>
      </a>
    </div>
  );
}

function Disclaimer() {
  return (
    <p className={`text-[10.5px] leading-snug ${muted}`}>
      Investments in securities markets are subject to market risks. Read all related documents carefully before investing.
    </p>
  );
}

/**
 * Tall side panel: left half of AuthPageShell (and the receipt page) on desktop, below the
 * card on phones.
 *
 * Desktop layout is exactly one screen tall (sticky, so it stays put while the form side
 * scrolls) and never needs scrolling itself:
 *   header (brand, eyebrow) / hero (headline, lede) / offer (products, features) / CTA (stores,
 *   disclaimer) / screenshots.
 * Tight gaps inside a group, a larger viewport-height-scaled gap between groups. The screenshot
 * strip takes whatever height is left (flex-1) and is clipped, so it is the only part that gives
 * way on a short screen; below 620px tall the feature list is dropped as well. Type is sized to sit
 * alongside the sign-in card (20px heading, 14px body) rather than compete with it.
 */
export function ArihantPlusBanner() {
  const groupGap = 'lg:gap-[clamp(16px,3.2vh,32px)]';
  return (
    <aside
      aria-label="ArihantPlus app"
      className={
        `relative flex h-full flex-col gap-5 overflow-hidden border-t px-5 pb-7 pt-7 ${surface} ` +
        `lg:sticky lg:top-0 lg:h-screen lg:border-r lg:border-t-0 lg:pb-0 lg:pl-[clamp(40px,4.5vw,72px)] lg:pr-10 lg:pt-[clamp(28px,6vh,64px)] ${groupGap}`
      }
    >
      {/* Header */}
      <div className="flex flex-col gap-2.5">
        <Brand size="lg" />
        <Eyebrow />
      </div>

      {/* Hero */}
      <div className="flex flex-col gap-2.5 lg:gap-[clamp(8px,1.3vh,12px)]">
        <h2
          className={
            `font-display text-2xl font-bold leading-[1.15] tracking-[-0.015em] [text-wrap:balance] ${headlineColour} ` +
            'lg:max-w-[26ch] lg:text-[clamp(22px,3.6vh,30px)]'
          }
        >
          {HEADLINE}
        </h2>
        <Lede className="text-sm" />
      </div>

      {/* Offer */}
      <div className="flex flex-col gap-4 lg:gap-[clamp(12px,2vh,18px)]">
        <Products />
        {/* Phones get the short version: the sign-in form sits above this banner there. */}
        <ul className="hidden max-w-[520px] grid-cols-2 gap-x-6 gap-y-2.5 lg:grid lg:[@media(max-height:620px)]:hidden">
          {FEATURES.map((f) => (
            <li key={f.title} className="flex gap-2 text-[13px] font-medium leading-snug">
              <Check />
              <span>
                {f.title}
                <small className={`mt-0.5 block text-[11.5px] font-normal ${muted}`}>{f.detail}</small>
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* CTA */}
      <div className="flex flex-col gap-2.5">
        <StoreLinks />
        <Disclaimer />
      </div>

      {/* Screenshots: desktop only, fill the leftover height and get clipped at the bottom.
          loading="lazy" keeps phones from fetching images they never show. */}
      <div
        aria-hidden="true"
        className="group relative -mr-10 hidden min-h-0 flex-1 items-start gap-[clamp(12px,1.4vw,22px)] pt-1 lg:flex"
      >
        {[
          { src: '/arihantplus/screen-dashboard.jpg', tilt: '-rotate-[5deg] mt-5 motion-safe:group-hover:-translate-y-1.5' },
          { src: '/arihantplus/screen-ipo.jpg', tilt: 'rotate-[3deg] mt-9 motion-safe:group-hover:-translate-y-2' },
          { src: '/arihantplus/screen-option-chain.jpg', tilt: 'rotate-[7deg] mt-6 hidden xl:block motion-safe:group-hover:-translate-y-1.5' },
        ].map((s) => (
          <img
            key={s.src}
            src={s.src}
            alt=""
            width={180}
            height={390}
            loading="lazy"
            decoding="async"
            className={`w-[clamp(118px,8.5vw,152px)] shrink-0 rounded-[20px] shadow-[0_18px_36px_-18px_rgba(58,20,110,0.45)] motion-safe:transition-transform motion-safe:duration-300 ${s.tilt}`}
          />
        ))}
      </div>
    </aside>
  );
}

/**
 * Horizontal card for the bottom of a signed-in candidate page. `showPhone` adds a tilted app
 * screenshot on the right from md up; leave it off in narrow columns (the receipt page).
 * Hidden when printing, so a printed receipt carries no advert.
 */
export function ArihantPlusStrip({ showPhone = true, className = '' }: { showPhone?: boolean; className?: string }) {
  return (
    <section aria-label="ArihantPlus app" className={`relative overflow-hidden rounded-2xl border text-left print:hidden ${surface} ${className}`}>
      <div className={`grid gap-6 p-5 sm:p-6 ${showPhone ? 'md:grid-cols-[minmax(0,1fr)_170px]' : ''}`}>
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <Brand size="sm" />
            <Eyebrow />
          </div>
          <h2 className={`font-display text-[22px] font-extrabold leading-[1.12] tracking-[-0.01em] [text-wrap:balance] sm:text-2xl ${headlineColour}`}>
            {HEADLINE}
          </h2>
          <Lede className="text-sm" />
          <Products />
          <div className="mt-1">
            <StoreLinks />
          </div>
          <Disclaimer />
        </div>
        {showPhone && (
          <div aria-hidden="true" className="relative hidden md:block">
            <img
              src="/arihantplus/screen-dashboard.jpg"
              alt=""
              width={170}
              height={368}
              loading="lazy"
              decoding="async"
              className="absolute left-0 top-1 w-[170px] rotate-[5deg] rounded-[22px] shadow-[0_20px_40px_-18px_rgba(58,20,110,0.55)]"
            />
          </div>
        )}
      </div>
    </section>
  );
}
