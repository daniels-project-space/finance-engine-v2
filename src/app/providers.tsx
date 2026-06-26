"use client";

import { ConvexProvider, ConvexReactClient, useQuery } from "convex/react";
import { useMemo } from "react";
import { api } from "../../convex/_generated/api";
import { setBenchmarks } from "./components/ds";

// Fetches the SPX + BTC benchmark series ONCE and publishes them to the ds.tsx
// module cache so every ChartWithBenchmarks on every page can overlay them
// without each chart re-fetching. Read-only.
function BenchmarkLoader() {
  const b = useQuery(api.dashboard.benchmarks, {});
  setBenchmarks(b ?? null);
  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const client = useMemo(() => new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL as string), []);
  return (
    <ConvexProvider client={client}>
      <BenchmarkLoader />
      {children}
    </ConvexProvider>
  );
}
