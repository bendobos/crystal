import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;

function Icon({ children, ...p }: P & { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...p}>
      {children}
    </svg>
  );
}

export const IconOrbit = (p: P) => (
  <Icon {...p}>
    <ellipse cx="12" cy="12" rx="9" ry="4" />
    <path d="M12 3a4 9 0 0 1 0 18" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" />
  </Icon>
);
export const IconPoints = (p: P) => (
  <Icon {...p}>
    <path d="M4 17c3-9 6-9 8-5s5 4 8-5" />
    <circle cx="4" cy="17" r="2" fill="currentColor" />
    <circle cx="12" cy="12" r="2" fill="currentColor" />
    <circle cx="20" cy="7" r="2" fill="currentColor" />
  </Icon>
);
export const IconBrush = (p: P) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8" strokeDasharray="2.5 2.5" />
    <circle cx="12" cy="12" r="3" fill="currentColor" />
  </Icon>
);
export const IconDraw = (p: P) => (
  <Icon {...p}>
    <path d="M3 17c2-1 3-6 6-6s2 6 5 6 4-9 7-10" />
    <path d="M17 3l4 4-2 1-3-3z" fill="currentColor" />
  </Icon>
);
export const IconLight = (p: P) => (
  <Icon {...p}>
    <rect x="8" y="3" width="8" height="12" rx="1.5" />
    <path d="M12 18v3M7 20l1-2M17 20l-1-2" />
  </Icon>
);
export const IconUndo = (p: P) => (
  <Icon {...p}>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
  </Icon>
);
export const IconRedo = (p: P) => (
  <Icon {...p}>
    <path d="M15 14l5-5-5-5" />
    <path d="M20 9H10a6 6 0 0 0 0 12h3" />
  </Icon>
);
export const IconShare = (p: P) => (
  <Icon {...p}>
    <path d="M12 3v12M7 8l5-5 5 5" />
    <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
  </Icon>
);
export const IconDownload = (p: P) => (
  <Icon {...p}>
    <path d="M12 3v12M7 10l5 5 5-5" />
    <path d="M4 19h16" />
  </Icon>
);
export const IconFolder = (p: P) => (
  <Icon {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Icon>
);
export const IconDice = (p: P) => (
  <Icon {...p}>
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <circle cx="9" cy="9" r="1.2" fill="currentColor" />
    <circle cx="15" cy="15" r="1.2" fill="currentColor" />
    <circle cx="15" cy="9" r="1.2" fill="currentColor" />
    <circle cx="9" cy="15" r="1.2" fill="currentColor" />
  </Icon>
);
export const IconPlus = (p: P) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);
export const IconTrash = (p: P) => (
  <Icon {...p}>
    <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
  </Icon>
);
export const IconClose = (p: P) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);
export const IconFit = (p: P) => (
  <Icon {...p}>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);
export const IconChevron = (p: P) => (
  <Icon {...p}>
    <path d="M6 9l6 6 6-6" />
  </Icon>
);
export const IconSparkle = (p: P) => (
  <Icon {...p}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
  </Icon>
);
export const IconVideo = (p: P) => (
  <Icon {...p}>
    <rect x="3" y="6" width="13" height="12" rx="2" />
    <path d="M16 10l5-3v10l-5-3z" />
  </Icon>
);
export const IconPhone = (p: P) => (
  <Icon {...p}>
    <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
    <path d="M11 5h2" />
  </Icon>
);
export const IconMonitor = (p: P) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="12" rx="1.5" />
    <path d="M9 20h6M12 16v4" />
  </Icon>
);
