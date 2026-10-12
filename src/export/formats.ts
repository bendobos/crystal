export interface FormatPreset {
  id: string;
  name: string;
  group: 'Handy' | 'Tablet' | 'Desktop' | 'Eigenes';
  width: number;
  height: number;
}

export const FORMATS: FormatPreset[] = [
  { id: 'iphone-pro-max', name: 'iPhone Pro Max', group: 'Handy', width: 1320, height: 2868 },
  { id: 'iphone-pro', name: 'iPhone / iPhone Pro', group: 'Handy', width: 1206, height: 2622 },
  { id: 'iphone-air', name: 'iPhone Air', group: 'Handy', width: 1260, height: 2736 },
  { id: 'iphone-classic', name: 'iPhone 12–15', group: 'Handy', width: 1179, height: 2556 },
  { id: 'android-qhd', name: 'Android QHD+', group: 'Handy', width: 1440, height: 3200 },
  { id: 'ipad-13', name: 'iPad Pro 13″', group: 'Tablet', width: 2064, height: 2752 },
  { id: 'ipad-11', name: 'iPad 11″', group: 'Tablet', width: 1668, height: 2420 },
  { id: 'mac-6k', name: '6K (Pro Display)', group: 'Desktop', width: 6016, height: 3384 },
  { id: 'mac-5k', name: '5K (Studio Display)', group: 'Desktop', width: 5120, height: 2880 },
  { id: 'uhd-4k', name: '4K UHD', group: 'Desktop', width: 3840, height: 2160 },
  { id: 'macbook-16', name: 'MacBook Pro 16″', group: 'Desktop', width: 3456, height: 2234 },
  { id: 'macbook-14', name: 'MacBook Pro 14″', group: 'Desktop', width: 3024, height: 1964 },
  { id: 'macbook-air', name: 'MacBook Air 13″', group: 'Desktop', width: 2560, height: 1664 },
  { id: 'ultrawide-5k2k', name: 'Ultrawide 5K2K', group: 'Desktop', width: 5120, height: 2160 },
  { id: 'ultrawide', name: 'Ultrawide 3440', group: 'Desktop', width: 3440, height: 1440 },
  { id: 'qhd', name: 'QHD 1440p', group: 'Desktop', width: 2560, height: 1440 },
];

export function formatById(id: string): FormatPreset | undefined {
  return FORMATS.find((f) => f.id === id);
}

export function isPortrait(w: number, h: number): boolean {
  return h > w;
}
