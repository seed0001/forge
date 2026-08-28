import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;

const stroke = (p: P) => ({
  viewBox: '0 0 24 24',
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  className: 'icon',
  ...p,
});

export const IconFile = (p: P) => (
  <svg {...stroke(p)}><path d="M6 2.75h7L18 7.5v13.75H6z" /><path d="M13 2.75V7.5h5" /></svg>
);
export const IconFolder = (p: P) => (
  <svg {...stroke(p)}><path d="M3 6.5h5.5l2 2H21v10.5H3z" /></svg>
);
export const IconChevronRight = (p: P) => (
  <svg {...stroke(p)}><path d="M9.5 5.5l6.5 6.5-6.5 6.5" /></svg>
);
export const IconChevronDown = (p: P) => (
  <svg {...stroke(p)}><path d="M5.5 9.5l6.5 6.5 6.5-6.5" /></svg>
);
export const IconAgent = (p: P) => (
  <svg {...stroke(p)}>
    <rect x="4" y="7.5" width="16" height="11.5" rx="3" />
    <path d="M12 3.5v4" />
    <circle cx="9.25" cy="13.25" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="14.75" cy="13.25" r="1.15" fill="currentColor" stroke="none" />
  </svg>
);
export const IconTerminal = (p: P) => (
  <svg {...stroke(p)}><path d="M5 7.5l4.5 4.5L5 16.5" /><path d="M12.5 16.5H19" /></svg>
);
export const IconCheck = (p: P) => (
  <svg {...stroke(p)} strokeWidth={2.2}><path d="M4.5 12.5l5 5L19.5 7" /></svg>
);
export const IconCheckCircle = (p: P) => (
  <svg {...stroke(p)}><circle cx="12" cy="12" r="8.5" /><path d="M8.25 12.25l2.5 2.5L15.75 9.5" /></svg>
);
export const IconXCircle = (p: P) => (
  <svg {...stroke(p)}><circle cx="12" cy="12" r="8.5" /><path d="M9.25 9.25l5.5 5.5M14.75 9.25l-5.5 5.5" /></svg>
);
export const IconX = (p: P) => (
  <svg {...stroke(p)} strokeWidth={2}><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" /></svg>
);
export const IconPlus = (p: P) => (
  <svg {...stroke(p)} strokeWidth={2}><path d="M12 5.5v13M5.5 12h13" /></svg>
);
export const IconDot = (p: P) => (
  <svg {...stroke(p)}><circle cx="12" cy="12" r="7.5" /></svg>
);
export const IconBolt = (p: P) => (
  <svg {...stroke(p)} strokeLinejoin="round" fill="currentColor" stroke="none"><path d="M13 2.5L4.5 13.5h5.5L10 21.5l8.5-11.5h-5.5z" /></svg>
);
export const IconBrain = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M9 4a2.5 2.5 0 0 0-2.5 2.5A2.5 2.5 0 0 0 4 9c0 1 .5 1.9 1.3 2.4A2.5 2.5 0 0 0 4 13.7 2.5 2.5 0 0 0 6.5 16 2.5 2.5 0 0 0 9 18.5 2 2 0 0 0 11 20V4.5A2 2 0 0 0 9 4z" />
    <path d="M15 4a2.5 2.5 0 0 1 2.5 2.5A2.5 2.5 0 0 1 20 9c0 1-.5 1.9-1.3 2.4A2.5 2.5 0 0 1 20 13.7 2.5 2.5 0 0 1 17.5 16 2.5 2.5 0 0 1 15 18.5 2 2 0 0 1 13 20V4.5A2 2 0 0 1 15 4z" />
  </svg>
);
export const IconArrowUp = (p: P) => (
  <svg {...stroke(p)} strokeWidth={2.2}><path d="M12 19V6" /><path d="M6.5 11.5L12 6l5.5 5.5" /></svg>
);
export const IconStop = (p: P) => (
  <svg {...stroke(p)} fill="currentColor" stroke="none"><rect x="7.5" y="7.5" width="9" height="9" rx="1.5" /></svg>
);
export const IconFolderOpen = (p: P) => (
  <svg {...stroke(p)}><path d="M3 6.5h5.5l2 2H21v10.5H3z" /><path d="M3 11h18" /></svg>
);
export const IconDiff = (p: P) => (
  <svg {...stroke(p)}><path d="M8.5 3.5v17M15.5 3.5v17" /><path d="M4 8.5h4.5M15.5 8.5H20M4 15.5h4.5M15.5 15.5H20" /></svg>
);
export const IconUndo = (p: P) => (
  <svg {...stroke(p)}><path d="M4 8.5h9.5a5 5 0 0 1 0 10H8" /><path d="M7.5 4.5L3.5 8.5l4 4" /></svg>
);
export const IconEdit = (p: P) => (
  <svg {...stroke(p)}><path d="M4 20h4l10-10-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></svg>
);
export const IconMinusCircle = (p: P) => (
  <svg {...stroke(p)}><circle cx="12" cy="12" r="8.5" /><path d="M8.5 12h7" /></svg>
);
export const IconType = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M4 6.5V4.5h10v2" /><path d="M9 4.5v15" /><path d="M6.5 19.5h5" />
    <path d="M14 12.5v-1.5h6v1.5" /><path d="M17 11v8.5" />
  </svg>
);
export const IconCopy = (p: P) => (
  <svg {...stroke(p)}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M15 6.5V5a2 2 0 0 0-2-2H5.5a2 2 0 0 0-2 2V13a2 2 0 0 0 2 2H7" />
  </svg>
);
export const IconMic = (p: P) => (
  <svg {...stroke(p)}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
    <path d="M12 18v3" />
  </svg>
);
export const IconGlobe = (p: P) => (
  <svg {...stroke(p)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17" />
    <path d="M12 3.5c2.5 2.3 3.9 5.3 3.9 8.5s-1.4 6.2-3.9 8.5c-2.5-2.3-3.9-5.3-3.9-8.5S9.5 5.8 12 3.5z" />
  </svg>
);
export const IconEye = (p: P) => (
  <svg {...stroke(p)}><path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.75" /></svg>
);
export const IconRectangle = (p: P) => (
  <svg {...stroke(p)}><rect x="4" y="6" width="16" height="12" rx="1.5" /></svg>
);
export const IconArrowDiag = (p: P) => (
  <svg {...stroke(p)}><path d="M6 18L18 6" /><path d="M9 6h9v9" /></svg>
);
export const IconCpu = (p: P) => (
  <svg {...stroke(p)}>
    <rect x="7" y="7" width="10" height="10" rx="1.5" />
    <path d="M9.5 7V3.5M14.5 7V3.5M9.5 20.5V17M14.5 20.5V17M7 9.5H3.5M7 14.5H3.5M20.5 9.5H17M20.5 14.5H17" />
  </svg>
);
export const IconRefresh = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M4.5 12a7.5 7.5 0 0 1 12.6-5.5M19.5 12a7.5 7.5 0 0 1-12.6 5.5" />
    <path d="M17.5 3.5V7h-3.5M6.5 20.5V17H10" />
  </svg>
);
export const IconVolume = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" />
    <path d="M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11" />
  </svg>
);
export const IconVolumeOff = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" />
    <path d="M15.5 9.5l4.5 5M20 9.5l-4.5 5" />
  </svg>
);
export const IconSearch = (p: P) => (
  <svg {...stroke(p)}><circle cx="10.5" cy="10.5" r="6.5" /><path d="M19.5 19.5l-4.3-4.3" /></svg>
);
export const IconDownload = (p: P) => (
  <svg {...stroke(p)}><path d="M12 3.5v11" /><path d="M7 10l5 5 5-5" /><path d="M5 19.5h14" /></svg>
);
export const IconGear = (p: P) => (
  <svg {...stroke(p)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3.5v2.3M12 18.2v2.3M20.5 12h-2.3M5.8 12H3.5M17.66 6.34l-1.63 1.63M7.97 16.03l-1.63 1.63M17.66 17.66l-1.63-1.63M7.97 7.97L6.34 6.34" />
  </svg>
);
export const IconEyeOff = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M3.5 3.5l17 17" />
    <path d="M10.6 6.7A9.9 9.9 0 0 1 12 6.5c6 0 9.5 5.5 9.5 5.5a13.6 13.6 0 0 1-2.9 3.4M6.9 7.9C4.4 9.4 2.5 12 2.5 12s3.5 5.5 9.5 5.5a9.5 9.5 0 0 0 3.2-.55" />
    <path d="M9.6 9.9a2.75 2.75 0 0 0 3.9 3.9" />
  </svg>
);
export const IconRoadmap = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M5 6.5h2.2M5 12h2.2M5 17.5h2.2" />
    <path d="M6.1 6.5l1 1 1.8-2M6.1 17.5l1 1 1.8-2" />
    <circle cx="6.1" cy="12" r="1" />
    <path d="M11 6.5h8M11 12h8M11 17.5h8" />
  </svg>
);
export const IconArrowLeft = (p: P) => (
  <svg {...stroke(p)}><path d="M19 12H5" /><path d="M11 6l-6 6 6 6" /></svg>
);
export const IconArrowRight = (p: P) => (
  <svg {...stroke(p)}><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></svg>
);
export const IconCode = (p: P) => (
  <svg {...stroke(p)}><path d="M9 7L4 12l5 5" /><path d="M15 7l5 5-5 5" /></svg>
);
export const IconBookmark = (p: P) => (
  <svg {...stroke(p)}><path d="M6 3.5h12v17l-6-4-6 4v-17z" /></svg>
);
export const IconClock = (p: P) => (
  <svg {...stroke(p)}><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5.5l4 2.5" /></svg>
);
export const IconMessages = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M3.5 5.5h13v9h-8l-3.5 3v-3H3.5z" />
    <path d="M9.5 4h11v9h-3.5" />
  </svg>
);

