import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { citedImageBasenames, filterFixVerificationImages, fixShotsWereNotInspected, rejectedBaselineBasenames, rejectedBlackShotBasenames, reviewedImageBasenames, selectGalleryImages } from '../issueAnalysis/artifacts.js';
import { imageIsNearBlack } from '../issueAnalysis/blank-image.js';

test('结论文本里的图片文件名会被提取', () => {
    const names = citedImageBasenames('证据：fix-ohos-after4.jpeg、ohos-after.jpeg，过程图 fix-ohos-after.jpeg 未引用。');
    assert.deepEqual([...names].sort(), ['fix-ohos-after.jpeg', 'fix-ohos-after4.jpeg', 'ohos-after.jpeg']);
});

test('修复验证只保留结论点名的 fix 图，复现图全部保留', () => {
    const images = [
        { name: 'fix-ohos-after.jpeg' },
        { name: 'fix-ohos-after2.jpeg' },
        { name: 'fix-ohos-after4.jpeg' },
        { name: 'ohos-before.jpeg' },
        { name: 'android-after.png' },
    ];
    const cited = citedImageBasenames('视觉确认 fix-ohos-after4.jpeg');
    const kept = filterFixVerificationImages(images, cited).map((image) => image.name);
    assert.deepEqual(kept, ['fix-ohos-after4.jpeg', 'ohos-before.jpeg', 'android-after.png']);
});

test('复现结论标明非严格操作前的图会被去掉', () => {
    const text = 'ohos-before.jpeg 为迭代前第 1 版界面，非严格"操作前"对比图。ohos-after.jpeg 为复现后。';
    const rejected = rejectedBaselineBasenames(text);
    assert.deepEqual([...rejected], ['ohos-before.jpeg']);
    const images = [
        { name: 'ohos-before.jpeg' },
        { name: 'ohos-after.jpeg' },
        { name: 'android-after.png' },
    ];
    const kept = images.filter((image) => !rejected.has(image.name.toLowerCase())).map((image) => image.name);
    assert.deepEqual(kept, ['ohos-after.jpeg', 'android-after.png']);
});

test('结论没有点名 fix 图时，不把修复验证画廊清空', () => {
    const images = [{ name: 'fix-ohos-after.jpeg' }, { name: 'ohos-after.jpeg' }];
    const kept = filterFixVerificationImages(images, citedImageBasenames('只有日志，没有截图文件名'));
    assert.deepEqual(kept.map((image) => image.name), ['fix-ohos-after.jpeg', 'ohos-after.jpeg']);
});

test('写明没看图时，修复验证图不进画廊', () => {
    const text = [
        'look_at_image 工具在当前工具集不可用；截图作辅助证据归档。',
        '证据：fix-verify-ohos-after.jpeg、ohos-after.jpeg。',
    ].join('\n');
    assert.equal(fixShotsWereNotInspected(text), true);
    const images = [{ name: 'fix-verify-ohos-after.jpeg' }, { name: 'ohos-after.jpeg' }];
    const kept = filterFixVerificationImages(images, citedImageBasenames(text))
        .filter((image) => !(fixShotsWereNotInspected(text) && /^fix/i.test(image.name)));
    assert.deepEqual(kept.map((image) => image.name), ['ohos-after.jpeg']);
});

function png1x1(r, g, b) {
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const raw = Buffer.from([0, r, g, b]);
    const chunk = (type, data) => {
        const out = Buffer.alloc(12 + data.length);
        out.writeUInt32BE(data.length, 0);
        out.write(type, 4, 'ascii');
        data.copy(out, 8);
        const crc32 = (buf) => {
            let c = ~0;
            for (const byte of buf) {
                c ^= byte;
                for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
            }
            return ~c >>> 0;
        };
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        out.writeUInt32BE(crc32(body), 8 + data.length);
        return out;
    };
    return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('看图命令里的文件才会被当成审核过', () => {
    const text = [
        'node look-at-image.mjs --image /tmp/outputs/ohos-s1-after-final.jpeg --question "键盘"',
        '过程图 s1-seq-1.jpeg 没有交给模型',
    ].join('\n');
    assert.deepEqual([...reviewedImageBasenames(text)], ['ohos-s1-after-final.jpeg']);
});

test('有看图记录时画廊只留审核过且不是黑屏的图', () => {
    const images = [
        { name: 'ohos-s1-after-final.jpeg' },
        { name: 's1-seq-1.jpeg' },
        { name: 'android-start.png' },
        { name: 'ohos-s1-after.jpeg' },
    ];
    const kept = selectGalleryImages(images, {
        reviewed: reviewedImageBasenames('--image ohos-s1-after-final.jpeg --image ohos-s1-after.jpeg'),
        cited: new Set(),
        rejected: new Set(),
        blank: new Set(['ohos-s1-after.jpeg']),
    }).map((image) => image.name);
    assert.deepEqual(kept, ['ohos-s1-after-final.jpeg']);
});

test('没有看图记录时，过程连拍不进画廊', () => {
    const images = [
        { name: 's1-seq-3.jpeg' },
        { name: 'ohos-before.jpeg' },
    ];
    const kept = selectGalleryImages(images, {
        reviewed: new Set(),
        cited: new Set(),
        rejected: new Set(),
        blank: new Set(),
    }).map((image) => image.name);
    assert.deepEqual(kept, ['ohos-before.jpeg']);
});

test('纯黑 PNG 会被判成黑屏，有内容的不会', () => {
    assert.equal(imageIsNearBlack(png1x1(0, 0, 0)), true);
    assert.equal(imageIsNearBlack(png1x1(200, 180, 40)), false);
});

test('同一句写明黑屏的图会被去掉', () => {
    const text = 'fix-verify-ohos-after.jpeg 是息屏黑屏，不能当修复证据。ohos-after.jpeg 为复现界面。';
    assert.deepEqual([...rejectedBlackShotBasenames(text)], ['fix-verify-ohos-after.jpeg']);
});
