/**
 * Bundle the ES modules in src/ into one self-contained HTML file.
 *
 * The output is the shape the claude.ai Artifact is published in: index.html
 * with its module <script> replaced by every module, in dependency order,
 * inside one IIFE. Imports are dropped and `export` keywords stripped, so all
 * modules share one scope — which is why duplicate top-level names across
 * modules are a build error rather than a silent shadowing bug.
 *
 * No dependencies. Usage: node scripts/build.js [outDir]   (default: dist/)
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = 'src/main.js';
const TEMPLATE = 'index.html';
const MODULE_TAG = '<script type="module" src="./src/main.js"></script>';
const HEADER_WIDTH = 73;

const IMPORT_LINE = /^import \{([^}]*)\} from '(\.\/[\w.-]+\.js)';\n/gm;
const EXPORT_DECL = /^export (?=(?:async )?(?:function|const|let|class) )/gm;
const TOP_LEVEL_DECL = /^(?:async )?(?:function|const|let|class) ([A-Za-z_$][\w$]*)/gm;

/**
 * Read a module and the modules it imports.
 * @param {string} file Path relative to ROOT.
 * @returns {{ file: string, source: string, deps: string[] }}
 */
function readModule(file) {
  const source = readFileSync(join(ROOT, file), 'utf8');
  const deps = [];
  for (const m of source.matchAll(IMPORT_LINE)) {
    if (/\bas\b/.test(m[1])) throw new Error(`${file}: aliased imports are not supported by the bundler`);
    deps.push(join(dirname(file), m[2]));
  }
  if (/^import\b/m.test(source.replace(IMPORT_LINE, ''))) {
    throw new Error(`${file}: only single-line named imports from relative .js files are supported`);
  }
  if (/^export\b/m.test(source.replace(EXPORT_DECL, ''))) {
    throw new Error(`${file}: only \`export function|const|let|class\` is supported`);
  }
  if (/<\/script/i.test(source)) {
    throw new Error(`${file}: contains "</script", which would end the inline script early`);
  }
  return { file, source, deps };
}

/**
 * Modules reachable from the entry, dependencies first.
 * @param {string} entry
 * @returns {Array<{ file: string, source: string }>}
 */
function collect(entry) {
  /** @type {Array<{ file: string, source: string }>} */
  const order = [];
  const done = new Set();
  const active = new Set();

  /** @param {string} file */
  function visit(file) {
    if (done.has(file)) return;
    if (active.has(file)) throw new Error(`import cycle through ${file}`);
    active.add(file);
    const mod = readModule(file);
    for (const dep of mod.deps) visit(dep);
    active.delete(file);
    done.add(file);
    order.push(mod);
  }

  visit(entry);
  return order;
}

/**
 * Build the bundled HTML.
 * @param {object} [options]
 * @param {string} [options.preamble=''] HTML to place just before the game's
 *   script, such as a client library the page should find already loaded.
 * @returns {string}
 */
export function build({ preamble = '' } = {}) {
  const modules = collect(ENTRY);

  /** @type {Map<string, string>} */
  const owner = new Map();
  for (const { file, source } of modules) {
    for (const m of source.matchAll(TOP_LEVEL_DECL)) {
      const prev = owner.get(m[1]);
      if (prev) throw new Error(`top-level name "${m[1]}" is declared in both ${prev} and ${file}`);
      owner.set(m[1], file);
    }
  }

  const blocks = modules.map(({ file, source }) => {
    const head = `// ---- ${file} `;
    const body = source.replace(IMPORT_LINE, '').replace(EXPORT_DECL, '');
    return head + '-'.repeat(Math.max(4, HEADER_WIDTH - head.length)) + '\n' + body;
  });

  const script = "<script>\n(() => {\n'use strict';\n" + blocks.join('\n\n') + '\n})();\n\n</script>';

  const template = readFileSync(join(ROOT, TEMPLATE), 'utf8');
  const at = template.indexOf(MODULE_TAG);
  if (at < 0 || template.indexOf(MODULE_TAG, at + 1) >= 0) {
    throw new Error(`${TEMPLATE} must contain exactly one ${MODULE_TAG}`);
  }
  return template.slice(0, at) + preamble + script + template.slice(at + MODULE_TAG.length);
}

/**
 * The page content without its document skeleton, for publishing as a
 * claude.ai Artifact: the Artifact tool wraps what it is given in its own
 * skeleton, so the file handed to it starts at <title>.
 * @param {string} html A full document from {@link build}.
 * @returns {string}
 */
export function artifactBody(html) {
  const open = html.match(/^<!doctype html><html><head>[\s\S]*?<\/head><body>\n?/i);
  const close = html.match(/\n*<\/body><\/html>\s*$/i);
  if (!open || !close) throw new Error(`${TEMPLATE} must open with the Artifact skeleton and end with </body></html>`);
  return html.slice(open[0].length, close.index) + '\n';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = resolve(ROOT, process.argv[2] ?? 'dist');
  const html = build();
  const outputs = [
    ['vigame.html', html],             // standalone: open it from disk or any static host
    ['artifact.html', artifactBody(html)], // what to publish to claude.ai
  ];
  mkdirSync(outDir, { recursive: true });
  for (const [name, body] of outputs) {
    const out = join(outDir, name);
    writeFileSync(out, body);
    console.log(`wrote ${relative(process.cwd(), out)} (${(Buffer.byteLength(body) / 1024).toFixed(1)} KiB)`);
  }
}
