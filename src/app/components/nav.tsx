"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const PRIMARY = [
  { href: "/", label: "Overview" },
  { href: "/pipeline", label: "Pipeline" },
  { href: "/sleeves", label: "Sleeves" },
  { href: "/tournament", label: "Tournament" },
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
      {PRIMARY.map((n) => (
        <Link key={n.href} href={n.href}
          className={`px-2.5 py-1 rounded-md transition-colors ${isActive(n.href) ? "text-fg bg-[#ffffff0c] shadow-[0_0_0_1px_#2a3742]" : "text-dim hover:text-fg hover:bg-[#ffffff06]"}`}>
          {n.label}
        </Link>
      ))}
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
