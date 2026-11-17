/**
 * 判断截图是不是近乎全黑。息屏、锁屏只剩底部横杠时，平均亮度很低。
 * PNG 自己解码；JPEG 在 macOS 上用 sips 缩成小图再算。解不了就不判黑，避免误删。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

const BLACK_LUMA = 18;

function paeth(left, up, upLeft) {
    const estimate = left + up - upLeft;
    const dl = Math.abs(estimate - left);
    const du = Math.abs(estimate - up);
    const dul = Math.abs(estimate - upLeft);
    if (dl <= du && dl <= dul) return left;
    if (du <= dul) return up;
    return upLeft;
}

function unfilterPng(raw, height, stride, bpp) {
    const out = Buffer.alloc(height * stride);
    const rowBytes = stride + 1;
    if (raw.length < height * rowBytes) return null;
    for (let y = 0; y < height; y += 1) {
        const filter = raw[y * rowBytes];
        const src = y * rowBytes + 1;
        const dst = y * stride;
        for (let x = 0; x < stride; x += 1) {
            const left = x >= bpp ? out[dst + x - bpp] : 0;
            const up = y > 0 ? out[dst - stride + x] : 0;
            const upLeft = y > 0 && x >= bpp ? out[dst - stride + x - bpp] : 0;
            const value = raw[src + x];
            if (filter === 0) out[dst + x] = value;
            else if (filter === 1) out[dst + x] = (value + left) & 255;
            else if (filter === 2) out[dst + x] = (value + up) & 255;
            else if (filter === 3) out[dst + x] = (value + Math.floor((left + up) / 2)) & 255;
            else if (filter === 4) out[dst + x] = (value + paeth(left, up, upLeft)) & 255;
            else return null;
        }
    }
    return out;
}

function averageSamples(pixels, width, height, channels) {
    const stepX = Math.max(1, Math.floor(width / 24));
    const stepY = Math.max(1, Math.floor(height / 24));
    let sum = 0;
    let count = 0;
    for (let y = 0; y < height; y += stepY) {
        for (let x = 0; x < width; x += stepX) {
            const p = (y * width + x) * channels;
            const luma = channels === 1
                ? pixels[p]
                : (0.299 * pixels[p]) + (0.587 * pixels[p + 1]) + (0.114 * pixels[p + 2]);
            sum += luma;
            count += 1;
        }
    }
    return count ? sum / count : null;
}

function pngAverageLuma(buffer) {
    if (buffer.length < 8 || buffer[0] !== 0x89 || buffer.toString('ascii', 1, 4) !== 'PNG') return null;
    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    const idat = [];
    while (offset + 8 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        const data = buffer.subarray(offset + 8, offset + 8 + length);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
            interlace = data[12];
        } else if (type === 'IDAT') {
            idat.push(data);
        } else if (type === 'IEND') {
            break;
        }
        offset += 12 + length;
    }
    if (!width || !height || bitDepth !== 8 || interlace !== 0 || ![0, 2, 6].includes(colorType)) return null;
    const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 1;
    let raw;
    try { raw = inflateSync(Buffer.concat(idat)); } catch { return null; }
    const pixels = unfilterPng(raw, height, width * channels, channels);
    if (!pixels) return null;
    return averageSamples(pixels, width, height, channels === 1 ? 1 : 3);
}

function bmpAverageLuma(buffer) {
    if (buffer.length < 54 || buffer.toString('ascii', 0, 2) !== 'BM') return null;
    const offset = buffer.readUInt32LE(10);
    const width = buffer.readInt32LE(18);
    const height = Math.abs(buffer.readInt32LE(22));
    const bpp = buffer.readUInt16LE(28);
    if (!width || !height || (bpp !== 24 && bpp !== 32)) return null;
    const channels = bpp / 8;
    const stride = Math.ceil((width * channels) / 4) * 4;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) {
        const srcY = buffer.readInt32LE(22) > 0 ? height - 1 - y : y;
        for (let x = 0; x < width; x += 1) {
            const src = offset + (srcY * stride) + (x * channels);
            const dst = (y * width + x) * 3;
            pixels[dst] = buffer[src + 2];
            pixels[dst + 1] = buffer[src + 1];
            pixels[dst + 2] = buffer[src];
        }
    }
    return averageSamples(pixels, width, height, 3);
}

function jpegAverageLuma(buffer) {
    if (process.platform !== 'darwin') return null;
    const dir = mkdtempSync(join(tmpdir(), 'ia-luma-'));
    const src = join(dir, 'in.jpg');
    const bmp = join(dir, 'out.bmp');
    try {
        writeFileSync(src, buffer);
        const result = spawnSync('sips', ['-s', 'format', 'bmp', '-z', '24', '24', src, '--out', bmp], { timeout: 8000 });
        if (result.status !== 0) return null;
        return bmpAverageLuma(readFileSync(bmp));
    } catch {
        return null;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/** @returns {boolean} 解得开且平均亮度低于黑屏阈值时为 true */
export function imageIsNearBlack(buffer) {
    if (!buffer || buffer.length < 8) return false;
    const luma = buffer[0] === 0x89 ? pngAverageLuma(buffer) : jpegAverageLuma(buffer);
    return luma != null && luma < BLACK_LUMA;
}
