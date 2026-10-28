import { constants } from 'node:fs';
import { access, copyFile, link, realpath, stat, unlink } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';

export async function exportDirectoryIdentity(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('请选择一个绝对路径的保存文件夹。');
  const canonical = await realpath(directory);
  const info = await stat(canonical, { bigint: true });
  if (!info.isDirectory()) throw new Error('保存位置必须是文件夹。');
  await access(canonical, constants.W_OK);
  return { directory: canonical, dev: String(info.dev), ino: String(info.ino) };
}

export async function validateExportDirectory(destination) {
  const actual = await exportDirectoryIdentity(destination.directory);
  if (actual.directory !== destination.directory || actual.dev !== destination.dev || actual.ino !== destination.ino) {
    throw new Error('保存文件夹已移动或被替换，请重新选择。');
  }
  return actual;
}

export async function exportFileIdentity(path) {
  if (await realpath(path) !== path) throw new Error('导出文件位置已变化。');
  const info = await stat(path, { bigint: true });
  if (!info.isFile()) throw new Error('导出结果不是视频文件。');
  return [info.dev, info.ino, info.size, info.mtimeNs].map(String).join(':');
}

export function exportNameFor(name, lut) {
  const label = lut ? `${lut.look === 'vivid' ? 'Vivid' : 'Standard'}${lut.grid || ''}` : 'NoLUT';
  return `${basename(name, extname(name))}_${label}.mp4`;
}

export async function publishExport(source, destination, jobId, name, { removeSource = false } = {}) {
  await validateExportDirectory(destination);
  if (!/^[0-9a-f-]{36}$/.test(jobId) || !['.mp4', '.mkv'].includes(extname(source).toLowerCase())) throw new Error('导出结果格式无效。');
  const sourceIdentity = await exportFileIdentity(source);
  const characters = Array.from(basename(name, extname(name)).normalize('NFC').replace(/[^\p{L}\p{N}._ -]/gu, '_'));
  while (Buffer.byteLength(characters.join('')) > 144) characters.pop();
  const stem = characters.join('') || 'video';
  const fileName = `${stem}_影调_${jobId}${extname(source).toLowerCase()}`;
  const path = join(destination.directory, fileName);
  // Hard-link publication avoids another video-sized copy on the same volume.
  // Filesystems without links use an exclusive copy; existing files never win
  // a race by being overwritten. The UI reports completion only after success.
  try { await link(source, path); }
  catch (error) {
    if (!['EXDEV', 'EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'ENOSYS'].includes(error.code)) throw error;
    await copyFile(source, path, constants.COPYFILE_EXCL);
  }
  try {
    if (await exportFileIdentity(source) !== sourceIdentity) throw new Error('视频在保存期间发生变化，请重试。');
    await validateExportDirectory(destination);
    const info = await stat(path);
    if (info.size !== (await stat(source)).size) throw new Error('视频未完整保存，请重试。');
    const identity = await exportFileIdentity(path);
    if (removeSource) await unlink(source);
    return { path, directory: destination.directory, fileName, bytes: info.size, identity };
  } catch (error) {
    await unlink(path).catch(() => {});
    throw error;
  }
}
