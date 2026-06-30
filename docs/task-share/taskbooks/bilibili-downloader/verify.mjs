import { strict as assert } from 'node:assert';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const outputDir = process.env.TASK_OUTPUT_DIR;
const input = JSON.parse(process.env.TASK_INPUT || '{}');
const failures = [];

const bvMatch = input.bilibili_url?.match(/video\/(BV[\w]+)/);
const expectedBvid = bvMatch ? bvMatch[1] : null;

if (!existsSync(outputDir)) {
  failures.push({
    assertion: 'TASK_OUTPUT_DIR exists',
    expected: outputDir,
    actual: 'not found',
    hint: '任务未创建输出目录'
  });
  console.log(JSON.stringify(failures));
  process.exit(1);
}

async function findMp4Files(dir) {
  const results = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await findMp4Files(fullPath));
    } else if (entry.name.endsWith('.mp4')) {
      results.push(fullPath);
    }
  }
  return results;
}

const mp4Files = await findMp4Files(outputDir);

if (mp4Files.length === 0) {
  failures.push({
    assertion: 'mp4 file exists in subdirectory',
    expected: 'at least one .mp4 file under video title subfolder',
    actual: 'none found',
    hint: '下载可能失败，检查CDP和curl是否正常'
  });
  console.log(JSON.stringify(failures));
  process.exit(1);
}

const targetFile = expectedBvid ? mp4Files.find(f => f.includes(expectedBvid)) || mp4Files[0] : mp4Files[0];
const stat = statSync(targetFile);
const fileName = targetFile.split(/[\\/]/).pop();

if (stat.size === 0) {
  failures.push({
    assertion: 'file size > 0',
    expected: '> 0 bytes',
    actual: '0 bytes',
    hint: '文件为空，下载可能中断'
  });
}

if (expectedBvid && !fileName.includes(expectedBvid)) {
  failures.push({
    assertion: 'filename contains BV号',
    expected: 'contains ' + expectedBvid,
    actual: fileName,
    hint: '文件名应包含BV号'
  });
}

const header = readFileSync(targetFile).slice(0, 12);
const isValidMp4 = header.includes(Buffer.from('ftyp'));
if (!isValidMp4) {
  failures.push({
    assertion: 'valid mp4 header',
    expected: 'ftyp signature',
    actual: header.toString('hex'),
    hint: '文件可能损坏，检查ffmpeg合并是否成功'
  });
}

try {
  const probe = execSync('ffprobe -v quiet -print_format json -show_format -show_streams "' + targetFile + '"', { encoding: 'utf-8' });
  const info = JSON.parse(probe);
  if (!info.streams || info.streams.length === 0) {
    failures.push({
      assertion: 'video has streams',
      expected: 'at least 1 stream',
      actual: '0 streams',
      hint: '视频文件可能损坏'
    });
  }
} catch (e) {
  failures.push({
    assertion: 'ffprobe can read video',
    expected: 'successful probe',
    actual: e.message,
    hint: 'ffprobe未安装或文件损坏'
  });
}

if (failures.length > 0) {
  console.log(JSON.stringify(failures));
  process.exit(1);
}
process.exit(0);