# How it works — the full technical story

This document explains, end to end, how ZCode-RTL-Patch works and why it is built the way
it is. It assumes ZCode 3.14.4 on Linux (Electron 41 / Chromium 146); concepts apply to
nearby versions.

## 1. Where the problem lives

ZCode desktop is an Electron app:

```
/opt/ZCode/
├── zcode                    ← Electron binary
└── resources/
    ├── app.asar             ← the entire app (main + renderer) in one archive
    └── app.asar.unpacked/
```

Inspecting the archive shows the renderer entry is `out/renderer/index.html`, which loads
the minified CSS/JS bundles from `out/renderer/assets/`. Inside the renderer bundle:

- The UI locale set is only `{ "en-US", "zh-CN" }` — there is no `fa` locale, no `dir`
  attribute handling for RTL locales, no `[dir=rtl]` CSS anywhere, and no custom-CSS or
  user-stylesheet mechanism in the main process.
- Chat content is rendered with Tailwind (`.prose` typography for markdown,
  `.truncate` for single-line session titles), the composer is a Lexical editor, and
  xterm explicitly hard-codes `dir="ltr"` for the terminal.

So "make Persian RTL" cannot be a settings change — CSS has to reach the renderer. The
app exposes no supported injection point, so the patch edits the archive itself.

## 2. The CSS: per-block auto direction

The entire functional change is one rule appended to the startup `<style>` block:

```css
#root :is(p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, figcaption, dd, dt),
#root .truncate,
#root :is(input, textarea),
#root div:not(:has(*)):not(:empty) {
  unicode-bidi: plaintext;
  text-align: start;
}
```

### Why `unicode-bidi: plaintext`

`plaintext` tells the CSS bidi engine: *for this element, compute the paragraph base
direction from its own content, using UAX #9 rules P2/P3 (first strong character)*. This
is precisely "blocks detected as Persian render RTL, blocks detected as English stay LTR":

- `<p>این یک پاراگراف فارسی است</p>` → first strong char is Arabic-script → RTL paragraph,
  and `text-align: start` aligns it right.
- `<p>This is English.</p>` → first strong char is Latin → LTR, `start` = left: rendering
  is identical to before.
- Mixed text resolves per Unicode bidi rules with the detected base direction, which is
  the same algorithm native RTL chat apps use.

### Why not `dir="rtl"` or `direction: rtl`

`direction` controls *layout*, not just text: flex/grid ordering, `padding-inline-start`,
marker side, etc. Setting it globally would mirror the whole UI — icons, paddings, popper
positioning. `unicode-bidi: plaintext` changes only the bidi resolution + start alignment
of text, leaving the LTR layout system untouched. That is the whole design constraint:
**Persian text becomes RTL; nothing else moves.**

### Why these selectors

| Selector | Covers | Deliberately excludes |
|---|---|---|
| `:is(p, li, h1…h6, td, th, blockquote, figcaption, dd, dt)` | markdown-rendered chat text (the app uses Tailwind typography) | — |
| `.truncate` | single-line labels: session titles in the sidebar, breadcrumbs | — |
| `:is(input, textarea)` | what you type: search, composer fallback, single-line fields | (hidden xterm/Monaco textareas are off-screen; no visual effect) |
| `div:not(:has(*)):not(:empty)` | plain-text leaf divs: user message bubbles, badges, status lines | any div with element children — so icon wrappers, terminals (`xterm-rows` divs contain spans), Monaco lines, code blocks (`pre > code`) are never matched |

`pre`/`code` are simply never in the list, so code stays LTR even inside Persian replies.
The `#root` prefix keeps everything inside the main window; HTML/PDF/Office previews run in
their own webContents and cannot inherit this stylesheet.

### Known trade-off

List-item markers (`ul` bullets) are positioned by the container's layout direction, which
stays LTR — so Persian list items keep the bullet on the left while their text right-aligns.
Fixing marker side would require `direction: rtl` on those items, which reintroduces layout
mirroring. Per-block text correctness was chosen over marker cosmetics.

## 3. The asar surgery

`app.asar` is an [asar](https://github.com/electron/asar) archive:

```
bytes 0–3   : 4                                   (pickle size field)
bytes 4–7   : header pickle size H
bytes 8–11  : header string size = H − 8
bytes 12–15 : JSON header string length L
bytes 16…   : JSON header  { "files": { … } }     (every file: size, offset, integrity)
bytes 8+H…  : concatenated file payloads; `offset` in the JSON is relative to 8+H
```

The JSON header records **size** and **offset** for every file — plus a SHA-256
`integrity` entry. Any naive edit breaks the archive: change a length and every subsequent
file shifts; change bytes and the recorded hash goes stale.

The patch sidesteps both problems:

1. **Same-size write.** It never repacks. It locates `index.html`'s exact byte range in
   the archive and rewrites *only those bytes* with a patched version of the same byte
   length. All offsets/sizes in the header remain valid because nothing moves.
2. **Making room.** The patched rule needs ~200 bytes. The startup `<style>` block in
   `index.html` is hand-formatted (~2.9 KB) with indentation, blank lines and comments —
   the script minifies it (whitespace + comment removal, semantics-preserving) which frees
   ~1 KB, appends the rule, then pads with a `/*…*/` CSS comment so the block's **byte**
   length is *exactly* preserved.
3. **Byte math, not string math.** The original block contains multi-byte UTF-8 (a CJK
   review comment), so JavaScript string `.length` (UTF-16 units) does not equal byte
   length. Every comparison in the script uses `Buffer.byteLength(..., 'utf8')` — this was
   an actual bug during development, caught by the size verification and fixed.
4. **Integrity hashes.** Electron only validates asar integrity on Windows/macOS; on Linux
   the stored hash is never checked, so a stale entry for `index.html` is harmless. (The
   header is left byte-identical anyway.)

### Self-verification

`apply` refuses to write unless every check passes:

- `index.html` found and structure matches (`<style>` block present);
- patched content is byte-length-equal to the original;
- full-archive diff shows changed bytes **only** inside the `index.html` range;
- archive total length unchanged.

It also snapshots state: idempotent re-runs are no-ops, and the first `apply` copies
`app.asar` → `app.asar.orig-backup` (only if the existing backup isn't already a pristine
pre-patch copy, so updates + re-apply refresh the backup correctly). `revert` restores the
backup byte-for-byte.

## 4. Verification performed

- Dry-run on a copy of the real archive: header byte-identical, **0 diff bytes outside the
  `index.html` range**, total size unchanged, re-apply idempotent, revert byte-identical.
- The patched `index.html` loaded in Chromium 146: 10 original rules parse + the new rule
  appends as the 11th, no CSS parse errors.
- Visual check in Chromium with a chat-mock page carrying the exact injected rule
  ([demo/demo.html](../demo/demo.html)): Persian paragraphs/cells/titles right-aligned RTL,
  English left-aligned unchanged, code blocks LTR, mixed paragraphs ordered correctly.

## 5. Fail modes, by design

- Future ZCode versions that move/rename the renderer entry, drop the startup `<style>`,
  or grow the block beyond minification room → the script errors out **before writing**.
- The only writes ever performed are: `app.asar` (apply) and `app.asar.orig-backup`
  (backup/restore). Nothing else on the system is touched.
