import { useEffect, useRef } from 'react';
import { Engine } from '../render/Engine';
import { useStore } from '../model/store';
import { setEngine } from '../render/engineRef';
import { useExport } from '../export/exportStore';

/** Hosts the WebGL canvas and keeps the engine in sync with the scene document. */
export function Viewport({ children }: { children?: React.ReactNode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const engine = new Engine(canvas, {
      onStatus: (status) => useStore.getState().set({ status }),
      onView: () => useStore.getState().bumpView(),
      onCameraEnd: (cam) => {
        const st = useStore.getState();
        st.setDoc(
          (d) => {
            const target = d.exportTargets.find((t) => t.id === d.activeTargetId);
            if (target?.camera) {
              return {
                ...d,
                exportTargets: d.exportTargets.map((t) => (t.id === target.id ? { ...t, camera: { ...cam, focalLength: t.camera!.focalLength } } : t)),
              };
            }
            return { ...d, camera: { ...cam, focalLength: d.camera.focalLength } };
          },
          { history: false },
        );
      },
    });
    setEngine(engine);
    engine.setDoc(useStore.getState().doc);
    engine.setTool(useStore.getState().tool === 'camera');
    engine.setDenoise(useExport.getState().settings.denoise);
    const unsubExport = useExport.subscribe((s) => engine.setDenoise(s.settings.denoise));
    const unsub = useStore.subscribe((s, prev) => {
      if (s.doc !== prev.doc) engine.setDoc(s.doc);
      if (s.tool !== prev.tool) engine.setTool(s.tool === 'camera');
    });
    Object.assign(window as object, { engine, store: useStore });
    return () => {
      unsub();
      unsubExport();
      setEngine(null);
      engine.dispose();
    };
  }, []);

  return (
    <div className="viewport">
      <canvas ref={canvasRef} className="viewport-canvas" />
      {children}
    </div>
  );
}
