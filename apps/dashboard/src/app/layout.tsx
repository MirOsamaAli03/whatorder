import type { Metadata } from 'next';
import { Atkinson_Hyperlegible_Next, Bricolage_Grotesque, Noto_Nastaliq_Urdu } from 'next/font/google';
import type { ReactNode } from 'react';
import { SessionProvider } from '@/lib/session';
import './globals.css';

/**
 * Three families, each chosen for a job (docs/DESIGN_BRIEF.md).
 *
 * Atkinson Hyperlegible Next is the interface font because it was drawn for
 * low-vision readability — letterforms are disambiguated rather than merely
 * distinct. That matters more here than on most products: the kitchen display
 * is read from two metres away, in a hurry, by somebody holding a pan.
 *
 * Loaded through next/font rather than a <link> to Google: the files are
 * self-hosted at build time, so there is no third-party request on the critical
 * path and no render-blocking stylesheet.
 *
 * `adjustFontFallback` is off on all three. Next builds a metric-matched
 * fallback face from a table of known fonts, and none of these is in it — the
 * build fails outright on Atkinson with "Failed to find font override values".
 * The cost is a little reflow when the real face arrives, which `display:
 * 'swap'` already implies; the alternative was giving up the font.
 */
const atkinson = Atkinson_Hyperlegible_Next({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-atkinson',
  display: 'swap',
  adjustFontFallback: false,
});

const bricolage = Bricolage_Grotesque({
  subsets: ['latin'],
  weight: ['500', '600', '700', '800'],
  variable: '--font-bricolage',
  display: 'swap',
  adjustFontFallback: false,
});

/**
 * Nastaliq is not optional decoration. A menu written in Urdu set in a Naskh
 * fallback reads as broken to the people it is for, and every dish on this
 * system can carry an Urdu name.
 */
const nastaliq = Noto_Nastaliq_Urdu({
  subsets: ['arabic'],
  weight: ['400', '700'],
  variable: '--font-nastaliq',
  display: 'swap',
  adjustFontFallback: false,
});

export const metadata: Metadata = {
  title: 'Restaurant OS',
  description: 'Menu, orders and kitchen display',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${atkinson.variable} ${bricolage.variable} ${nastaliq.variable}`}
    >
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
