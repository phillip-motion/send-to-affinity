# Send to Affinity

Send a Figma selection to [Affinity](https://www.affinity.studio) as an editable document: live text, vectors, original-resolution images and native blur/shadow effects. Select several frames and they become artboards.

Everything runs locally. The Figma plugin talks to Affinity's built-in MCP server on `localhost:6767`, and the conversion runs inside Affinity. There's nothing to install in Affinity, and no account or cloud upload.

## Install

**Requirements:** Affinity 3.3 or later, and the Figma desktop app.

1. **Affinity:** go to **Settings → Model Context Protocol** and turn on both **Enable Affinity MCP** and **Access Files on your Desktop**. Images are saved alongside each import.
2. **Figma:** download the latest zip from [Releases](https://github.com/phillip-motion/send-to-affinity/releases) and unzip it. Then go to **Plugins → Development → Import plugin from manifest…** and choose its `manifest.json`.

## Use

1. Select a layer, or several frames (they become artboards).
2. Run **Plugins → Development → Send to Affinity**.
3. Click the green button. A new Affinity document opens. Check any warnings, then save.

Each send creates a new document. It doesn't sync or overwrite anything, and your Figma file is never changed.

Photos fully hidden under an opaque image fill are left out automatically, so sends are faster and smaller. Transparent images and anything on top are always kept.

## What converts

| Figma | Affinity |
| --- | --- |
| Frames (multi-select) | Artboards with the original names, sizes and spacing |
| Text | Editable text frames with mixed fonts, sizes, colours, spacing and alignment |
| Linear-gradient text | Editable text with the gradient placed correctly |
| Vectors, shapes, gradients, clips | Affinity's SVG importer |
| Image fills | Embedded images at original resolution, with crops kept |
| Layer blur, drop shadow, inner shadow | Native Gaussian Blur, Outer Shadow and Inner Shadow |

Not converted (reported as warnings): background blur, auto layout, other filters, text with image fills or strokes, and centre/bottom vertically aligned text. Install the same fonts in both apps. Text wrapping and baselines can differ slightly between them.

## Develop

Requires Node 22+. There are no dependencies.

```bash
npm test
```

```bash
npm run dev
```

`npm run dev` rebuilds `dist/` on every change. In Figma, import `dist/manifest.json` once, then just rerun the plugin. `npm run build` does a single build.

| Path | What it is |
| --- | --- |
| `figma-plugin/` | Plugin source: `code.js` (clones the selection, records text and effects, exports SVG), `ui.html` (panel), `bridge.js` (local MCP connection) |
| `affinity/importer.js` | Runs inside Affinity: validates the SVG, rebuilds text, images, effects and artboards |
| `scripts/build.js` | Writes `dist/`, embedding the importer in the panel and the version from `package.json` |
| `test/` | Node tests and small fixtures |

To release, run `npm version patch` (or `minor`), then `git push --follow-tags`. CI tests and builds the plugin, then attaches the zip to a GitHub release.

## Credits

The approach of sending SVG plus text metadata comes from [Quiver](https://github.com/phillip-motion/quiver) (MIT, see `third-party/Quiver-LICENSE.txt`).

## License

[MIT](LICENSE)
