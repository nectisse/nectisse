import { nativeImage } from 'electron';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { ImageBytes } from '../platform/images';

const MAX_BYTES = 20 * 1024 * 1024;

export async function readAvatarFile(path: string): Promise<ImageBytes> {
	const file = await open(path, 'r');
	let bytes: Buffer;
	try {
		const info = await file.stat();
		if (!info.isFile() || info.size < 1 || info.size > MAX_BYTES) {
			throw new Error('请选择不超过 20 MiB 的 PNG、JPEG 或 WebP 图片');
		}
		const buffer = Buffer.alloc(info.size + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const result = await file.read(buffer, offset, buffer.length - offset, offset);
			if (!result.bytesRead) {
				break;
			}
			offset += result.bytesRead;
		}
		if (offset > info.size) {
			throw new Error('图片正在变化，请保存图片后重试');
		}
		bytes = buffer.subarray(0, offset);
	} finally {
		await file.close();
	}
	const supported =
		bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
		bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
		(bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP');
	if (!supported) {
		throw new Error('请选择 PNG、JPEG 或 WebP 图片');
	}
	const decoded = nativeImage.createFromBuffer(bytes);
	if (decoded.isEmpty()) {
		throw new Error('无法读取这张图片，请换一张图片');
	}
	const size = decoded.getSize();
	if (size.width * size.height > 40_000_000) {
		throw new Error('图片尺寸过大，请选择不超过 4000 万像素的图片');
	}
	const edge = Math.min(size.width, size.height);
	const square = decoded.crop({ x: Math.floor((size.width - edge) / 2), y: Math.floor((size.height - edge) / 2), width: edge, height: edge });
	const side = Math.min(edge, 512);
	const normalized = square.resize({ width: side, height: side, quality: 'best' }).toJPEG(88);
	return {
		bytes: normalized,
		asset: {
			sha256: createHash('sha256').update(normalized).digest('hex'),
			width: side,
			height: side,
			bytes: normalized.length,
			format: 'JPEG',
			quality: 'standard',
		},
	};
}
