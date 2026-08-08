import type { Metadata, Viewport } from "next";
import { Inter, Source_Serif_4 } from "next/font/google";
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
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f2e9" },
    { media: "(prefers-color-scheme: dark)", color: "#16110e" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // The font variables live on <html> so `--font-serif` (declared on :root
    // in globals.css) can resolve them; on <body> they would be out of scope.
    <html
      lang="en"
      className={`${sourceSerif.variable} ${inter.variable}`}
      suppressHydrationWarning
    >
      <body className="antialiased">{children}</body>
    </html>
  );
}
