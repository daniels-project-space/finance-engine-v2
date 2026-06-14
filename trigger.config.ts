import { defineConfig } from "@trigger.dev/sdk";
import { additionalPackages, aptGet } from "@trigger.dev/build/extensions/core";

export default defineConfig({
  project: "proj_wmvfhfcpwnsnfzhrfooh",
  dirs: ["./src/trigger"],
  runtime: "node",
  logLevel: "log",
  // Opus ideation latency: a 1M-context proposal call at default effort can take
  // minutes — keep the ceiling generous so the subscription CLI never aborts.
  maxDuration: 3600,
  retries: {
    enabledInDev: false,
    default: { maxAttempts: 2, minTimeoutInMs: 5000, maxTimeoutInMs: 30000, factor: 2, randomize: true },
  },
  build: {
    // Claude Code reads its bundled binary from disk and spawns its own
    // subprocesses — keep it OUT of the esbuild bundle and let Trigger install
    // it fresh in the Linux image (correct platform binary). Auth is the
    // injected CLAUDE_CODE_OAUTH_TOKEN (subscription), never the billed API.
    external: ["@anthropic-ai/claude-code"],
    extensions: [
      additionalPackages({ packages: ["@anthropic-ai/claude-code@latest"] }),
      aptGet({ packages: ["git", "ca-certificates"] }),
    ],
  },
});
