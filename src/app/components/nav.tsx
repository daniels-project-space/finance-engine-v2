"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Plain tabs, each answering one obvious question:
//  Live          — how are my strategies doing right now?
//  My Strategies — Daniel's validated strategies (description + since-2020 + chart)
//  Strategies    — what are the best strategies, do they beat just holding?
//  Engine        — is the discovery engine working, and what's it finding?
const PRIMARY: { href: string; label: string; glow?: boolean }[] = [
  { href: "/", label: "Live", glow: true },
  { href: "/my-strategies", label: "My Strategies" },
  { href: "/strategies", label: "Strategies" },
  { href: "/engine", label: "Engine" },
];

export function NavLinks() {
  const path = usePathname();
  const isActive = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <nav className="flex items-center gap-1 text-[14px]">
      {PRIMARY.map((n) => {
        const active = isActive(n.href);
        if (n.glow) {
          return (
            <Link key={n.href} href={n.href}
              className={`px-3 py-1.5 rounded-md transition-colors flex items-center gap-2 ${active ? "blue-glow-text bg-[#5cc8ff12] shadow-[0_0_0_1px_#2a5566]" : "text-info/90 hover:text-info hover:bg-[#5cc8ff0c]"}`}>
              <span className="w-1.5 h-1.5 rounded-full bg-info live-dot" />
              {n.label}
            </Link>
          );
        }
        return (
          <Link key={n.href} href={n.href}
            className={`px-3 py-1.5 rounded-md transition-colors ${active ? "text-fg bg-[#ffffff0c] shadow-[0_0_0_1px_#2a3742]" : "text-dim hover:text-fg hover:bg-[#ffffff06]"}`}>
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
