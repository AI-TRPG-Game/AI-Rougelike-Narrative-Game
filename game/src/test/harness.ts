// 零依赖测试夹具
//
// 不用 `node --test`：① 输出想按"断言点 = 判据出处"来组织；② 探针那边已经吃过一次
// "判定条件没写清 ⇒ 把'没测到'当成'测到了'"的亏（见 Phase 0 §方法论）。
// 这里每个断言都带出处，失败时直接告诉你**哪条设计规则被违反了**。
//
// ⚠️ **2026-09-18（Phase 2）加 async 支持**：`turn/` 全线 async（真实 LLM 必然异步），
//    于是集成用例也开始 await。两条纪律：
//    · `test(name, fn)` 的 `fn` 可以是 `async` —— `runAll` 会逐个 await；
//    · **`register(t)` 本身仍是同步的**：`t.test` 只把用例**压进队列**，
//      由 `runAll` 逐个 await 排干 ⇒ 既保持"注册即声明"的写法，又不丢 async。
//    · 异步抛错用 `t.rejects(...)`（`t.throws` 只能接同步抛错）——它**自动被 await**，
//      不需要在用例里手写 `await`（少了这个"自动"，漏写 await 会静默算通过）。
//
// ⚠️⚠️ **2026-10-06 加「每条测试硬超时」**（**这一条是补一个真事故，不是顺手加功能**）：
//    实测 `node game/src/main.ts --tests` 要 **10 分钟以上还不结束**，逐个文件量下来
//    才定位到 `prologue.test.ts` 里一条 `while (… ) await clickPopup(...)` ——
//    **点击被拒 ⇒ 账本不前进 ⇒ 条件恒为真 ⇒ 死循环**。它的代价不是"慢"，是
//    **整轮测试没有结论**（连"哪些过了"都看不到），而当事人只会觉得"测试好慢"。
//    ⇒ `runAll` 现在给**每条**测试加一个超时（默认 10s，可用
//      `WULINE_TEST_TIMEOUT_MS` 覆盖），超时算**这条失败**并把控制权交还给下一条。
//    ⚠️ **能打断的前提是那个循环是 async 的**（`await` 会让出事件循环 ⇒ `Promise.race` 拿得到手）。
//      纯同步的 `while(true){}` 谁也救不了 —— 那是为什么本条纪律还要配一句：
//      **写循环时一律给硬上界**（见 `prologue.test.ts` 那段注释）。

export interface T {
  /** name 建议写成「判据出处 · 断言」 */
  test(name: string, fn: () => void | Promise<void>): void;
  eq(actual: unknown, expected: unknown, msg?: string): void;
  /** 深比较（对象 / 数组） */
  deep(actual: unknown, expected: unknown, msg?: string): void;
  ok(cond: unknown, msg?: string): void;
  /** 同步抛错 */
  throws(fn: () => void, msgIncludes?: string): void;
  /** **异步**抛错（rejected promise）。挂进本用例的待办，由 `runAll` 自动 await。 */
  rejects(fn: () => Promise<unknown>, msgIncludes?: string): void;
}

export interface Suite {
  name: string;
  register: (t: T) => void;}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function show(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * **每条测试的硬超时**（毫秒）—— 默认 10 秒。
 *
 * ⚠️ 为什么默认值是 10 秒而不是 1 秒：全量里最慢的**正常**测试是那几个 28 天驱动
 *    （`simulate` 一次 70ms，但一条测试里可能连跑几个种子）⇒ 留足余量，
 *    免得把"正常的慢"误报成"死循环"。
 * ⚠️ 可用环境变量 `WULINE_TEST_TIMEOUT_MS` 覆盖（调试死循环时调小到 1000 很好用）。
 */
export const TEST_TIMEOUT_MS = Number(process.env.WULINE_TEST_TIMEOUT_MS ?? 10_000);

export async function runAll(suites: Suite[]): Promise<void> {
  let pass = 0;
  const failures: string[] = [];
  let current = '';

  /** 当前用例的待办（异步断言）—— 每个用例前清空 */
  let pending: Array<Promise<void>> = [];
  /** 注册队列：`register` 只压入，`runAll` 逐个 await 排干 */
  const queue: Array<{ name: string; fn: () => void | Promise<void> }> = [];

  const t: T = {
    test(name, fn) {
      queue.push({ name, fn });
    },
    eq(actual, expected, msg) {
      if (!Object.is(actual, expected)) {
        throw new Error(`${msg ? msg + '：' : ''}期望 ${show(expected)}，实得 ${show(actual)}`);
      }
    },
    deep(actual, expected, msg) {
      if (!deepEqual(actual, expected)) {
        throw new Error(`${msg ? msg + '：' : ''}期望 ${show(expected)}，实得 ${show(actual)}`);
      }
    },
    ok(cond, msg) {
      if (!cond) throw new Error(msg ?? '断言为假');
    },
    throws(fn, msgIncludes) {
      try {
        fn();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msgIncludes && !msg.includes(msgIncludes)) {
          throw new Error(`抛错了，但信息不含「${msgIncludes}」：${msg}`);
        }
        return;
      }
      throw new Error('期望抛错，但没有');
    },
    rejects(fn, msgIncludes) {
      pending.push(
        (async () => {
          try {
            await fn();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msgIncludes && !msg.includes(msgIncludes)) {
              throw new Error(`抛错了，但信息不含「${msgIncludes}」：${msg}`);
            }
            return;
          }
          throw new Error('期望抛错（rejected），但没有');
        })(),
      );
    },
  };

  console.log('\n══════════ 规则层 · 单测 ══════════');
  for (const s of suites) {
    current = s.name;
    console.log(`\n▸ ${s.name}`);
    s.register(t);

    while (queue.length > 0) {
      const { name, fn } = queue.shift()!;
      pending = [];
      // ⚠️ **每条测试一个硬超时**（见文件头那段）。`unref()` 让它自己在跑完时不吊住进程。
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bomb = new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error(`⏱ 超过 ${TEST_TIMEOUT_MS} ms 没结束 —— **多半是死循环**（本项目真发生过一次：一条 \`while (… ) await clickPopup(...)\` 在"点击被拒"时永远转下去）。⚠️ 这不是断言失败，是**这条测试没跑完**`)),
          TEST_TIMEOUT_MS,
        );
        if (typeof timer.unref === 'function') timer.unref();
      });
      // ⚠️ 超时之后那条测试的 promise **还在跑**（我们打不断它）⇒ 必须自己 `.catch` 掉，
      //    否则它稍后 reject 会变成 unhandled rejection，把整轮测试炸掉。
      const run = (async () => {
        await fn();
        await Promise.all(pending); // 异步断言（t.rejects）在这里被 await
      })();
      run.catch(() => {});
      try {
        await Promise.race([run, bomb]);
        pass++;
        process.stdout.write(`  ✓ ${name}\n`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failures.push(`[${current}] ${name}\n      → ${msg}`);
        process.stdout.write(`  ✗ ${name}\n      → ${msg}\n`);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  console.log('\n══════════════════════════════════');
  if (failures.length === 0) {
    console.log(`✅ 全部通过：${pass} 条断言`);
  } else {
    console.log(`❌ ${failures.length} 条失败 / 共 ${pass + failures.length} 条`);
    for (const f of failures) console.log('   ' + f);
    process.exitCode = 1;
  }
}
