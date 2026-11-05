/**
 * 服务端 Markdown 安全渲染（零依赖）。
 *
 * 与前端 web/public/js/prreview.js 的 _renderMarkdownSafe 同一算法：
 * 先对全文做 HTML 转义，再在转义后的文本上构建白名单标签——
 * 原始 Markdown 中的任何活动 HTML（脚本/事件属性/危险协议）都被转义成纯文本，
 * 天然防 XSS。独立报告预览（renderReportHtml）必须使用本模块，
 * 不得把 marked.parse 的原始输出直接拼进 HTML。
 *
 * A03 修复：marked 输出不再直接注入报告预览页。
 */

function escHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * D01 兜底检查：属性值内不得出现标签字符（'<' 或 '>'）。
 * 本模块生成的 HTML 中，双引号只作属性定界符（文本内容的引号已被 escHtml 转成实体），
 * 因此"双引号区间内出现 < 或 >"即说明有片段被展开进了属性槽——属注入前兆，直接判定不安全。
 * @param {string} html
 * @returns {boolean} true 表示不安全
 */
function hasAngleInsideAttr(html) {
    let inDq = false;
    for (const c of html) {
        if (c === '"') inDq = !inDq;
        else if (inDq && (c === '<' || c === '>')) return true;
    }
    return false;
}

/**
 * 把 Markdown 文本渲染为安全 HTML（全部输入先转义，活动 HTML 不存活）。
 * @param {string} text - Markdown 源文本
 * @returns {string} 安全 HTML
 */
export function renderMarkdownSafe(text) {
    // B01：输入中的 NUL 会破坏占位符机制，先剔除（Markdown 文本本就不允许 NUL）。
    // 同时也杜绝控制字符借其他解析路径存活。
    const esc = escHtml(String(text ?? '').replace(/\x00/g, ''));
    const lines = esc.split('\n');
    const out = [];
    let inCode = false, codeBuf = [];
    let listType = null;   // 'ul' | 'ol'
    let tableBuf = [];

    const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
    const flushTable = () => {
        if (!tableBuf.length) return;
        const parsed = tableBuf.filter(r => !/^\s*\|?[\s:|-]+\|?\s*$/.test(r)).map(r =>
            r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim()));
        if (parsed.length >= 2) {
            const [head, ...body] = parsed;
            out.push('<table><thead><tr>' + head.map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>'
                + body.map(r => '<tr>' + r.map(c => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
        } else if (parsed.length === 1) {
            out.push('<table><tbody><tr>' + parsed[0].map(c => `<td>${c}</td>`).join('') + '</tr></tbody></table>');
        }
        tableBuf = [];
    };
    // 行内格式（在已转义文本上）：行内代码、图片（仅 http/https）、链接（仅 http/https）、粗体、斜体。
    // B01：每种格式一生成标签就用 NUL 占位符保护，后续正则只在"纯文本+占位符"上运行，
    //      绝不重新扫描已生成的 HTML——避免替换插进属性制造事件属性。
    // C02：链接/强调先抽取再对内容递归渲染，占位符带 depth 命名空间，每层迭代展开并清除残留。
    // D01：占位片段只允许出现在"文本上下文"——
    //      href/src 只接受真实 URL（含占位符的 URL 一律不渲染为链接/图片，保持纯文本），
    //      属性值统一走属性上下文编码 + 文本槽（不引入标签字符）。
    const escAttr = (v) => String(v).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const renderInline = (s, depth) => {
        if (depth > 6) return s;
        const stash = [];       // 生成的 HTML 片段
        const stashText = [];   // 对应纯文本（仅属性槽使用）
        const mark = (html, text) => {
            const i = stash.push(html) - 1;
            stashText.push(text == null ? '' : String(text));
            return `\x00${depth}:${i}\x00`;
        };
        const marker = new RegExp(`\\x00${depth}:(\\d+)\\x00`, 'g');
        const hasMarker = new RegExp(`\\x00${depth}:\\d+\\x00`);
        // 把本层占位符展开为纯文本（属性槽用；不引入任何标签字符）
        const expandText = (v) => String(v).replace(marker, (_, ix) => stashText[Number(ix)] ?? '');
        const out = s
            .replace(/`([^`]+)`/g, (_, code) => mark(`<code>${code}</code>`, code))
            .replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (m, alt, url) => (url.includes('\x00')
                ? m   // URL 含占位片段：不渲染为图片（保持纯文本，稍后展开仍处文本上下文）
                : mark(`<img src="${escAttr(url)}" alt="${escAttr(expandText(alt))}" loading="lazy"/>`, expandText(alt))))
            .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, text, url) => (url.includes('\x00')
                ? m   // href 绝不接受占位片段
                : mark(`<a href="${escAttr(url)}" target="_blank" rel="noopener noreferrer">${renderInline(text, depth + 1)}</a>`, expandText(text))))
            .replace(/\*\*([^*]+)\*\*/g, (_, bold) => mark(`<b>${renderInline(bold, depth + 1)}</b>`, expandText(bold)))
            .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_, prefix, em) => prefix + mark(`<i>${renderInline(em, depth + 1)}</i>`, expandText(em)));
        // 迭代展开本层占位符（嵌套片段含内层占位符，单次 replace 不会重扫刚插入内容）；
        // 深度上界防环，残留占位符一律剔除，避免 NUL 泄漏进 HTML。
        let expanded = out;
        for (let i = 0; i < 20 && hasMarker.test(expanded); i++) {
            expanded = expanded.replace(marker, (_, ix) => stash[Number(ix)] ?? '');
        }
        return expanded.replace(marker, '');
    };
    const inline = (s) => renderInline(s, 0);

    for (const line of lines) {
        if (/^\s*```/.test(line)) {
            if (inCode) {
                out.push(`<pre><code>${codeBuf.join('\n')}</code></pre>`);
                codeBuf = []; inCode = false;
            } else {
                flushTable(); closeList(); inCode = true;
            }
            continue;
        }
        if (inCode) { codeBuf.push(line); continue; }

        if (/^\s*\|.*\|\s*$/.test(line)) { closeList(); tableBuf.push(line); continue; }
        flushTable();

        const h = line.match(/^(#{1,6})\s+(.*)$/);
        if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }

        if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { closeList(); out.push('<hr/>'); continue; }

        const q = line.match(/^\s*&gt;\s?(.*)$/);
        if (q) { closeList(); out.push(`<blockquote>${inline(q[1])}</blockquote>`); continue; }

        const ul = line.match(/^\s*[-*+]\s+(.*)$/);
        const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
        if (ul || ol) {
            const want = ul ? 'ul' : 'ol';
            if (listType !== want) { closeList(); listType = want; out.push(`<${want}>`); }
            out.push(`<li>${inline((ul || ol)[1])}</li>`);
            continue;
        }
        closeList();

        if (!line.trim()) { continue; }

        out.push(`<p>${inline(line)}</p>`);
    }
    if (inCode) out.push(`<pre><code>${codeBuf.join('\n')}</code></pre>`);
    flushTable(); closeList();
    const html = out.join('\n');
    // D01 兜底：属性值内出现标签字符说明占位片段被展开了进属性槽（注入前兆）。
    // 回到全转义纯文本——内容不丢，但不渲染任何标记，绝不放行可疑输出。
    if (hasAngleInsideAttr(html)) {
        return `<p>${esc.replace(/\n/g, '<br>')}</p>`;
    }
    return html;
}
