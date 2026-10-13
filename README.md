# Crystal

Web-App (PWA) zum Gestalten „mundgeblasener“ 3D-Glasobjekte und zum Export als Wallpaper (Desktop + Mobil) oder als nahtloser Video-Loop.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # Vitest
npm run build      # Typecheck + Produktions-Build inkl. Service Worker
```

## Architektur

| Bereich | Dateien | Kurz |
|---|---|---|
| Szenen-Dokument | `src/model/` | `SceneDoc` (reine Daten), Zustand-Store mit eigener Undo-Historie, Vorlagen, Teilen-Link (`serialize.ts`, Zod-validiert), Projekte in IndexedDB |
| Geometrie | `src/geometry/` | Zentripetale Catmull-Rom-Kurve nach Bogenlänge, rotationsminimierende Rahmen mit Holonomie-Korrektur, Sweep mit Strängen/Verdrehung/Endkappen, spitzen Enden und Dornen (Nebenröhren, mit Kehlen zu einem Mesh verschweißt, `blend.ts`; „Anzahl“ dünnt entworfene Dornen gleichmäßig aus oder ergänzt Sicheldornen in der Kurvenebene), Feinform-Felder für den Pinsel, Freihand-Strich → Kurve (Kreuzungen über/unter) |
| Rendering | `src/render/` | Eigener Glas-Raytracer in WebGL2 auf `three-mesh-bvh`: deterministische Live-Vorschau (`MODE preview`) und progressiver spektraler Pathtracer (`path`); Studio-Umgebung aus analytischen Lichtkarten, Kuppel und endlichem Hintergrundkarton; AgX/Neutral-Tonemapping, Bloom, Vignette, Korn |
| Interaktion | `src/interaction/` | Kontrollpunkte, Glasbläser-Pinsel, Freihand, Lichtkugel und „Glanzlicht hierhin“ |
| Export | `src/export/` | Kachel-Renderer mit GPU-Fences (UI bleibt flüssig), PNG/JPEG in sRGB oder Display P3, Format-Sets als ZIP/Teilen-Dialog, MP4/WebM-Loops über WebCodecs + Mediabunny |
| UI | `src/ui/` | Seitenleiste (Desktop) bzw. Bottom-Sheet (Handy), Formatrahmen mit Geräte-Einblendung |

### Wichtige Entscheidungen

- **WYSIWYG:** Vorschau und Export teilen dieselben Shader-Bausteine. Die Vorschau folgt dem dominanten Lichtpfad (rauschfrei); der Pathtracer verzweigt stochastisch (Fresnel, mit Importance-Mix und stratifizierten ersten Entscheidungen) und tastet Wellenlängen spektral ab.
- **Dornen aus einem Guss (`geometry/blend.ts`):** Hauptröhre und Dornen werden getrennt gesweept (nadelscharfe Spitzen). An jeder Austrittsstelle werden beide Meshes entlang ihrer Schnittlinie geschnitten. Punkte in Kehlnähe wandern auf die weiche Vereinigung beider Röhren (Kehlgröße höchstens so dick wie der dünnere Teil). Die Schnittränder werden verschweißt und Faltungen entwirrt. Ergebnis: ein geschlossenes Mesh ohne Innenflächen. Das kostet ≈ 0,25 s und läuft erst, wenn die Ansicht ruht; beim Ziehen überlappen die Röhren nur.
- **Feste Mesh-Topologie** pro Qualitätsstufe: Beim Ziehen wird die BVH nur „refittet“; nach dem Loslassen folgt ein SAH-Neuaufbau.
- **Hintergrundfarben sind exakt:** Die HDR-Radianz des Hintergrunds wird über die Umkehrung der Display-Transformation bestimmt (`render/color.ts` spiegelt den Composite-Shader).
- **Vorschau in Stufen:** Beim Ziehen rendert der deterministische Tracer mit adaptiver Auflösung. Sobald die Ansicht ruht, folgen 6 gejitterte Durchgänge in nativer Auflösung (scharf, rauschfrei, nach Sekundenbruchteilen). Danach läuft der Pathtracer nur im Bildbereich, der Glas sehen kann (projizierte Bounding-Box ∩ Rahmen), und wird ab 16 Samples überblendet.
- **GPU-Pacing (`render/adaptive.ts`):** Alle Hintergrundarbeit läuft in kurzen Bändern mit Fences. Die Viewport-Verfeinerung lässt die GPU per Duty-Cycle teilweise frei (`gpuBudget` je Stufe) und pausiert bei verdecktem Tab. Der Export nutzt kurze Draws (~24 ms), setzt aber nur etwa alle 120 ms einen Fence: Jeder Fence kostet eine Leerlauf-Rundreise.
- **Entrauscher (`render/denoise.ts`):** Standardmäßig an (Export-Option „Entrauschen“), mit etwa halber Sample-Zahl. Die verfeinerte Live-Vorschau nutzt denselben Schalter, damit Vorschau und Export gleich aussehen. Ein kantenerhaltender À-trous-Filter glättet das Pathtracing-Bild. Er stoppt an Kanten der rauschfreien Vorschau und an Unterschieden, die das gemessene Rauschen übersteigen. Kacheln rendern dafür einen Rand von 64 px mit. Bei 320 Samples misst er gegen eine 1536-Sample-Referenz so genau wie 640 Samples ohne Entrauscher.
- **Adaptives Sampling:** Der Akkumulator führt im Alpha-Kanal das zweite Moment mit. Ein Konvergenztest pro 8×8-Block schätzt den Fehler nach Tonemapping in 8-Bit-Stufen und beendet ruhige Blöcke (Maske monoton, Mittel bleibt korrekt).

### Messwerte (MacBook M2, Chrome)

- Deterministischer Tracer ≈ 6–10 ms/MP. Pathtracing: Hintergrund ≈ 3 ms/MP, Glaspixel ≈ 300–450 ms/MP pro Sample (lange Pfade). Die Exportzeit hängt fast nur von der Glasfläche ab.
- Viewport: scharfe Vorschau ≈ 0,3–0,5 s nach dem Loslassen
- Halbe iPhone-Auflösung 603×1311, „Maximal“: 78 s mit Entrauscher (320 Samples), 134 s ohne (640 Samples)
- Video „Schnell“: ≈ 0,1 s pro Bild bei 482×1048

### Entwicklung

- `window.engine` / `window.store` stehen im Dev-Build zum Debuggen bereit.
- `window.qa(name, { scale, samples, preview })` rendert das aktive Format offline und speichert es über den Dev-Server in `.qa/` (nur `npm run dev`).
- `window.qa(name, { …, tolerance, minSamples })` rendert mit adaptivem Sampling (Toleranz in 8-Bit-Stufen).
- `engine.benchmark()` misst Kosten in ms pro Megapixel: die scharfe Vorschau in nativer Auflösung und Pathtracing über den Glasbereich.
