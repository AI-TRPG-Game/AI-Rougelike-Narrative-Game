// **测试运行器**（2026-10-06 新增）—— 逐文件计时 ＋ 单条硬超时 ＋ 子串过滤。
//
//   node game/src/test/run.mjs                    全跑（= `main.ts --tests`，但多计时与超时）
//   node game/src/test/run.mjs opening            只跑名字含 "opening" 的文件（子串匹配）
//   node game/src/test/run.mjs opening rules t0   跑多个
//   node game/src/test/run.mjs --list             只列文件（不跑）
//
// ── 为什么要有它（**补一个真事故，不是"顺手加个工具"**）──────────────────
// 2026-10-06 实测：`node game/src/main.ts --tests` 一轮要 **10 分钟以上还不结束**。
// 逐个文件量下来：**除 `prologue.test.ts` 外，全部文件合计只要 7 秒**。
// 追下去是 `prologue.test.ts` 里一条 `while (b.view().prologue) await clickPopup(...)` ——
// **点击被拒 ⇒ 账本不前进 ⇒ 条件恒为真 ⇒ 死循环**。
//
// 旧跑法的三个病灶，逐条治掉：
//   ① **一条挂住 = 整轮没有结论**（连"哪些过了"都看不到）—— 当事人只会以为"测试好慢"
//      ⇒ `harness.ts` 给**每条测试**加硬超时（默认 10s，`WULINE_TEST_TIMEOUT_MS` 可调），
//        超时算这条失败、控制权交还下一条。
//   ② **不能只跑一部分**（改一处规则要等全量）
//      ⇒ 支持子串过滤：改什么跑什么。
//   ③ **看不出慢在哪**（只能干等）
//      ⇒ 逐文件计时并按耗时排序 —— 下次"变慢了"一眼看得出是谁。
//
// ⚠️ **为什么不用子进程**（第一版就是那么写的）：本机沙箱**禁止 `spawnSync` 起 node**
//    （实测 `EBUSY`）。⇒ 改成**同进程逐文件跑**；隔离靠的**不是进程边界，而是 harness 的单条超时**。
//    隔离粒度还更细（**每条测试**，而不是每个文件）。
// ⚠️ 它与 `main.ts --tests` **等价**（同样的 `runAll`），只是多了计时/超时/过滤 ——
//    那条老路口一个字都没改，两边不会漂。
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { runAll } from './harness.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const filters = args.filter((a) => !a.startsWith('--'));

const all = readdirSync(HERE)
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => f.replace(/\.test\.ts$/, ''))
  .sort();

if (listOnly) {
  process.stdout.write(all.join('\n') + '\n');
  process.exit(0);
}

const files = filters.length > 0 ? all.filter((f) => filters.some((q) => f.includes(q))) : all;
if (files.length === 0) {
  process.stdout.write(`没有匹配的测试文件。可用：\n  ${all.join('\n  ')}\n`);
  process.exit(2);
}

/** 把 runAll 的 stdout 攒起来 —— 成功不刷屏，失败才把该文件那一段打出来 */
async function capture(fn) {
  const real = process.stdout.write.bind(process.stdout);
  let buf = '';
  process.stdout.write = (chunk) => { buf += chunk; return true; };
  try {
    await fn();
  } finally {
    process.stdout.write = real;
  }
  return buf;
}

const rows = [];
const t0 = Date.now();
for (const f of files) {
  const t = Date.now();
  const mod = await import(pathToFileURL(path.join(HERE, `${f}.test.ts`)).href);
  const buf = await capture(() => runAll(mod.suites));
  const ms = Date.now() - t;
  const failed = /❌ (\d+) 条失败/.exec(buf);
  const passed = /✅ 全部通过：(\d+) 条断言/.exec(buf);
  rows.push({
    file: f,
    ms,
    failed: failed ? Number(failed[1]) : 0,
    passed: passed ? Number(passed[1]) : 0,
    detail: buf,
    ok: !failed,
  });
}
const wall = Date.now() - t0;

process.stdout.write('\n══════════ 逐文件计时（慢的在最前）══════════\n');
for (const r of [...rows].sort((a, b) => b.ms - a.ms)) {
  const flag = r.ok ? `✅ ${r.passed} 条` : `❌ ${r.failed} 条失败`;
  process.stdout.write(`  ${r.file.padEnd(20)} ${String(r.ms).padStart(6)} ms   ${flag}\n`);
}

for (const r of rows.filter((x) => !x.ok)) {
  process.stdout.write(`\n──────── ${r.file} ────────\n`);
  process.stdout.write(r.detail.split('\n').filter((l) => l.includes('✗') || l.includes('→')).join('\n') + '\n');
}

const bad = rows.filter((r) => !r.ok);
const totalPass = rows.reduce((s, r) => s + r.passed, 0);
process.stdout.write('\n════════════════════════════════════════\n');
process.stdout.write(
  bad.length === 0
    ? `✅ 全部通过：${rows.length} 个文件 · ${totalPass} 条断言 · 墙钟 ${wall} ms\n`
    : `❌ ${bad.length} 个文件有问题（${bad.map((r) => r.file).join(', ')}）· 其余 ${rows.length - bad.length} 个文件 ${totalPass} 条断言通过 · 墙钟 ${wall} ms\n`,
);
process.exit(bad.length === 0 ? 0 : 1);
