#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
let distDir = path.join(root, 'dist');
const srcDir = path.join(root, 'src');

const entryFiles = [
  path.join(srcDir, 'cli.ts'),
  path.join(srcDir, 'lib', 'core', 'app-paths.ts'),
  path.join(srcDir, 'lib', 'core', 'command-exists.ts'),
  path.join(srcDir, 'lib', 'core', 'runtime-platform.ts'),
  path.join(srcDir, 'lib', 'core', 'schedule-validation.ts'),
  path.join(srcDir, 'lib', 'core', 'scheduler.ts'),
  path.join(srcDir, 'lib', 'core', 'models.ts'),
  path.join(srcDir, 'lib', 'core', 'user-store.ts'),
  path.join(srcDir, 'lib', 'core', 'markdown-utils.ts'),
  path.join(srcDir, 'lib', 'run', 'runtime-configs.ts'),
  path.join(srcDir, 'lib', 'engines', 'acp-engine.ts'),
  path.join(srcDir, 'lib', 'engines', 'engine-output.ts'),
  path.join(srcDir, 'lib', 'engines', 'acp-wrapper-base.ts'),
  path.join(srcDir, 'lib', 'engines', 'magic-cli-wrapper.ts'),
  path.join(srcDir, 'lib', 'rag', 'store.ts'),
];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function makeWritableRecursive(targetPath) {
  if (!fs.existsSync(targetPath)) return;

  let stat;
  try {
    stat = fs.lstatSync(targetPath);
  } catch {
    return;
  }

  try {
    fs.chmodSync(targetPath, 0o700);
  } catch {
    // Best effort only — some platforms/files may still reject chmod.
  }

  if (!stat.isDirectory() || stat.isSymbolicLink()) return;

  for (const entry of fs.readdirSync(targetPath)) {
    makeWritableRecursive(path.join(targetPath, entry));
  }
}

function cleanDir(dirPath) {
  if (!fs.existsSync(dirPath)) return;

  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
    return;
  } catch (error) {
    if (!error || (error.code !== 'EPERM' && error.code !== 'EACCES')) {
      throw error;
    }
  }

  try {
    makeWritableRecursive(dirPath);
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // Cannot clean — use an alternate dist directory to avoid the permission issue
    console.warn(`[build-cli] Warning: could not clean ${dirPath}, using alternate output dir`);
    distDir = path.join(root, 'dist-build');
  }
}

function resolveLocalModule(fromPath, specifier) {
  const candidates = [];

  if (specifier.startsWith('@/')) {
    const aliased = path.join(srcDir, specifier.slice(2));
    candidates.push(aliased);
  } else if (specifier.startsWith('.')) {
    candidates.push(path.resolve(path.dirname(fromPath), specifier));
  } else {
    return null;
  }

  for (const basePath of candidates) {
    const possiblePaths = [
      basePath,
      `${basePath}.ts`,
      `${basePath}.tsx`,
      `${basePath}.js`,
      `${basePath}.mjs`,
      path.join(basePath, 'index.ts'),
      path.join(basePath, 'index.tsx'),
      path.join(basePath, 'index.js'),
      path.join(basePath, 'index.mjs'),
    ];
    const hit = possiblePaths.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (hit) {
      return hit;
    }
  }

  return null;
}

function collectFiles() {
  const seen = new Set();
  const queue = [...entryFiles];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current) || !fs.existsSync(current)) continue;
    seen.add(current);

    const source = fs.readFileSync(current, 'utf8');
    const info = ts.preProcessFile(source, true, true);

    for (const imported of info.importedFiles) {
      const resolved = resolveLocalModule(current, imported.fileName);
      if (resolved && !seen.has(resolved)) {
        queue.push(resolved);
      }
    }
  }

  return Array.from(seen);
}

function transpileFile(inputPath) {
  const source = fs.readFileSync(inputPath, 'utf8');
  const relative = path.relative(srcDir, inputPath);
  const outputPath = path.join(distDir, relative).replace(/\.ts$/, '.js');
  const isCliEntry = relative === 'cli.ts';

  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
    },
    fileName: inputPath,
    reportDiagnostics: true,
  });

  if (result.diagnostics?.length) {
    const formatted = ts.formatDiagnosticsWithColorAndContext(result.diagnostics, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    });
    if (formatted.trim()) {
      console.error(formatted);
    }
  }

  ensureDir(path.dirname(outputPath));
  const banner = isCliEntry ? '#!/usr/bin/env node\n' : '';
  // Resolve @/ path aliases to relative paths for Node.js runtime
  let outputCode = result.outputText;
  const outputDir = path.dirname(outputPath);
  outputCode = outputCode.replace(/require\("@\/([^"]+)"\)/g, (_match, importPath) => {
    const absoluteTarget = path.join(distDir, importPath);
    let rel = path.relative(outputDir, absoluteTarget).replace(/\\/g, '/');
    if (!rel.startsWith('.')) rel = './' + rel;
    return `require("${rel}")`;
  });
  fs.writeFileSync(outputPath, banner + outputCode, 'utf8');
  if (isCliEntry) {
    fs.chmodSync(outputPath, 0o755);
  }
}

cleanDir(distDir);
ensureDir(distDir);
collectFiles().forEach(transpileFile);

// ── doctor 前置分发（fork）：dist/cli.js 未含 doctor 时打补丁 ──
// 使 `ace doctor` 在未重新构建 dist 的部署副本上同样可用（对齐 bin/ace.js 的行为）
(function patchDoctorDispatch() {
  const cliPath = path.join(distDir, 'cli.js');
  if (!fs.existsSync(cliPath)) return;
  let code = fs.readFileSync(cliPath, 'utf8');
  if (code.includes("=== \"doctor\"")) return; // 已含（新版构建产物自带）
  const anchor = 'if (command === "help") {';
  if (!code.includes(anchor)) { console.warn('[build-cli] 未找到 doctor 分发锚点，跳过补丁'); return; }
  const snippet = [
    'if (command === "doctor") {',
    '  const { pathToFileURL } = require("node:url");',
    '  Promise.resolve().then(() => import(pathToFileURL(require("node:path").join(__dirname, "..", "scripts", "ace-doctor.mjs")).href)).catch((err) => { console.error("ace doctor 加载失败:", err); process.exit(1); });',
    '  return;',
    '}',
    '',
  ].join('\n    ');
  code = code.replace(anchor, snippet + anchor);
  fs.writeFileSync(cliPath, code, 'utf8');
  console.log('[build-cli] 已注入 doctor 前置分发补丁');
})();
