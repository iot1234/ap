// Build browser JSX files into plain JS so production pages do not need
// browser-side Babel or JSX compilation.
const fs = require('node:fs');
const path = require('node:path');
const babel = require('@babel/core');

const root = path.join(__dirname, '..');
const projectDir = path.join(root, 'project');
const outDir = path.join(projectDir, 'build');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'build') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.jsx')) out.push(full);
  }
  return out;
}

function buildFile(src) {
  const rel = path.relative(projectDir, src);
  const outRel = rel.replace(/\.jsx$/i, '.js');
  const dest = path.join(outDir, outRel);
  const result = babel.transformFileSync(src, {
    babelrc: false,
    configFile: false,
    sourceType: 'script',
    presets: [[require.resolve('@babel/preset-react'), { runtime: 'classic' }]],
    comments: true,
    compact: false,
    filename: rel,
  });
  const wrapped = `;(function () {\n${result.code}\n})();\n`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, wrapped, 'utf8');
  return outRel.replace(/\\/g, '/');
}

fs.rmSync(outDir, { recursive: true, force: true });
const built = walk(projectDir).map(buildFile).sort();
console.log(`[build-frontend] built ${built.length} file(s) into project/build`);
for (const file of built) console.log(`  - ${file}`);
