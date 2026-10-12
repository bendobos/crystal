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
| Geometrie | `src/geometry/` | Zentripetale Catmull-Rom-Kurve nach Bogenlänge, rotationsminimierende Rahmen mit Holonomie-Korrektur, Sweep mit Strängen/Verdrehung/Endkappen, Feinform-Felder für den Pinsel, Freihand-Strich → Kurve (Kreuzungen über/unter) |
| Rendering | `src/render/` | Eigener Glas-Raytracer in WebGL2 auf `three-mesh-bvh`: deterministische Live-Vorschau (`MODE preview`) und progressiver spektraler Pathtracer (`path`); Studio-Umgebung aus analytischen Lichtkarten, Kuppel und endlichem Hintergrundkarton; AgX/Neutral-Tonemapping, Bloom, Vignette, Korn |
| Interaktion | `src/interaction/` | Kontrollpunkte, Glasbläser-Pinsel, Freihand, Lichtkugel und „Glanzlicht hierhin“ |
| Export | `src/export/` | Kachel-Renderer mit GPU-Fences (UI bleibt flüssig), PNG/JPEG in sRGB oder Display P3, Format-Sets als ZIP/Teilen-Dialog, MP4/WebM-Loops über WebCodecs + Mediabunny |
| UI | `src/ui/` | Seitenleiste (Desktop) bzw. Bottom-Sheet (Handy), Formatrahmen mit Geräte-Einblendung |

### Wichtige Entscheidungen

- **WYSIWYG:** Vorschau und Export teilen dieselben Shader-Bausteine. Die Vorschau folgt dem dominanten Lichtpfad (rauschfrei); der Pathtracer verzweigt stochastisch (Fresnel, mit Importance-Mix und stratifizierten ersten Entscheidungen) und tastet Wellenlängen spektral ab.
- **Feste Mesh-Topologie** pro Qualitätsstufe: Beim Ziehen wird die BVH nur „refittet“; nach dem Loslassen folgt ein SAH-Neuaufbau.
- **Hintergrundfarben sind exakt:** Die HDR-Radianz des Hintergrunds wird über die Umkehrung der Display-Transformation bestimmt (`render/color.ts` spiegelt den Composite-Shader).
- **Verfeinerung ohne Ruckeln:** Pfad-Samples laufen zeilenweise in einer Pumpe außerhalb von `requestAnimationFrame`; jedes Band wird erst nach dem GPU-Fence des vorherigen ausgegeben (`Engine.pump`).

### Messwerte (MacBook M2, Chrome)

- Live-Vorschau ≈ 12 ms/MP, Pathtracing ≈ 13 ms/MP pro Sample
- iPhone-Wallpaper 1206×2622, Qualität „Hoch“ (192 Samples): wenige Sekunden pro Megapixel
- Video „Schnell“: ≈ 0,1 s pro Bild bei 482×1048

### Entwicklung

- `window.engine` / `window.store` stehen im Dev-Build zum Debuggen bereit.
- `window.qa(name, { scale, samples, preview })` rendert das aktive Format offline und speichert es über den Dev-Server in `.qa/` (nur `npm run dev`).
- `engine.benchmark()` misst Vorschau- und Pathtracing-Kosten in ms pro Megapixel.
