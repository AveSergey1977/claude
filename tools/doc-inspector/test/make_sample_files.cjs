// Writes the in-page sample DOCX to test/fixtures/sample.docx (for DOC/RTF conversion).
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
global.window = {};
global.JSZip = require(process.argv[2] + '/jszip');
require('../src/lib/util.js');
require('../src/lib/samples.js');
window.LI.buildSampleDocx().then((buf) => writeFileSync(join(__dirname, 'fixtures', 'sample.docx'), Buffer.from(buf)));
