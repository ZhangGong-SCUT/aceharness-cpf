#!/usr/bin/env node

process.env.ACE_INSTALL_ROOT = process.env.ACE_INSTALL_ROOT || require('path').resolve(__dirname, '..');

const cmd = process.argv[2];

// doctor 前置分发：跑包内零依赖脚本，不经 dist 构建产物，保证刚装完即可自检
if (cmd === 'doctor' || cmd === '自检') {
  import('../scripts/ace-doctor.mjs').catch(err => { console.error('ace doctor 加载失败:', err); process.exit(1); });
} else if (cmd === 'update') {
  // fork 构建锁定：ace update 会拉取上游 @cangjielang/aceharness latest，抹掉 CPF 定制工作流
  const pkg = require('../package.json');
  const lineage = pkg.config && pkg.config.aceLineage;
  if (lineage && !process.env.ACE_ALLOW_UPSTREAM_UPDATE) {
    console.error(`[ACE] 当前为 fork 构建（${lineage}${pkg.config.aceLineageCommit ? '@' + pkg.config.aceLineageCommit : ''}，v${pkg.version}）。`);
    console.error('[ACE] ace update 会切到上游 npm 版本并丢失 CPF 定制工作流，已阻止。');
    console.error('[ACE] 升级方式：源机重新 npm pack 后在目标机 npm install -g <新tgz>。');
    console.error('[ACE] 如确要升上游（将失去定制工作流）：设置 ACE_ALLOW_UPSTREAM_UPDATE=1 后重试。');
    process.exit(1);
  }
  require('../dist/cli.js');
} else {
  require('../dist/cli.js');
}
