// ReplayBrain —— 用落盘的响应快照**重跑同一条链路**，一次网络都不发。
//
// 这是 Phase 2 最值钱的那件东西的另一半：`snapshot.ts` 负责把真实调用固化成证据，
// 这里负责把证据**当成真的响应**喂回同一条解析路径。
//
// ⚠️ **刻意共用 `brain-llm.ts` 的 `normalizeCheck` / `extractResolution`**：
//    回放若走另一套解析，就证明不了"实跑那条路"是对的 —— 它只会证明"另一套解析也能跑"。
//
// ⚠️ **只吃成功的证据**：`resolve.check-fail2` 这类失败留档会被跳过（它们存在的意义是
//    "出事时能看图"，不是"回放要重演失败"）。判据与实跑一致：`finish_reason === 'tool_calls'`
//    且 `arguments` 能解析成对象。
import { extractResolution, normalizeCheck, type Continuation } from './brain-llm.ts';
import { extractToolCall, readSnapshots, type SnapshotEntry } from './snapshot.ts';
import type { Adjudication, Brain, RawComposeOutput, RawResolution, SceneStep } from '../turn/brain.ts';

export interface ReplayBrain extends Brain {
  /** 回放里真正被消费掉的证据（`序号:调用点`，顺序即发生顺序） */
  readonly consumed: string[];
  /** 快照里的全部条目（诊断用） */
  readonly entries: readonly SnapshotEntry[];
  /** 还剩几条没被消费 —— **> 0 说明实跑与回放的调用次数对不上**，这是要报出来的 */
  remaining(): number;
}

export function replayBrain(dir: string): ReplayBrain {
  const entries = readSnapshots(dir);
  const consumed: string[] = [];
  let cursor = 0;

  /**
   * 按发生顺序取下一条可用证据：调用点要对得上，且必须是一次**成功**的 `tool_calls`。
   * ⚠️ 调用点**必须精确相等** —— 正是靠这一点把 `resolve.check-fail2` 这类留档过滤掉。
   */
  function take(callPoint: string): { args: Record<string, unknown>; entry: SnapshotEntry } {
    for (let i = cursor; i < entries.length; i++) {
      const e = entries[i];
      if (e.callPoint !== callPoint) continue;
      const { finishReason, argsRaw } = extractToolCall(e.response);
      if (finishReason !== 'tool_calls' || argsRaw === null) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(argsRaw);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      cursor = i + 1;
      consumed.push(`${e.seq}:${e.callPoint}`);
      return { args: parsed as Record<string, unknown>, entry: e };
    }
    throw new Error(
      `回放失败：快照里找不到可用的 \`${callPoint}\`（已消费 ${consumed.length} 条，游标 ${cursor}/${entries.length}）`,
    );
  }

  return {
    consumed,
    entries,
    remaining() {
      return entries.length - cursor;
    },

    async adjudicate(): Promise<Adjudication> {
      const { args, entry } = take('resolve.check');
      const check = normalizeCheck(args.check);
      const continuation: Continuation =
        check.verdict === '投骰'
          ? {
              stage: 'two',
              toolCallId: extractToolCall(entry.response).toolCallId ?? 'call_resolve',
              checkArgs: args,
            }
          : { stage: 'one', args };
      return {
        intent_summary: typeof args.intent_summary === 'string' ? args.intent_summary : '',
        check,
        continuation,
      };
    },

    async settle(_ev, _l, _h, adj): Promise<RawResolution> {
      const cont = adj.continuation as Continuation | null;
      if (!cont) throw new Error('回放：settle 缺少 continuation');
      // 与实跑完全同构：一段式不发网络、直接从裁定那次的 arguments 里取结算半
      if (cont.stage === 'one') return extractResolution(cont.args);
      return extractResolution(take('resolve.settle').args);
    },

    /**
     * 生成半（`compose_day`）的快照属 **Phase 3** —— 竖切（`runSlice`）只跑一条事件，不走生成半。
     * ⚠️ 仍是**抛错而不是返回空**：静默返回 `{popup_events: [], canvas_events: []}` 会造出
     *    "今天本来就没事件"的假象（与 `brain-llm.ts` 里那句"刻意抛错而不是返回空数组"同一条纪律）。
     */
    async composeDay(): Promise<RawComposeOutput> {
      throw new Error('回放：compose_day 属生成半，本次竖切没有它的快照');
    },

    /** 改写命题（`rewrite_desire` 侧链）—— **2026-10-05 整条侧链已删**（命题一生只写一次） */
    /**
     * 多轮「穿越」—— 与 `composeDay` 同一条纪律：**抛错，不返回空**。
     * 返回空场景会造出"玩家进场景什么也没发生"的假象，而回放存在的意义恰恰是
     * "证明发生了什么" ⇒ 少一条证据就必须炸出来，不能静默降级。
     */
    async sceneTurn(): Promise<SceneStep<RawResolution>> {
      throw new Error('回放：多轮「穿越」属 Phase 3，本次竖切没有它的快照');
    },

    async sceneWrap(): Promise<SceneStep<RawResolution>> {
      throw new Error('回放：多轮「穿越」属 Phase 3，本次竖切没有它的快照');
    },
  };
}
