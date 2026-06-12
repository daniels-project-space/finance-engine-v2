import type { Metadata } from "next";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { Providers } from "./providers";

const grotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-sans" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Finance Engine v2",
  description: "Self-improving crypto strategy lab",
};

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/tournament", label: "Tournament" },
  { href: "/candidates", label: "Candidates" },
  { href: "/lessons", label: "Lessons" },
  { href: "/config", label: "Config" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${grotesk.variable} ${mono.variable} min-h-screen antialiased`}>
        <Providers>
          <header className="border-b border-edge bg-panel/60 backdrop-blur sticky top-0 z-20">
            <div className="mx-auto max-w-6xl px-5 h-14 flex items-center gap-8">
              <Link href="/" className="flex items-baseline gap-2">
                <span className="num text-up font-bold">FE</span>
                <span className="font-semibold tracking-tight">finance-engine</span>
                <span className="num text-dim text-xs">v2</span>
              </Link>
              <nav className="flex gap-5 text-sm text-dim">
                {NAV.map((n) => (
                  <Link key={n.href} href={n.href} className="hover:text-fg transition-colors">{n.label}</Link>
                ))}
              </nav>
              <div className="ml-auto hud">paper · perps · BTC ETH SOL BNB XRP</div>
            </div>
          </header>
          <main className="mx-auto max-w-6xl px-5 py-8">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
