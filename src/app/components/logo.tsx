// THE DISTILLATION FUNNEL — the gauntlet's emblem: a converging funnel narrows
// the noisy field through stratified filters down to ONE amber survivor node.
// Inline SVG so it inherits crisp rendering + the design-system colors.

export function Logo({ size = 26, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} aria-label="finance-engine">
      {/* funnel walls — wide mouth converging to a narrow neck */}
      <path d="M6 8 L16 19 L26 8" stroke="#e2e8f0" strokeWidth="2.1" strokeLinejoin="round" strokeLinecap="round" opacity="0.45" />
      {/* distillation strata, narrowing as the field is filtered */}
      <line x1="10.5" y1="11.5" x2="21.5" y2="11.5" stroke="#e2e8f0" strokeWidth="2.1" strokeLinecap="round" opacity="0.8" />
      <line x1="13" y1="15" x2="19" y2="15" stroke="#e2e8f0" strokeWidth="2.1" strokeLinecap="round" />
      {/* neck + the single distilled survivor */}
      <line x1="16" y1="19" x2="16" y2="22.4" stroke="#f4b740" strokeWidth="2.1" strokeLinecap="round" />
      <circle cx="16" cy="25" r="2.6" fill="#f4b740" />
    </svg>
  );
}
