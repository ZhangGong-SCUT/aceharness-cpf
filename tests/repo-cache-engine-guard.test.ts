import { describe, expect, it } from 'vitest';
import { flutterEngineCloneBlock, flutterEngineCloneRequestBlock } from '../skills/cpf-ohos-issue-analysis/scripts/repo-cache.mjs';

const ENGINE = 'https://gitcode.com/CPF-Flutter/flutter_engine';
const FRAMEWORK = 'https://gitcode.com/CPF-Flutter/flutter_flutter';

describe('flutterEngineCloneBlock', () => {
  it('rejects flutter_engine clones at 3.35 and above', () => {
    expect(flutterEngineCloneBlock(ENGINE, 'oh-3.41.9-release')).toMatch(/禁止拉取 flutter_engine/);
    expect(flutterEngineCloneBlock(ENGINE, 'oh-3.35.7-dev')).toMatch(/禁止拉取 flutter_engine/);
    expect(flutterEngineCloneBlock(`${ENGINE}.git`, '3.44.9')).toMatch(/禁止拉取 flutter_engine/);
  });

  it('still allows flutter_engine below 3.35 and any framework clone', () => {
    expect(flutterEngineCloneBlock(ENGINE, 'oh-3.27.4-dev')).toBeNull();
    expect(flutterEngineCloneBlock(ENGINE, 'oh-3.22.0-dev')).toBeNull();
    expect(flutterEngineCloneBlock(ENGINE, 'dev')).toBeNull();
    expect(flutterEngineCloneBlock(FRAMEWORK, 'oh-3.41.9-release')).toBeNull();
  });

  it('rejects a flutter_engine request that never names a version below 3.35', () => {
    expect(flutterEngineCloneRequestBlock(ENGINE, ['oh-3.41.9-release', 'dev'])).toMatch(/禁止拉取 flutter_engine/);
    expect(flutterEngineCloneRequestBlock(ENGINE, ['dev'])).toMatch(/必须给出低于 3.35/);
    expect(flutterEngineCloneRequestBlock(ENGINE, ['', 'dev'])).toMatch(/必须给出低于 3.35/);
    expect(flutterEngineCloneRequestBlock(ENGINE, ['oh-3.27.4-dev', 'dev'])).toBeNull();
    expect(flutterEngineCloneRequestBlock(FRAMEWORK, ['dev'])).toBeNull();
  });
});
