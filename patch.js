#!/usr/bin/env node
'use strict';

/*
 * ZCode-RTL-Patch — per-block auto-RTL for Persian text in the ZCode desktop app.
 *
 *   repo:  https://github.com/SOMM-55/ZCODE-RTL-Patch
 *   works: ZCode 3.14.4 (Electron 41 / Chromium 146) on Linux — and any close
 *          version, as long as /out/renderer/index.html keeps a <style> block.
 *
 * WHAT IT DOES
 *   Rewrites out/renderer/index.html INSIDE /opt/ZCode/resources/app.asar,
 *   in place and with the EXACT same byte length, appending one CSS rule:
 *
 *     #root :is(p,li,h1,...,dt), #root .truncate, #root :is(input,textarea),
 *     #root div:not(:has(*)):not(:empty) { unicode-bidi: plaintext; text-align: start }
 *
 *   `unicode-bidi: plaintext` makes every block resolve its own direction from
 *   its first strong character (UAX#9 P2/P3): Persian/Arabic blocks render RTL
 *   and right-aligned, English blocks stay LTR and left-aligned, code blocks
 *   and the English UI chrome are untouched. The overall app layout stays LTR,
 *   so nothing in the chrome reflows. Previews (HTML/PDF/Office) run in
 *   separate webContents and are not affected.
 *
 * HOW IT STAYS SAFE
 *   The asar header stores every file's size and offset. The patch therefore
 *   replaces index.html with a byte-length-equal version (the startup <style>
 *   block is minified to free room, then padded with a CSS comment), so all
 *   offsets stay valid and only that one file's bytes change. A pristine
 *   backup is taken on first apply; `revert` restores it byte-for-byte.
 *   On Linux, Electron does not verify asar integrity hashes (that check only
 *   exists on Windows/macOS), so a same-size in-place write is fully valid.
 *
 * USAGE
 *   sudo node patch.js apply      # patch the app (backs up first, only once)
 *   sudo node patch.js revert     # restore the pristine backup
 *   node patch.js check           # report state, changes nothing
 *   node patch.js --asar PATH apply   # patch a custom path (tests, other installs)
 *
 *   Re-run `apply` after every ZCode update (the update replaces app.asar).
 */

const fs = require('fs');

const DEFAULT_ASAR = '/opt/ZCode/resources/app.asar';
const MARK = 'zcode-rtl-autodir';
const VERSION = '1.0.0';

// Target set: text-bearing blocks, truncated single-line labels (session
// titles), text inputs, and leaf divs (plain-text bubbles, badges, labels).
// NOT targeted: pre/code, xterm, Monaco, svg, elements with element children
// other than leaf divs — so code, terminals and icons stay exactly as before.
const CSS =
  '#root :is(p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,figcaption,dd,dt),' +
  '#root .truncate,' +
  '#root :is(input,textarea),' +
  '#root div:not(:has(*)):not(:empty)' +
  '{unicode-bidi:plaintext;text-align:start}';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { asar: process.env.ZCODE_ASAR || DEFAULT_ASAR, cmd: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--asar') args.asar = argv[++i];
    else if (a === '--help' || a === '-h') args.cmd = 'help';
    else if (a === '--version' || a === '-v') args.cmd = 'version';
    else if (!args.cmd) args.cmd = a;
    else throw new Error('unexpected extra argument: ' + a);
  }
  if (!args.cmd) args.cmd = 'check';
  return args;
}

function help() {
  console.log(
    'ZCode-RTL-Patch v' + VERSION +
    ' — per-block auto-RTL for Persian text in ZCode desktop.\n' +
    '\n' +
    'Usage:\n' +
    '  sudo node patch.js apply            patch the app (creates a backup first)\n' +
    '  sudo node patch.js revert           restore the pristine backup\n' +
    '  node patch.js check                 show current state (no changes)\n' +
    '  node patch.js --asar PATH <cmd>     operate on a custom asar path\n' +
    '  node patch.js --help | --version\n' +
    '\n' +
    "After 'apply', restart ZCode. Re-run 'apply' after every ZCode update.\n" +
    'Repo: https://github.com/SOMM-55/ZCODE-RTL-Patch\n'
  );
}

// ---------------------------------------------------------------------------
// asar reading / patching
// ---------------------------------------------------------------------------

function readHeader(buf) {
  const headerSize = buf.readUInt32LE(4);
  const strLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString('utf8', 16, 16 + strLen));
  return { headerSize, json, base: 8 + headerSize };
}

function findEntry(node, parts) {
  for (const p of parts) {
    node = node.files && node.files[p];
    if (!node) return null;
  }
  return node;
}

function getIndexEntry(buf) {
  const { json, base } = readHeader(buf);
  const entry = findEntry(json, ['out', 'renderer', 'index.html']);
  if (!entry || entry.offset === undefined)
    throw new Error(
      'out/renderer/index.html not found in asar — unsupported app version?'
    );
  return { offset: base + parseInt(entry.offset), size: entry.size };
}

