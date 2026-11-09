/**
 * 与 scripts/runtime-root.mjs 相同的运行时根目录。
 * Windows 用 %APPDATA%\ACEHarness，设置了 XDG_DATA_HOME 时不用 ~/.aceharness。
 */
import { join } from 'node:path';
import { runtimeRoot } from '../../../scripts/runtime-root.mjs';

export function aceRuntimeRoot() {
    return runtimeRoot();
}

export function aceDataDir() {
    return join(aceRuntimeRoot(), 'data');
}

export function aceRunsDir() {
    return join(aceRuntimeRoot(), 'runs');
}

/** 终端向导创建的管理员可能没有 status 字段，未拒绝即视为可用。 */
export function isActiveAdmin(user) {
    return Boolean(user?.role === 'admin' && user.status !== 'pending' && user.status !== 'rejected');
}
