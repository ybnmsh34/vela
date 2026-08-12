/**
 * The Vela mark: a sail under two stars — the constellation Vela, "the Sails".
 *
 * Drawn inline so it inherits `currentColor` and needs no asset request under
 * the strict CSP. This is Vela's own identity; it must not be replaced with, or
 * drawn to resemble, any other product's mark.
 */

interface VelaMarkProps {
  readonly size?: number;
  readonly title?: string;
}

export function VelaMark({ size = 18, title }: VelaMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role={title === undefined ? 'presentation' : 'img'}
      aria-hidden={title === undefined}
      aria-label={title}
      focusable="false"
    >
      {title !== undefined && <title>{title}</title>}
      {/* sail — convex leech, foot on the baseline */}
      <path d="M6 3.4 C 12 8.6, 15.6 13.8, 17.1 20.6 L6 20.6 Z" fill="currentColor" />
      {/* mast */}
      <path
        d="M6 3.4 L6 20.6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      {/* the guide star */}
      <path
        d="M19.1 2.6 C 19.45 4.35 20.05 4.95 21.8 5.3 C 20.05 5.65 19.45 6.25 19.1 8 C 18.75 6.25 18.15 5.65 16.4 5.3 C 18.15 4.95 18.75 4.35 19.1 2.6 Z"
        fill="currentColor"
      />
    </svg>
  );
}
