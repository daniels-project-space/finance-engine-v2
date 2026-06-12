import type { Metadata } from "next";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { NavLinks } from "./components/nav";
import { Providers } from "./providers";

const grotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-sans" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Finance Engine v2",
  description: "Self-improving crypto strategy lab",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${grotesk.variable} ${mono.variable} min-h-screen antialiased`}>
        <Providers>
          <header className="border-b border-edge bg-panel/70 backdrop-blur sticky top-0 z-20">
            <div className="mx-auto max-w-7xl px-5 h-14 flex items-center gap-6">
              <Link href="/" className="flex items-baseline gap-2 shrink-0">
                <span className="num text-up font-bold drop-shadow-[0_0_6px_#2dd4a766]">FE</span>
                <span className="font-semibold tracking-tight">finance-engine</span>
                <span className="num text-dim text-xs">v2</span>
              </Link>
              <NavLinks />
              <div className="ml-auto hud hidden md:block">paper · perps · BTC ETH SOL BNB XRP · 1h/4h/1d</div>
            </div>
          </header>
          <main className="mx-auto max-w-7xl px-5 py-7 rise">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
