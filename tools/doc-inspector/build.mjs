// Inlines src/ into two self-contained pages: dist/scanner.html and dist/translator.html.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(root, 'src', p), 'utf8');
// Published addresses of the two apps, used for the cross-links in their footers.
const links = existsSync(join(root, 'links.json')) ? JSON.parse(readFileSync(join(root, 'links.json'), 'utf8')) : {};

const PARSERS = ['util', 'textchecks', 'docx', 'doc', 'rtf', 'pdfscan', 'scan'];
const APPS = {
  scanner: { shell: 'shell-scan.html', libs: [...PARSERS, 'samples'], app: 'app-scan.js' },
  translator: { shell: 'shell-translate.html', libs: [...PARSERS, 'translate', 'samples'], app: 'app-translate.js' },
};

mkdirSync(join(root, 'dist'), { recursive: true });
for (const [name, a] of Object.entries(APPS)) {
  const js = [...a.libs.map((n) => read(`lib/${n}.js`)), read('common.js'), read(a.app)].join('\n');
  const linkJs = `window.APP_LINKS = ${JSON.stringify(links)};`;
  if (/<\/script/i.test(js + linkJs)) throw new Error('JS contains a closing script tag');
  const html = read(a.shell).replace('/*@CSS*/', () => read('styles.css')).replace('//@LINKS', () => linkJs).replace('//@JS', () => js);
  writeFileSync(join(root, 'dist', `${name}.html`), html);
  console.log(`dist/${name}.html: ${(html.length / 1024).toFixed(1)} KB`);
}
