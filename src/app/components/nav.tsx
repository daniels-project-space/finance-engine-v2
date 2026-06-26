"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const PRIMARY: { href: string; label: string; glow?: boolean }[] = [
  { href: "/", label: "Overview" },
  { href: "/live", label: "Live", glow: true },
  { href: "/pipeline", label: "Pipeline" },
  { href: "/sleeves", label: "Sleeves" },
  { href: "/tournament", label: "Leaderboard" },
  { href: "/data", label: "Data" },
];
const SECONDARY = [
  { href: "/candidates", label: "Candidates" },
  { href: "/lessons", label: "Lessons" },
  { href: "/config", label: "Config" },
];

export function NavLinks() {
  const path = usePathname();
  const isActive = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <nav className="flex items-center gap-0.5 text-[13px]">
      {PRIMARY.map((n) => {
        const active = isActive(n.href);
        if (n.glow) {
          return (
            <Link key={n.href} href={n.href}
              className={`px-2.5 py-1 rounded-md transition-colors flex items-center gap-1.5 ${active ? "blue-glow-text bg-[#5cc8ff12] shadow-[0_0_0_1px_#2a5566]" : "text-info/90 hover:text-info hover:bg-[#5cc8ff0c]"}`}>
              <span className="w-1.5 h-1.5 rounded-full bg-info live-dot" />
              {n.label}
            </Link>
          );
        }
        return (
          <Link key={n.href} href={n.href}
            className={`px-2.5 py-1 rounded-md transition-colors ${active ? "text-fg bg-[#ffffff0c] shadow-[0_0_0_1px_#2a3742]" : "text-dim hover:text-fg hover:bg-[#ffffff06]"}`}>
            {n.label}
          </Link>
        );
      })}
      <span className="w-px h-4 bg-edge mx-1.5" />
      {SECONDARY.map((n) => (
        <Link key={n.href} href={n.href}
          className={`px-2 py-1 rounded-md num text-[11px] transition-colors ${isActive(n.href) ? "text-mid bg-[#ffffff0a]" : "text-faint hover:text-mid"}`}>
          {n.label}
        </Link>
      ))}
    </nav>
  );
}
