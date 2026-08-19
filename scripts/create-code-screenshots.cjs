const fs = require('fs');
const path = require('path');

const outDir = path.resolve(__dirname, '../code-screenshots');

fs.mkdirSync(outDir, { recursive: true });

const snippets = [
  { file: '01_自然语言输入与原始答案生成.svg', title: '自然语言输入与原始答案生成', blocks: [{ source: 'web/src/adapters/model.ts', start: 155, end: 164 }, { source: 'web/src/pages/home/index.tsx', start: 352, end: 404 }] },
  { file: '02_知识库证据检索与召回打分.svg', title: '知识库证据检索与召回打分', blocks: [{ source: 'web/src/adapters/retrieval.ts', start: 43, end: 130 }] },
  { file: '03_原子声明拆解与结构化建模.svg', title: '原子声明拆解与结构化建模', blocks: [{ source: 'web/src/adapters/model.ts', start: 166, end: 203 }] },
  { file: '04_声明证据二分图边构建与状态判定.svg', title: '声明证据二分图边构建与状态判定', blocks: [{ source: 'web/src/adapters/model.ts', start: 205, end: 292 }, { source: 'web/src/core/pipeline.ts', start: 25, end: 50 }] },
  { file: '05_约束传播迭代与冲突级联更新.svg', title: '约束传播迭代与冲突级联更新', blocks: [{ source: 'web/src/core/graph.ts', start: 189, end: 292 }] },
  { file: '06_可信优化答案与解释链路输出.svg', title: '可信优化答案与解释链路输出', blocks: [{ source: 'web/src/core/optimizer.ts', start: 91, end: 134 }, { source: 'web/src/core/rewrite.ts', start: 8, end: 58 }] },
];

function escapeXml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function codeColor(code) {
  const trimmed = code.trim();
  if (/^\/\//.test(trimmed)) return '#7dd3fc';
  if (/^(function|async function|const|let|return|if|else|try|catch|await|for|while)\b/.test(trimmed)) return '#c084fc';
  if (/[`'"].*[`'"]/.test(trimmed)) return '#86efac';
  if (/\b(Status|Claim|Evidence|Record|string|number|boolean)\b/.test(trimmed)) return '#facc15';
  return '#e5e7eb';
}

for (const snippet of snippets) {
  const rows = [];
  for (const block of snippet.blocks) {
    const sourcePath = path.resolve(__dirname, '..', block.source);
    const lines = fs.readFileSync(sourcePath, 'utf8').split('\n');
    rows.push({ lineNumber: '', content: `// ${block.source}` });
    for (let lineNumber = block.start; lineNumber <= block.end; lineNumber += 1) {
      rows.push({ lineNumber, content: lines[lineNumber - 1] ?? '' });
    }
    rows.push({ lineNumber: '', content: '' });
  }
  while (rows.length && rows[rows.length - 1].content === '') rows.pop();

  const width = 1500;
  const rowHeight = 24;
  const top = 112;
  const height = top + rows.length * rowHeight + 42;
  const codeRows = rows
    .map((row, index) => {
      if (row.content === '' && row.lineNumber === '') return '';
      const y = top + index * rowHeight;
      return [
        `<text x="34" y="${y}" class="ln">${row.lineNumber}</text>`,
        `<text x="104" y="${y}" fill="${codeColor(row.content)}">${escapeXml(row.content || ' ')}</text>`,
      ].join('');
    })
    .join('\n');

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#0f172a"/>
      <stop offset="1" stop-color="#111827"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#020617" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect width="100%" height="100%" fill="#e5e7eb"/>
  <rect x="24" y="24" width="1452" height="${height - 48}" rx="18" fill="url(#bg)" filter="url(#shadow)"/>
  <circle cx="58" cy="56" r="7" fill="#ef4444"/>
  <circle cx="82" cy="56" r="7" fill="#f59e0b"/>
  <circle cx="106" cy="56" r="7" fill="#22c55e"/>
  <text x="132" y="62" fill="#f8fafc" font-size="22" font-family="Arial, sans-serif" font-weight="700">${escapeXml(snippet.title)}</text>
  <text x="34" y="92" fill="#94a3b8" font-size="15" font-family="Arial, sans-serif">ClaimTrace processing modules</text>
  <g font-family="Consolas, monospace" font-size="16" xml:space="preserve">
    <style>.ln{fill:#64748b;text-anchor:end}</style>
${codeRows}
  </g>
</svg>`;

  fs.writeFileSync(path.join(outDir, snippet.file), svg, 'utf8');
}

console.log(`created ${snippets.length} code screenshots in ${outDir}`);
