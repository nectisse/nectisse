import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const machMagic = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

export async function nativeBinaries(directory) {
	const result = [];
	for (const name of (await readdir(directory)).sort()) {
		const path = join(directory, name);
		const stat = await lstat(path);
		if (stat.isDirectory()) {
			result.push(...(await nativeBinaries(path)));
		} else if (stat.isFile() && ((stat.mode & 0o111) !== 0 || /\.(?:so|dylib|node)$/.test(name))) {
			const file = await open(path, 'r');
			try {
				const header = Buffer.alloc(4);
				const { bytesRead } = await file.read(header, 0, 4, 0);
				if (bytesRead === 4 && machMagic.has(header.readUInt32BE(0))) {
					result.push(path);
				}
			} finally {
				await file.close();
			}
		}
	}
	return result;
}
