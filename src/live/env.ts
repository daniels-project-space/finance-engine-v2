// Executor env bootstrap: fill missing process.env keys from the project-hub
// secrets vault so the live executor runs from a bare VPS cron line. Values
// already present in the environment always win (lets a .env file override).

const VAULT_URL = process.env.VAULT_URL ?? "https://fantastic-roadrunner-485.convex.cloud";

// key -> vault service that holds it
const VAULT_MAP: Record<string, string> = {
  R2_ENDPOINT: "cloudflare",
  R2_ACCESS_KEY_ID: "cloudflare",
  R2_SECRET_ACCESS_KEY: "cloudflare",
  BINANCE_API_KEY: "binance",
  BINANCE_API_SECRET: "binance",
  TELEGRAM_BOT_TOKEN: "telegram",
  TELEGRAM_ADMIN_CHAT_ID: "telegram",
};

async function vaultService(service: string): Promise<Record<string, string>> {
  const res = await fetch(`${VAULT_URL}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "secrets:listByService", args: { service }, format: "json" }),
  });
  if (!res.ok) throw new Error(`vault ${service}: HTTP ${res.status}`);
  const data = (await res.json()) as { status: string; value?: { keyName: string; value: string }[] };
  if (data.status !== "success" || !data.value) throw new Error(`vault ${service}: ${JSON.stringify(data).slice(0, 120)}`);
  return Object.fromEntries(data.value.map((s) => [s.keyName, s.value]));
}

/** Ensure the given env keys exist, pulling absentees from the vault. */
export async function ensureEnv(keys: string[]): Promise<void> {
  const missing = keys.filter((k) => !process.env[k]);
  if (!missing.length) return;
  const services = [...new Set(missing.map((k) => VAULT_MAP[k]).filter(Boolean))];
  const fetched: Record<string, string> = {};
  for (const svc of services) Object.assign(fetched, await vaultService(svc));
  for (const k of missing) {
    if (fetched[k]) process.env[k] = fetched[k];
  }
  const still = keys.filter((k) => !process.env[k]);
  if (still.length) throw new Error(`missing env after vault bootstrap: ${still.join(", ")}`);
}
