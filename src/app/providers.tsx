"use client";

import { ConvexProvider, ConvexReactClient } from "convex/react";
import { useMemo } from "react";

export function Providers({ children }: { children: React.ReactNode }) {
  const client = useMemo(() => new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL as string), []);
  return <ConvexProvider client={client}>{children}</ConvexProvider>;
}
