import type { Metadata } from "next";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { NavLinks } from "./components/nav";
import { Providers } from "./providers";

const grotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-sans" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "finance-engine v2",
  description: "Self-improving crypto strategy lab — precision research terminal",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${grotesk.variable} ${mono.variable} min-h-screen antialiased`}>
        <Providers>
          <header className="border-b border-edge bg-ink/85 backdrop-blur sticky top-0 z-20">
            <div className="mx-auto max-w-[1280px] px-5 h-13 flex items-center gap-5" style={{ height: 52 }}>
              <Link href="/" className="flex items-baseline gap-2 shrink-0">
                <span className="num text-accent font-bold tracking-tight">fe</span>
                <span className="font-semibold tracking-tight text-fg text-[15px]">finance-engine</span>
                <span className="num text-dim text-[10px]">v2</span>
              </Link>
              <NavLinks />
              <div className="ml-auto hud hidden lg:flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-up live-dot" />
                paper · perps · ccxt · 24×3tf
              </div>
            </div>
          </header>
          <main className="mx-auto max-w-[1280px] px-5 py-5">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
