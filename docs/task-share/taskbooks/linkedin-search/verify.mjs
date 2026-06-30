import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// verify 只管"产物层语义校验":worker 是否按 contract 产出了有效结果。
// 输入层校验(required 字段存在/有效)由 dispatcher 门禁负责,这里不重复。
const failures = [];
function fail(assertion, expected, actual, hint) { failures.push({ assertion, expected, actual, hint }); }
function parseJsonText(text, label) {
  try { return JSON.parse(text); }
  catch (error) { fail(label + ' is valid JSON', 'parseable JSON', error.message || String(error)); return null; }
}
function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

const outDir = process.env.TASK_OUTPUT_DIR || '.';
const outputFile = join(outDir, 'linkedin_search_results.json');
const taskInput = parseJsonText(process.env.TASK_INPUT || '{}', 'TASK_INPUT') || {};
const keyword = String(taskInput.keyword ?? '');

if (!existsSync(outputFile)) {
  fail('output artifact exists', 'linkedin_search_results.json', 'missing', 'worker must write the main JSON artifact');
} else {
  const data = parseJsonText(readFileSync(outputFile, 'utf8'), 'linkedin_search_results.json');
  if (data) {
    // 顶层字段
    for (const field of ['platform', 'keyword', 'retrievedAt', 'queryUrl', 'timeWindow', 'benchmark', 'results']) {
      if (!(field in data)) fail('output has field ' + field, 'present', 'missing');
    }

    // platform 标识
    if (String(data.platform ?? '').toLowerCase() !== 'linkedin') {
      fail('platform is LinkedIn', 'LinkedIn', data.platform);
    }

    // keyword 契约(产物层:worker 是否用了正确 keyword)
    if (String(data.keyword ?? '') !== keyword) fail('keyword matches TASK_INPUT.keyword', keyword, data.keyword);

    // queryUrl 是 LinkedIn 内容搜索(产物语义)—— 必须含 sortBy + datePosted(由 build-url.mjs 生成)
    const url = String(data.queryUrl ?? '');
    if (!url.includes('linkedin.com/search/results/content')) {
      fail('queryUrl is LinkedIn content search', 'contains linkedin.com/search/results/content', url);
    }
    if (!url.includes('keywords=')) {
      fail('queryUrl has keywords param', 'contains keywords=', url);
    }
    if (!url.includes('sortBy=%5B%22date_posted%22%5D')) {
      fail('queryUrl has sortBy=date_posted (latest sort)', 'contains sortBy=%5B%22date_posted%22%5D', url, 'URL must be built by build-url.mjs, not hand-crafted');
    }
    if (!url.includes('datePosted=%5B%22past-')) {
      fail('queryUrl has datePosted tier filter', 'contains datePosted=%5B%22past-24h|week|month%22%5D', url, 'URL must be built by build-url.mjs');
    }

    // timeWindow 契约(产物层:worker 是否守信地用了 dispatcher 给的 dateRange)
    if (!isPlainObject(data.timeWindow)) {
      fail('timeWindow is object', 'object with dateRange/timePhrase', data.timeWindow, 'worker must assemble timeWindow from input fields');
    } else {
      const tw = data.timeWindow;
      for (const field of ['dateRange', 'timePhrase']) {
        if (!(field in tw)) fail('timeWindow has field ' + field, 'present', 'missing');
      }
      // dateRange 必须是 LinkedIn 原生三档之一(不自造其他值)
      if (!['past-24h', 'past-week', 'past-month'].includes(String(tw.dateRange))) {
        fail('timeWindow.dateRange is LinkedIn native tier', 'past-24h|past-week|past-month', tw.dateRange);
      }
    }

    // benchmark 结构(产物层)
    if (!isPlainObject(data.benchmark)) {
      fail('benchmark is object', 'object', data.benchmark);
    } else {
      for (const field of ['stopReason', 'scrollRounds', 'totalDiscovered', 'inWindow']) {
        if (!(field in data.benchmark)) fail('benchmark has field ' + field, 'present', 'missing');
      }
    }

    // results 数组契约(产物层:全量落地 + 每条有效)
    if (!Array.isArray(data.results)) {
      fail('results is array', 'Array', typeof data.results);
    } else {
      // login_required 时 results 允许为空,且 benchmark.stopReason 应为 login_required
      const stopReason = String(data.benchmark?.stopReason ?? '');
      if (stopReason !== 'login_required' && data.benchmark && Number.isFinite(Number(data.benchmark.inWindow))) {
        // 全量落地一致性:results 条数应等于 benchmark.inWindow(过滤后全集,不丢)
        if (data.results.length !== Number(data.benchmark.inWindow)) {
          fail('results count matches benchmark.inWindow (full dump within window, no loss)',
            data.benchmark.inWindow, data.results.length,
            'dump all chunks and filter by window; do not truncate');
        }
      }

      data.results.forEach((item, index) => {
        if (!isPlainObject(item)) {
          fail('results[' + index + '] is object', 'object', item);
          return;
        }
        for (const field of ['content', 'url']) {
          if (!(field in item)) fail('results[' + index + '] has field ' + field, 'present', 'missing');
        }
        // authorName 或 authorHandle 至少一个
        if (!String(item.authorName ?? '').trim() && !String(item.authorHandle ?? '').trim()) {
          fail('results[' + index + '] has authorName or authorHandle', 'present', { authorName: item.authorName, authorHandle: item.authorHandle });
        }
        // postedAtLabel 或 postedAt 至少一个
        if (!String(item.postedAtLabel ?? '').trim() && !String(item.postedAt ?? '').trim()) {
          fail('results[' + index + '] has postedAtLabel or postedAt', 'present', { postedAtLabel: item.postedAtLabel, postedAt: item.postedAt });
        }
        // content 非空(LinkedIn 卡片文本至少 20 字符才有意义)
        if (String(item.content ?? '').trim().length < 20) {
          fail('results[' + index + '].content is meaningful', '>= 20 chars', String(item.content ?? '').length);
        }
        // authorHandle 若存在,必须是 /in/ 或 /company/(LinkedIn 身份链接)
        const handle = String(item.authorHandle ?? '').trim();
        if (handle && !handle.includes('/in/') && !handle.includes('/company/')) {
          fail('results[' + index + '].authorHandle is LinkedIn profile/company link', 'contains /in/ or /company/', handle);
        }
      });
    }
  }
}

if (failures.length) { console.log(JSON.stringify(failures, null, 2)); process.exit(1); }
console.log('PASS');
