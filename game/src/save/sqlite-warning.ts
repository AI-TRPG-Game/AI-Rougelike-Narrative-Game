// ⚠️ 这个模块必须**在 `node:sqlite` 之前求值**，且 `node:sqlite` 必须是**动态 import**。
// 它是一个**零依赖的副作用模块**：只装一个 warning 过滤器，不导出任何东西。
//
// ── 为什么静态 import 排多前都没用（2026-09-20 实测）────────────────
// `--trace-warnings` 给出的栈是：
//     at emitExperimentalWarning (node:internal/util:309:11)
//     at node:sqlite:8:1
//     at BuiltinModule.compileForInternalLoader ...
// 注意 `compileForInternalLoader` —— 这条警告是在**模块加载阶段**打的，
// 而 ESM 的规矩是"**先把整张依赖图加载完，再开始求值**"。
// ⇒ 过滤器（住在某个模块的**求值**阶段）永远晚于这条警告，与 import 的书写顺序无关。
// ⇒ 唯一可靠做法：用 `await import('node:sqlite')` 把它推到**求值阶段**：
//      import './sqlite-warning.ts';        // ← 求值：先装过滤器
//      const sqlite = await import('node:sqlite');   // ← 求值：此时才加载，警告被吃
//
// ⚠️ 只挡「类型 + 内容」双重匹配的**那一条**：
//    · 光看类型（`ExperimentalWarning`）会误伤别的实验特性；
//    · 也不用 `--no-warnings` 启动 —— 那会把所有 warning 一起吞掉，包括将来真正要看见的。

const orig = process.emitWarning.bind(process) as (...a: unknown[]) => void;

// ⚠️ 只挡「类型 + 内容」双重匹配的**那一条**：
//    · 光看类型（`ExperimentalWarning`）会误伤别的实验特性；
//    · 不用 `--no-warnings` 启动 —— 那会把所有 warning 一起吞掉，包括将来真正要看见的。
process.emitWarning = ((warning: unknown, ...rest: unknown[]): void => {
  const msg = typeof warning === 'string' ? warning : String((warning as Error)?.message ?? '');
  const type = typeof rest[0] === 'string'
    ? (rest[0] as string)
    : ((rest[0] as { type?: string } | undefined)?.type ?? '');
  if (type === 'ExperimentalWarning' && /SQLite/i.test(msg)) return;
  orig(warning, ...rest);
}) as typeof process.emitWarning;
