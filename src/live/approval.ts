/**
 * Real exchange execution is intentionally fail-closed. A database record in
 * `live` mode is never sufficient to place an order: an operator must also
 * set this process-scoped acknowledgement on the VPS that holds the exchange
 * credential. This keeps a stale UI, an accidental migration, or a malformed
 * seed from turning a deployment row into a financial action.
 */
export function isLiveTradingExplicitlyApproved(value = process.env.FINANCE_LIVE_TRADING_APPROVED): boolean {
  return value === "true";
}

export const LIVE_TRADING_APPROVAL_REASON =
  "operator approval absent (FINANCE_LIVE_TRADING_APPROVED must be exactly true)";
