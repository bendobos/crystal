import { useEffect } from 'react';
import { useStore } from '../model/store';

export function Toast() {
  const toast = useStore((s) => s.toast);
  const set = useStore((s) => s.set);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => set({ toast: null }), 2200);
    return () => window.clearTimeout(t);
  }, [toast, set]);
  return toast ? (
    <div className="toast" role="status">
      {toast}
    </div>
  ) : null;
}