// Minify the startup <style> block to free bytes, then append our rule and
// pad with a CSS comment so the block's BYTE length is exactly preserved.
// (The original block contains multi-byte UTF-8 comments, so every length
// comparison must be done in bytes, not JS string units.)
function rebuildStyleBlock(block) {
  const oldBytes = Buffer.byteLength(block, 'utf8');
  const TAIL = '/*' + MARK + '*/' + CSS;
  let css = block
    .replace(/^<style>/, '')
    .replace(/<\/style>$/, '')
    .replace(/\/\*[\s\S]*?\*\//g, '') // drop comments (incl. the CJK note)
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}:;,])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();
  css += TAIL;
  const grown = Buffer.byteLength('<style>' + css + '</style>', 'utf8');
  if (grown > oldBytes) throw new Error('style block grew; cannot keep byte size');
  const pad = oldBytes - grown;
  let rebuilt = '<style>' + css + '</style>';
  if (pad > 0) {
    if (pad < 6) throw new Error('pad too small for a CSS comment');
    // /* + (pad-4) filler chars + */  =>  exactly `pad` ASCII bytes
    const filler = '/*' + 'x'.repeat(pad - 4) + '*/';
    rebuilt =
      '<style>' + css.slice(0, css.length - TAIL.length) + filler + TAIL + '</style>';
  }
  if (Buffer.byteLength(rebuilt, 'utf8') !== oldBytes)
    throw new Error('padding arithmetic off');
  return rebuilt;
}

function buildPatchedAsar(buf) {
  const { offset, size } = getIndexEntry(buf);
  const html = buf.toString('utf8', offset, offset + size);
  if (html.includes(MARK)) return { buf, already: true };
  const styleStart = html.indexOf('<style>');
  const styleEnd = html.indexOf('</style>');
  if (styleStart < 0 || styleEnd < 0 || styleEnd < styleStart)
    throw new Error('startup <style> block not found in index.html');
  const oldBlock = html.slice(styleStart, styleEnd + '</style>'.length);
  const newBlock = rebuildStyleBlock(oldBlock);
  if (Buffer.byteLength(newBlock, 'utf8') !== Buffer.byteLength(oldBlock, 'utf8'))
    throw new Error('size mismatch after rebuild');
  const patched =
    html.slice(0, styleStart) + newBlock + html.slice(styleEnd + '</style>'.length);
  if (Buffer.byteLength(patched, 'utf8') !== Buffer.byteLength(html, 'utf8'))
    throw new Error('byte-length changed — refusing to write');
  const out = Buffer.from(buf);
  Buffer.from(patched, 'utf8').copy(out, offset);
  return { buf: out, already: false };
}

function isPatched(buf) {
  const { offset, size } = getIndexEntry(buf);
  return buf.toString('utf8', offset, offset + size).includes(MARK);
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function requireRoot(args) {
  if (args.asar !== DEFAULT_ASAR) return; // custom path (test): just needs write access
  if (process.getuid && process.getuid() !== 0)
    throw new Error('need root: run with sudo (writing to ' + DEFAULT_ASAR + ')');
}

function apply(args) {
  requireRoot(args);
  const buf = fs.readFileSync(args.asar);
  if (isPatched(buf)) {
    console.log('Already applied. Nothing to do.');
    return;
  }
  const backup = args.asar + '.orig-backup';
  const backupIsPatched = fs.existsSync(backup) && (() => {
    try {
      return isPatched(fs.readFileSync(backup));
    } catch {
      return true; // unreadable/corrupt backup — refresh it
    }
  })();
  if (!fs.existsSync(backup) || backupIsPatched) {
    console.log('Saving pristine backup to ' + backup);
    fs.copyFileSync(args.asar, backup);
  } else {
    console.log('Keeping existing pristine backup.');
  }
  const { buf: patched, already } = buildPatchedAsar(buf);
  if (already) {
    console.log('Already applied. Nothing to do.');
    return;
  }
  if (patched.length !== buf.length) throw new Error('asar length changed — refusing');
  const { offset, size } = getIndexEntry(buf);
  let diff = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] !== patched[i]) diff++;
  const within = diff > 0 && diff <= size;
  console.log(
    'changed bytes:', diff, '(index.html size:', size + ')', within ? 'OK' : 'UNEXPECTED'
  );
  if (!within) throw new Error('unexpected diff range — refusing to write');
  fs.writeFileSync(args.asar, patched);
  console.log('Patched OK. Restart ZCode to see the change.');
}

function revert(args) {
  requireRoot(args);
  const backup = args.asar + '.orig-backup';
  if (!fs.existsSync(backup)) throw new Error('no backup found: ' + backup);
  fs.copyFileSync(backup, args.asar);
  console.log('Reverted from backup. Restart ZCode.');
}

function check(args) {
  const buf = fs.readFileSync(args.asar);
  console.log('asar:', args.asar);
  console.log('patched:', isPatched(buf));
  console.log('backup exists:', fs.existsSync(args.asar + '.orig-backup'));
}

// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const commands = { apply, revert, check, help, version: () => console.log(VERSION) };
const run = commands[args.cmd];
if (!run) {
  console.error('unknown command: ' + args.cmd);
  help();
  process.exit(2);
}
try {
  run(args);
} catch (err) {
  console.error('error:', err.message);
  process.exit(1);
}
