# Send to Affinity

Send a Figma selection to [Affinity](https://www.affinity.studio) as an editable document: live text, vectors, original-resolution images and native blur/shadow effects. Select several frames and they become artboards.

Everything runs locally. The Figma plugin talks to Affinity's built-in MCP server on `localhost:6767`, and the conversion runs inside Affinity. There's nothing to install in Affinity, and no account or cloud upload.

## Install

**Requirements:** Affinity 3.3 or later, and the Figma desktop app.

1. **Affinity:** go to **Settings → Model Context Protocol** and turn on both **Enable Affinity MCP** and **Access Files on your Desktop**. Images are saved alongside each import.
2. **Figma:** download this repo (**Code → Download ZIP**) or the latest [release](https://github.com/phillip-motion/send-to-affinity/releases), and unzip it. In Figma desktop, go to **Plugins → Development → Import plugin from manifest…** and choose **`figma-plugin/manifest.json`**.

That's it. The `figma-plugin` folder is ready to use; you don't need to build anything. Everything in `src/` is only for development.

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
| Angular gradients | Native conical gradients |
| Image fills, including tiled | Embedded images at original resolution, with crops kept; tiles repeat natively |
| Layer blur, drop shadow, inner shadow | Native Gaussian Blur, Outer Shadow and Inner Shadow, with spread |
| Background blur | A Gaussian Blur live filter masked to the layer |
| Progressive blur | A tilt-shift Depth of Field live filter inside the layer |
| Masks | Pixel masks, with Figma's alpha masks and blurred mask edges kept |
| Inside and outside strokes | Native inside and outside stroke alignment |

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

`npm run dev` rebuilds `figma-plugin/` at the repo root on every change; rerun the plugin in Figma to pick it up. `npm run build` does a single build. Commit `figma-plugin/` along with your source changes, since that's what people install. CI fails if it's out of date.

| Path | What it is |
| --- | --- |
| `figma-plugin/` | The built plugin people import. Generated; don't edit by hand |
| `src/figma/` | Plugin source: `code.js` (clones the selection, records text and effects, exports SVG), `ui.html` (panel), `bridge.js` (local MCP connection), `manifest.json` |
| `src/affinity/importer.js` | Runs inside Affinity: validates the SVG, rebuilds text, images, effects and artboards |
| `src/scripts/build.js` | Writes `figma-plugin/`, embedding the importer in the panel and the version from `src/package.json` |
| `src/test/` | Node tests and small fixtures |

To release, bump `version` in `src/package.json`, run `npm run build`, commit, then tag and push it (for example `git tag v0.6.3 && git push --follow-tags`). CI tests, checks the build and attaches the plugin zip to a GitHub release.

## Credits

The approach of sending SVG plus text metadata comes from [Quiver](https://github.com/phillip-motion/quiver) (MIT, see `third-party/Quiver-LICENSE.txt`).

## License

[MIT](LICENSE)
