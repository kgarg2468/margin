import type { Metadata, Viewport } from "next";
import { Inter, Source_Serif_4 } from "next/font/google";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";
import "./globals.css";

const sourceSerif = Source_Serif_4({
  variable: "--font-source-serif",
  subsets: ["latin"],
  display: "swap",
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const title = "margin — the collective intelligence layer for research groups";
const description =
  "Margin is a collaborative journal club and annotation workspace where research groups read papers together and keep what they learn.";

export const metadata: Metadata = {
  // TODO: swap for the production domain once it exists.
  metadataBase: new URL("https://margin.vercel.app"),
  title,
  description,
  openGraph: {
    type: "website",
    siteName: "margin",
    url: "/",
    title,
    description,
    locale: "en_US",
  },
  // Twitter/X will fall back to the Open Graph tags, but only for a small
  // card. Declaring the card type is what gets the OG image rendered full
  // width, which is the whole point of shipping one.
  twitter: {
    card: "summary_large_image",
    title,
    description,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f2e9" },
    { media: "(prefers-color-scheme: dark)", color: "#16110e" },
  ],
};

/**
 * Document shell only — fonts, tokens, metadata. Deliberately free of any
 * provider that reads the request, so the marketing route group under
 * `(marketing)` can be prerendered at build time. Everything that needs a
 * session lives under `(app)`, which mounts the Convex providers itself.
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // The font variables live on <html> so `--font-serif` (declared on :root
    // in globals.css) can resolve them; on <body> they would be out of scope.
    // The theme class lands on the same element for the same kind of reason:
    // Lightning CSS emits the `light-dark()` toggles for `:root`, `.light` and
    // `.dark` and for nothing else, so <html> is the only element where a
    // class can move a token.
    <html
      lang="en"
      className={`${sourceSerif.variable} ${inter.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/*
         * Before anything paints, and before React exists. `suppressHydration-
         * Warning` above is what lets the server's classless <html> and the
         * client's themed one agree — the class is not React's to know about.
         */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
