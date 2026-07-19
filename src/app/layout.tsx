import type { Metadata } from "next";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import Link from "next/link";
import Script from "next/script";
import "./globals.css";
import { NavLinks } from "./components/nav";
import { Logo } from "./components/logo";
import { Providers } from "./providers";

const grotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-sans" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "finance-engine v2",
  description: "Self-improving crypto strategy lab — precision research terminal",
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/apple-icon.png" }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${grotesk.variable} ${mono.variable} min-h-screen antialiased`}>
        <Providers>
          <header className="border-b border-[#ffffff08] bg-ink/80 backdrop-blur sticky top-0 z-20">
            <div className="mx-auto max-w-[1280px] px-5 flex items-center gap-5" style={{ height: 54 }}>
              <Link href="/" className="flex items-center gap-2.5 shrink-0">
                <Logo size={24} />
                <span className="font-semibold tracking-tight text-fg text-[15px]">finance-engine</span>
                <span className="num text-dim text-[10px]">v2</span>
              </Link>
              <NavLinks />
              <div className="ml-auto hud hidden lg:flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-up live-dot" />
                testing with fake money
              </div>
            </div>
          </header>
          <main className="mx-auto max-w-[1280px] px-5 py-6">{children}</main>
        </Providers>
        <Script
          src="https://jarvis-orcin-six.vercel.app/jarvis-embed.js?v=universal-controls-20260719-1"
          strategy="afterInteractive"
          data-jarvis-app="finance-engine-v2"
        />
      </body>
    </html>
  );
}
