import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";

let client: ConvexHttpClient | null = null;

export function convex(): ConvexHttpClient {
  if (!client) {
    const url = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!url) throw new Error("CONVEX_URL missing");
    client = new ConvexHttpClient(url);
  }
  return client;
}

export { api };
