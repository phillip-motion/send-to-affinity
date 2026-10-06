# Send to Affinity

Send a Figma selection to [Affinity](https://www.affinity.studio) as an editable document: live text, vectors, original-resolution images and native blur/shadow effects.

<a href="https://github.com/phillip-motion/send-to-affinity/releases"><img width="166" height="48" alt="Download" src="https://github.com/user-attachments/assets/5b04e77e-d2f3-41ad-a1ba-069a65733352" /></a>

## Install

**Requirements:** Affinity 3.3 or later, and the Figma desktop app

1. **Affinity:** go to **Settings → Model Context Protocol** and turn on both **Enable Affinity MCP** and **Access Files on your Desktop**. Images are saved alongside each import.
2. **Figma:** download the [latest release](https://github.com/phillip-motion/send-to-affinity/releases), and unzip it. In Figma desktop, go to **Plugins → Development → Import plugin from manifest…** and choose **`figma-plugin/manifest.json`**.

## Use

1. Select a layer, or several frames (they become artboards).
2. Right click → **Plugins → Development → Send to Affinity**.
3. Click the green button to send to Affinity.

Each send creates a new document in Affinity. It doesn't overwrite anything, and your Figma file is never changed.

## What converts

| Figma | Affinity |
| --- | --- |
| Frames | Artboards with the original names, sizes and spacing |
| Text | Editable text frames with mixed fonts, sizes, colours, spacing and alignment |
| Linear-gradient text | Editable text with the gradient placed correctly |
| Vectors, shapes, gradients, clips | Affinity's SVG importer |
| Angular gradients | Native conical gradients |
| Image fills, including tiled | Embedded images at original resolution, with crops kept; tiles repeat natively |
| Layer blur, drop shadow, inner shadow | Native Gaussian Blur, Outer Shadow and Inner Shadow, with spread |
| Background blur | A Gaussian Blur live filter masked to the layer |
| Progressive blur | A tilt-shift Depth of Field live filter inside the layer |
| Masks | Pixel masks, with Figma's alpha masks and blurred mask edges kept |
| Inside and outside strokes | Native inside and outside stroke alignment |
| Glass | Dispersion is only partly reproduced |

Not converted (reported as warnings): diamond gradients, auto layout, other filters, and text with image fills or strokes. Install the same fonts in both apps. Text wrapping can differ slightly between them.

## Develop

Everything for development lives in `src/`. Requires Node 22+. There are no dependencies.

```bash
cd src
```

```bash
npm test
```

```bash
npm run dev
```

## Credits

The approach of sending SVG plus text metadata comes from [Quiver](https://github.com/phillip-motion/quiver) (MIT, see `third-party/Quiver-LICENSE.txt`).

## License

[MIT](LICENSE)
