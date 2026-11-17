/**
 * 从 state.yaml 读取 workingDirectory，并判断它是不是这次 run 的隔离目录。
 * 路径可以含空格；Windows 反斜杠和 POSIX 斜杠都认。
 */

export function readWorkingDirectory(yaml) {
    const match = /^workingDirectory:[ \t]*(.*)$/m.exec(String(yaml || ''));
    if (!match) return '';
    return decodeYamlScalar(match[1].trim());
}

function decodeYamlScalar(raw) {
    if (!raw || raw === '~' || raw === 'null' || raw === 'Null' || raw === 'NULL') return '';
    if (raw === '|' || raw === '>' || raw.startsWith('|') || raw.startsWith('>')) return '';
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
        return unescapeDoubleQuoted(raw.slice(1, -1));
    }
    if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
        return raw.slice(1, -1).replace(/''/g, "'");
    }
    return raw;
}

function unescapeDoubleQuoted(body) {
    let out = '';
    for (let i = 0; i < body.length; i += 1) {
        if (body[i] !== '\\') {
            out += body[i];
            continue;
        }
        const next = body[i + 1];
        if (next === undefined) break;
        i += 1;
        if (next === 'n') out += '\n';
        else if (next === 'r') out += '\r';
        else if (next === 't') out += '\t';
        else if (next === 'u' && /^[0-9a-fA-F]{4}/.test(body.slice(i + 1, i + 5))) {
            out += String.fromCharCode(Number.parseInt(body.slice(i + 1, i + 5), 16));
            i += 4;
        } else out += next;
    }
    return out;
}

/** 隔离目录的最后一级必须就是 runId。共享模板目录不能借这条规则读到。 */
export function isIsolatedRunDir(dir, runId) {
    if (!dir || !runId) return false;
    const id = String(runId).trim();
    if (!id || /[\\/]/.test(id)) return false;
    const normalized = String(dir).trim().replace(/\\/g, '/').replace(/\/+$/, '');
    return normalized.endsWith('/' + id);
}
