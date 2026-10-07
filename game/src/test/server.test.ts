// P6+ · 服务端的**串行闸**（一次只跑一个动作）—— 行为 ＋ 接线
//
// 判据来自 2026-09-20 的实测（`.workbuddy/probe-concurrent.py`，报告见 `参考项目可借鉴机制.md` §1）：
//   **两个并发的 `POST /api/arrange` 全都生效了** —— 双调模型、`steps +2` 却只落 1 项、
//   两条随机流被交错消耗。参考项目用 `test-submission-replay.js` 把这件事当**服务端不变量**测
//   （两个并发提交必须返回同一份 `done`，且**模型只被调一次**）。
//
// ⚠️ 这里测的是**闸门本身**（`ui/gate.ts`，真的把它跑起来、真的把两条异步动作叠在一起）；
//    `ui/server.ts` 那半边是**静态断言** —— 字符串断言证明不了并发行为，它只能钉住
//    "闸门挂在 `await route(...)` 之前、放闸在 `finally` 里"这两件事别被挪走。
//    ⇒ **行为上的证据在探针里**（`python .workbuddy/probe-concurrent.py`，离线零花费）。
import { readFileSync } from 'node:fs';
import { busyPayload, labelOf, SerialGate } from '../ui/gate.ts';
import type { Suite } from './harness.ts';

const SRC = (): string => readFileSync(new URL('../ui/server.ts', import.meta.url), 'utf8');

/**
 * 剥掉注释再断言。
 *
 * ⚠️ 本仓的注释**会引用它正在解释的那段代码**（`ui.test.ts·bodyOf` 上面那条教训的同一族）——
 *    这一轮就被自己的注释判红过一次：我在闸门那段注释里写了「必须落在 `await route(...)` 之前」，
 *    于是 `indexOf('await route(')` 命中的是**注释**，而"闸门在它之前"当场为假。
 * ⚠️ 只能剥**整行** `//` 注释（与 `ui.test.ts` 同一手法）：剥行尾的那种会把字符串里的
 *    `//` 也吃掉（本文件下面的正则就带 `//`）。
 */
const 去注释 = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/** 一条模拟动作：占闸 → 跨一次 `await` → 放闸（与 `Session` 上的动作同构） */
async function job(g: SerialGate, name: string, out: string[]): Promise<void> {
  if (!g.enter(name)) {
    out.push(`${name}:拒`);
    return;
  }
  try {
    await new Promise((r) => setTimeout(r, 5));
    out.push(`${name}:跑完`);
  } finally {
    g.leave();
  }
}

const 串行闸: Suite = {
  name: 'P6+ · 服务端串行闸（同时只准一个动作）',
  register(t) {
    t.test('★ 第二个并发请求**被拒**，不是排队', () => {
      const g = new SerialGate();
      t.eq(g.enter('排布'), true, '第一个进得来');
      t.eq(g.enter('点选'), false, '★ 它在跑的时候第二个进不来（**不排队** —— 排队仍会把第二次送去模型）');
      t.eq(g.busy, '排布', '在跑的仍是第一个');
    });

    t.test('★ 真的把两条异步动作叠在一起：只有一条能进（这就是并发那件事本身）', async () => {
      const g = new SerialGate();
      const out: string[] = [];
      await Promise.all([job(g, 'A', out), job(g, 'B', out)]);
      // ⚠️ 顺序是**确定的**：B 的拒绝发生在它自己的同步段里（`enter` 当场返回 false），
      //    A 要等 5ms 才 push ⇒ 先 `B:拒`。若哪天改成了"排队"，这里会变成两条 `:跑完`。
      t.deep(out, ['B:拒', 'A:跑完'], '★ 一条跑完、一条被拒 —— 绝不是"两条都跑完"');
    });

    t.test('★ 放闸之后下一条能进来（闸门不会把自己锁死）', () => {
      const g = new SerialGate();
      g.enter('排布');
      g.leave();
      t.eq(g.busy, null, '空闲');
      t.eq(g.enter('进下一天'), true, '★ 放闸之后能开工');
      t.eq(g.enter('进下一天'), false, '★ 同一个动作也不放行两遍');
    });

    t.test('话术是**人话**（玩家看到的不是路径名）', () => {
      t.eq(labelOf('/api/arrange'), '排布');
      t.eq(labelOf('/api/whatever'), '上一个动作', '未登记的路由退回通用话术（**不是**回路径名）');
      const p = busyPayload('排布');
      t.ok(p.error.includes('排布'), `话术里带上"在跑什么"：${p.error}`);
      t.eq(p.busy, true, '带一个 `busy` 标记');
      t.ok(!('screen' in p), '★ 刻意**不带** `screen` —— 谁把它当信封用都会当场露馅，而不是刷成空白');
    });

    t.test('话术表覆盖 server.ts 里的每一条路由（漏了只会话术难看，这条断言是不让"上一个动作"变成常态）', () => {
      const src = 去注释(SRC());
      const routes = [...src.matchAll(/'(\/api\/[a-z/]+)'/g)].map((m) => m[1]);
      // ⚠️ 例外只有**一条判据**：**只读的**。闸门挂在"是不是 `POST /api/*`"上（见 `ui/gate.ts` 顶栏）
      //    ⇒ 只读的 GET 路由**永远不可能**成为"在跑的那个动作"，给它编一个动词反而是第二份真相。
      //    清单**逐个列出**（不写成 `/dev/` 前缀匹配）：将来真出现一条会动东西的 `/api/dev/*`，
      //    这一条照样会红 —— 那正是它存在的意义。
      const 只读的 = ['/api/view', '/api/dev/rev'];
      const 漏的 = [...new Set(routes)].filter((p) => !只读的.includes(p) && labelOf(p) === '上一个动作');
      t.deep(漏的, [], '★ server.ts 里出现的每条**会动东西的**路由都该有话术（只读的除外）');
    });

    // ── 接线（静态断言：扫 `ui/server.ts` 的源代码）────────────────

    t.test('★ 闸门挂在 `await route(...)` **之前**，放闸在 `finally` 里', () => {
      const s = 去注释(SRC());
      const iEnter = s.indexOf('gate.enter(');
      const iRoute = s.indexOf('await route(');
      const iLeave = s.indexOf('gate.leave()');
      t.ok(iEnter > 0 && iRoute > 0 && iLeave > 0, '三个锚点都该在（改名了就要改这条断言）');
      t.ok(iEnter < iRoute, '★ 先占闸、再干活 —— 挂到 `autoSave` 那一层没有用（动作跨 await）');
      const 闸门区 = s.slice(iEnter, iLeave);
      t.ok(闸门区.includes('finally'), '★ 放闸必须在 `finally`：抛错与 404 早返回都要放，否则整局卡在"忙"上');
    });

    t.test('★ 撞闸回的是 `409` ＋ 那句话术（不是 200，也别在路由里另编一句）', () => {
      const s = 去注释(SRC());
      t.ok(s.includes('sendJson(res, 409, busyPayload('), '409 由 `busyPayload` 统一供话 —— 一处实现');
      t.ok(!s.includes("error: '正在处理"), '不许在 server.ts 里另写一份"忙"的文案');
    });
  },
};

export const suites: Suite[] = [串行闸];
