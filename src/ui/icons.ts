// Inline SVG icons (24×24, stroke-based) so the UI needs no image assets.

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS: Record<string, string> = {
  add: svg('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 9v6M9 12h6"/>'),
  erase: svg('<path d="M7 20h12"/><path d="M5.5 14.5l8-8a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L12 18H9z"/><path d="M9.5 10.5l5 5"/>'),
  dig: svg('<path d="M14 4l6 6"/><path d="M17 7l-7.5 7.5"/><path d="M9.5 14.5l-3.2-.6a1 1 0 0 0-.9.3L3 16.6l4.4 4.4 2.4-2.4a1 1 0 0 0 .3-.9z"/>'),
  heat: svg('<path d="M12 21c3.9 0 6.5-2.6 6.5-6.2 0-3.3-2.3-5.4-3.7-7.6-.3 1.9-1.2 3-2.4 3.6.3-2.9-.8-5.6-3.4-7.8.2 3.4-1.3 5.4-2.7 7.2C5.1 11.6 5.5 12.9 5.5 15c0 3.5 2.6 6 6.5 6z"/>'),
  cool: svg('<path d="M12 2v20M4.2 6.5l15.6 11M19.8 6.5L4.2 17.5"/><path d="M9.5 3.5L12 6l2.5-2.5M9.5 20.5L12 18l2.5 2.5M3.3 10.2l3.4 1-1.1-3.3M20.7 13.8l-3.4-1 1.1 3.3M20.7 10.2l-3.4 1 1.1-3.3M3.3 13.8l3.4-1-1.1 3.3"/>'),
  explode: svg('<path d="M12 2l1.8 5.2L19 5l-2.2 5.2L22 12l-5.2 1.8L19 19l-5.2-2.2L12 22l-1.8-5.2L5 19l2.2-5.2L2 12l5.2-1.8L5 5l5.2 2.2z"/><circle cx="12" cy="12" r="2.2"/>'),
  pour: svg('<path d="M6 10a4.5 4.5 0 0 1 8.7-1.6A3.5 3.5 0 1 1 17.5 15H7a3 3 0 0 1-1-5.8z" transform="translate(0 -3)"/><path d="M8 16l-1 3M12 16l-1 3M16 16l-1 3"/>'),
  inspect: svg('<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5"/><path d="M10.5 8v5M8 10.5h5"/>'),
  play: svg('<path d="M7 4.5v15l12.5-7.5z"/>'),
  pause: svg('<path d="M8 5v14M16 5v14"/>'),
  undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  regen: svg('<path d="M20 11a8 8 0 0 0-14.8-4.2L4 9"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14.8 4.2L20 15"/><path d="M20 20v-5h-5"/>'),
  clear: svg('<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  save: svg('<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7V3M8 21v-7h8v7"/>'),
  load: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13l3-3 3 3"/>'),
  camera: svg('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
  film: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M3 15h18M7 5v4M12 5v4M17 5v4M7 15v4M12 15v4M17 15v4"/>'),
  settings: svg('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'),
  sound: svg('<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>'),
  mute: svg('<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l5 6M22 9l-5 6"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/><path d="M12 17.2v.3"/>'),
  speed: svg('<path d="M4 18a8.5 8.5 0 1 1 16 0"/><path d="M12 14l4-5"/>'),
  step: svg('<path d="M6 5v14l9-7z"/><path d="M18 5v14"/>'),
  minus: svg('<path d="M6 12h12"/>'),
  plus: svg('<path d="M12 6v12M6 12h12"/>'),
  fps: svg('<path d="M4 19V5M4 19h16"/><path d="M7 15l4-5 3 3 5-6"/>'),
};
