// src/lib/arihantPlusNav.ts
// Why: the candidate pages carry a navigation bar like arihantplus.com's (user request
// 2026-11-11): same items, same order, every link opening the ArihantPlus page in a new tab so
// a candidate never loses their exam session. Links copied from arihantplus.com on 2026-11-11;
// "Stock Market Courses" is left out because the site has no link for it.

const SITE = 'https://www.arihantplus.com';

export const OPEN_DEMAT_URL = 'https://signup.arihantplus.com/';
export const ARIHANTPLUS_HOME = `${SITE}/`;

export interface NavLink {
  label: string;
  href: string;
}
export interface NavGroup {
  title: string;
  links: NavLink[];
}
export type NavItem = (NavLink & { groups?: never }) | { label: string; groups: NavGroup[]; footer?: NavLink };

export const ARIHANTPLUS_NAV: NavItem[] = [
  {
    label: 'What we offer',
    groups: [
      {
        title: 'Invest',
        links: [
          { label: 'Stocks & ETFs', href: `${SITE}/product/stocks-and-etfs` },
          { label: 'IPO', href: `${SITE}/product/ipo` },
          { label: 'Gold', href: `${SITE}/product/gold` },
          { label: 'Mutual Funds', href: `${SITE}/product/mutual-funds` },
        ],
      },
      {
        title: 'Trade',
        links: [
          { label: 'MTF', href: `${SITE}/product/mtf` },
          { label: 'Futures & Options', href: `${SITE}/product/fno` },
          { label: 'Algo Trading', href: `${SITE}/algotrading` },
          { label: 'Trading APIs', href: `${SITE}/tradingapi` },
        ],
      },
    ],
    footer: { label: 'View all products', href: `${SITE}/product` },
  },
  { label: 'Pricing', href: `${SITE}/pricing` },
  {
    label: 'Learning',
    groups: [
      { title: 'Resources', links: [{ label: 'Blogs', href: `${SITE}/blogs` }] },
      {
        title: 'Calculators',
        links: [
          { label: 'EMI Calculator', href: `${SITE}/calculator/emi-calculator` },
          { label: 'SIP Calculator', href: `${SITE}/calculator/sip-calculator` },
          { label: 'Margin Calculator', href: `${SITE}/calculator/margin-calculator` },
        ],
      },
    ],
  },
  {
    label: 'About',
    groups: [
      {
        title: 'Who are we?',
        links: [
          { label: 'About Us', href: `${SITE}/about-us` },
          { label: 'Contact Us', href: `${SITE}/contact-us` },
          { label: 'Support', href: 'https://support.arihantplus.com/support/home' },
        ],
      },
    ],
  },
  { label: 'Partner', href: `${SITE}/partner-with-us` },
];

/** Every link in the menu, flattened (for tests and the mobile menu). */
export function navLinks(): NavLink[] {
  return ARIHANTPLUS_NAV.flatMap((i) => ('groups' in i && i.groups ? [...i.groups.flatMap((g) => g.links), ...(i.footer ? [i.footer] : [])] : [i as NavLink]));
}
