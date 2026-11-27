/** Inline SVG icons — no icon dependency, no extra network requests. */

type IconProps = { size?: number; className?: string };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: 'false' as const,
});

export function TruckIcon({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M2 7.5h11v9H2z" />
      <path d="M13 11h4.5l3.5 3.2v2.3H13z" />
      <circle cx="6.4" cy="18.4" r="1.9" />
      <circle cx="17.2" cy="18.4" r="1.9" />
    </svg>
  );
}

export function UploadIcon({ size = 34, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.5}>
      <path d="M12 16V3" />
      <path d="M6.5 8.5 12 3l5.5 5.5" />
      <path d="M3.5 16.5v2.2A2.3 2.3 0 0 0 5.8 21h12.4a2.3 2.3 0 0 0 2.3-2.3v-2.2" />
    </svg>
  );
}

export function DownloadIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 3v12" />
      <path d="M7 10.5 12 15.5l5-5" />
      <path d="M4 19.5h16" />
    </svg>
  );
}

export function FilterIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={2}>
      <path d="M3 5h12l-4.5 5.5V16L7.5 14v-3.5L3 5Z" />
    </svg>
  );
}

export function CheckIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={2.2}>
      <path d="m4.5 12.5 4.6 4.5L19.5 6" />
    </svg>
  );
}

export function AlertIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 3.8 21 20H3z" />
      <path d="M12 10v4.2" />
      <path d="M12 17.3h.01" />
    </svg>
  );
}

export function InfoIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <path d="M12 7.8h.01" />
    </svg>
  );
}

export function RefreshIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M20 11a8 8 0 0 0-13.6-4.6L3 9.5" />
      <path d="M3 4.5v5h5" />
      <path d="M4 13a8 8 0 0 0 13.6 4.6L21 14.5" />
      <path d="M21 19.5v-5h-5" />
    </svg>
  );
}

export function ShieldIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 3 5 6v6c0 4 3 7.3 7 9 4-1.7 7-5 7-9V6z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </svg>
  );
}

/** Sort affordance: neutral arrows when unsorted, one solid arrow when active. */
export function SortIcon({ direction }: { direction: 'asc' | 'desc' | null }) {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
      className={`sort-icon${direction ? ' sort-icon--active' : ''}`}
    >
      <path
        d="M3 4.6 6 1.6l3 3"
        fill={direction === 'asc' ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={1.3}
        strokeLinejoin="round"
        opacity={direction === 'desc' ? 0.35 : 1}
      />
      <path
        d="M3 7.4 6 10.4l3-3"
        fill={direction === 'desc' ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={1.3}
        strokeLinejoin="round"
        opacity={direction === 'asc' ? 0.35 : 1}
      />
    </svg>
  );
}

export function SearchIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.4 15.4 4.1 4.1" />
    </svg>
  );
}

export function PlayIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M7 4.5 19 12 7 19.5z" />
    </svg>
  );
}
