import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

/**
 * IBM Plex, not Geist or Inter.
 *
 * Plex was commissioned as the typeface of an engineering company and is drawn
 * for exactly this context — dense technical UI, long strings of identifiers,
 * numerals that have to line up in a column. Its slightly mechanical joints
 * read as instrumentation rather than as a consumer product, which is the
 * register this console needs.
 *
 * Weights are pinned to the four actually used. Shipping the full family would
 * cost several hundred KB of woff2 for glyphs that never render.
 */
const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Echo — Incident Commander",
  description:
    "Real-time AI incident commander. Joins the bridge, separates fact from assumption, and keeps the team aligned.",
};

/**
 * `viewportFit: cover` and a locked scale: this is an application frame, not a
 * document. Pinch-zooming a fixed console only ever strands the operator in a
 * corner of a layout that was already sized to the viewport.
 */
export const viewport: Viewport = {
  themeColor: "#0b0d11",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${plexSans.variable} ${plexMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="h-full overflow-hidden bg-base text-ink">{children}</body>
    </html>
  );
}
