// Inlines src/ into one self-contained page: dist/index.html.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(root, 'src', p), 'utf8');
const LIBS = ['util', 'textchecks', 'docx', 'doc', 'rtf', 'pdfscan', 'scan', 'translate', 'samples'];
const js = [...LIBS.map((n) => read(`lib/${n}.js`)), read('app.js')].join('\n');
if (/<\/script/i.test(js)) throw new Error('JS contains a closing script tag');
const html = read('shell.html').replace('/*@CSS*/', () => read('styles.css')).replace('//@JS', () => js);
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'index.html'), html);
console.log(`dist/index.html: ${(html.length / 1024).toFixed(1)} KB`);
