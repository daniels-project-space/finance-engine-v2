"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/tournament", label: "Tournament" },
  { href: "/candidates", label: "Candidates" },
  { href: "/lessons", label: "Lessons" },
  { href: "/config", label: "Config" },
];

export function NavLinks() {
  const path = usePathname();
  return (
    <nav className="flex gap-1 text-sm">
      {NAV.map((n) => {
        const active = n.href === "/" ? path === "/" : path.startsWith(n.href);
        return (
          <Link key={n.href} href={n.href}
            className={`px-3 py-1 rounded-md transition-colors ${active ? "text-fg bg-edge/60 shadow-[0_0_0_1px_#2a3742]" : "text-dim hover:text-fg hover:bg-edge/30"}`}>
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
