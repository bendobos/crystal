import { useEffect, useState } from 'react';
import type { Rect } from '../render/view';

export const MOBILE_BREAKPOINT = 760;

export interface Layout {
  mobile: boolean;
  width: number;
  height: number;
}

export function useLayout(): Layout {
  const get = (): Layout => ({ mobile: window.innerWidth < MOBILE_BREAKPOINT, width: window.innerWidth, height: window.innerHeight });
  const [layout, setLayout] = useState(get);
  useEffect(() => {
    const on = () => setLayout(get());
    window.addEventListener('resize', on);
    window.visualViewport?.addEventListener('resize', on);
    return () => {
      window.removeEventListener('resize', on);
      window.visualViewport?.removeEventListener('resize', on);
    };
  }, []);
  return layout;
}

/** Free area for the format frame, given which UI is covering the viewport. */
export function frameAreaFor(layout: Layout, panelOpen: boolean, sheetHeight: number): Rect {
  const { width: W, height: H } = layout;
  if (layout.mobile) {
    const top = 56;
    const bottom = sheetHeight + 8;
    return { x: 0, y: top, w: W, h: Math.max(80, H - top - bottom) };
  }
  const left = 72;
  const right = panelOpen ? 364 : 12;
  const top = 60;
  const bottom = 44;
  return { x: left, y: top, w: Math.max(80, W - left - right), h: Math.max(80, H - top - bottom) };
}
