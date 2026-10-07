// 装配层 —— 把「静态头 ＋ 任务指令」与「user ③」拼成一次调用要发的东西
//
// 《装配规范.md》§1.3 的组装顺序：
//   messages = [ { role: 'system', content: 静态头 + "\n\n" + 任务指令 },
//                { role: 'user',   content: 易变区 } ]
//   tools    = [ 该调用点的 1 个 function ]
//
// ⚠️ 本文件返回**纯字符串**，由 `llm/request.ts` 负责包成 messages。
//    这样 `prompt/` 不依赖 `llm/`，仍是纯函数。
import type { GameEvent, Ledger } from '../ledger/types.ts';
import { renderStaticHead } from '../frozen/static-head.ts';
import {
  ambienceBlock,
  endingDesireBlock,
  playerDesireBlock,
  renderArchiveUser,
  renderComposeUser,
  renderCreateUser,
  renderEndingUser,
  renderNarrateUser,
  renderResolveUser,
  renderWrapUser,
  type HandlingRecord,
  type RenderOptions,
} from './blocks.ts';
import { ENDING_FLAVOR_NOTES, INSTRUCTIONS, narrateInstruction, type InstructionName } from './instructions.ts';
import type { SceneEndReason } from '../rules/scene.ts';
import { cardLabel, type DivinationCards } from '../rules/tarot.ts';
import type { ArchivePlan } from '../rules/archive.ts';

export interface AssembledPrompt {
  /** system：① 公共静态头 ＋ ② 任务指令，两者**逐字稳定** */
  system: string;
  /** user：③ 每日易变区 */
  user: string;
  /** 本次用了哪份指令 —— 打在日志里，排错时一眼能看见 */
  instruction: InstructionName;
}

export function assembleResolve(
  l: Ledger,
  ev: GameEvent,
  h: HandlingRecord | null,
  instruction: InstructionName,
  o: RenderOptions = {},
): AssembledPrompt {
  return {
    system: renderStaticHead(l) + '\n\n' + INSTRUCTIONS[instruction],
    user: renderResolveUser(l, ev, h, o),
    instruction,
  };
}

/**
 * **忽略形态**（事件没人处理、等到过期）。
 * ⚠️ 它与正常结算**共用同一段 `system` 字节**（静态头 ＋ **逐字不变**的结算指令）⇒ 前缀缓存共享。
 *    唯一不同的是 user 里【玩家的处理】那一块，以及【处理者能力】整段不存在。
 */
export function assembleIgnore(l: Ledger, ev: GameEvent): AssembledPrompt {
  return assembleResolve(l, ev, null, '结算', { ignored: true });
}

/**
 * **生成半**（T0 换日）。
 * ⚠️ 与 `resolve` **共享同一份静态头**（段 ① ＋ 段 ② 实体骨架）⇒ 两个主链的缓存前缀互不影响。
 * ⚠️ 玩家自建走的是**同名 function ＋ 另一份指令**（`INSTRUCTION_CREATE`）、user ③ 也不同
 *    ⇒ 那是下面的 `assembleCreate()`，**不是这里**。
 */
export function assembleCompose(l: Ledger): AssembledPrompt {
  return {
    system: renderStaticHead(l) + '\n\n' + INSTRUCTIONS['生成'],
    user: renderComposeUser(l),
    instruction: '生成',
  };
}

/**
 * **玩家自建**（「我想做点什么」）—— 与生成半**同一个 function**（`compose_day`）、**另一份指令**。
 * ⚠️ 两半**共享同一份静态头**（段 ① ＋ 段 ② 骨架）；system ② 从指令处就分岔 ⇒ 前缀在这一段隔离。
 */
export function assembleCreate(l: Ledger, approach: string): AssembledPrompt {
  return {
    system: renderStaticHead(l) + '\n\n' + INSTRUCTIONS['创建事件'],
    user: renderCreateUser(l, approach),
    instruction: '创建事件',
  };
}

/**
 * **多轮「穿越」每一轮** —— `resolve` 的**同一份静态头** ＋《契约.md》§三「叙事」指令。
 *
 * ⚠️ 与单轮结算是**同一个 function**（`resolve`）、**不同的指令**（`叙事`）⇒ 前缀在 system ② 处分岔。
 *    这与 §1.2「每个调用点只挂它需要的那一个 function」不矛盾：那一维管的是 `tools`，
 *    这一维管的是 `system` —— **多轮那 7~14 次调用彼此之间共享段①＋段②骨架**，省的是这部分。
 * ⚠️ **2026-10-07 用户裁定：末轮（round ≥ 上限）职责句分岔**（"暗示告一段落"）⇒
 *    末轮那一次的前缀与中途轮**不同**，缓存上多一岔 —— 与「收尾」同理，刻意。
 */
export function assembleNarrate(
  l: Ledger,
  ev: GameEvent,
  h: HandlingRecord,
  round: number,
  presentIds: readonly string[],
  o: RenderOptions = {},
): AssembledPrompt {
  return {
    system: renderStaticHead(l) + '\n\n' + narrateInstruction(round),
    user: renderNarrateUser(l, ev, h, round, presentIds, o),
    instruction: '叙事',
  };
}

/**
 * **多轮收尾** —— 同一份静态头 ＋《契约.md》§三「收尾」指令。
 *
 * ⚠️ 与「叙事」同为多轮、**指令不同** ⇒ 这两次的 system 前缀在指令处就分岔，各自独立缓存。
 *    **刻意的**：中途轮之间共享同一段前缀（那是绝大多数调用），收尾只多花一次的前缀钱。
 * ⚠️ 收尾**可以省掉**：若最后一轮的叙事调用已让 `scene_over=true` 并填好了收尾字段，
 *    就**不再发**这一次——
 *    省不省由 `turn/scene.ts` 的状态机决定，不在这里。
 */
export function assembleWrap(
  l: Ledger,
  ev: GameEvent,
  reason: SceneEndReason,
  o: RenderOptions = {},
): AssembledPrompt {
  return {
    system: renderStaticHead(l) + '\n\n' + INSTRUCTIONS['收尾'],
    user: renderWrapUser(l, ev, reason, o),
    instruction: '收尾',
  };
}

/**
 * **`chapter_shift` 侧链**（章节占卜 · 第 1 / 8 / 15 / 22 天日初）。
 *
 * 三段式 system：**[静态头] ＋ [占卜指令] ＋ [玩家欲望]** ——
 * 把会变的那一小段（【玩家欲望】）压在**最末**。
 * ⚠️ 2026-10-05：这一段曾经写「`rewrite_desire` 一触发就换」—— 那条侧链已删，
 *    命题在 `opening` 之后**终身不变** ⇒ 这一段现在是**四条带命题的侧链里唯一恒定的一段**。
 *
 * ⚠️ 两张牌填进**段 ②** 的两个占位符（`{第一张}` / `{第二张}`）—— 与 `opening` 同一条读法：
 *    牌阵写在指令正文里。⇒ 段 ② 每章不同，这是刻意的（见 `INSTRUCTION_DIVINATION`）。
 * ⚠️ user ③ = **本周氛围那一块** ＋ 末行。用户 2026-09-22 裁定「**氛围只有本周氛围**」⇒
 *    不另立「既有氛围」块：占卜时这一块显示的是**上一章**的氛围（第 1 天是哨兵，还没有过）。
 * ⚠️ 段 ② 的牌面替换用**函数式** `.replace(k, () => v)`：字符串形式会把牌名里的
 *    `$&` / `$1` 当**模式**解释（`opening` 那边同一个坑，同一种写法）。
 */
export function assembleDivination(l: Ledger, cards: DivinationCards): AssembledPrompt {
  const instruction: InstructionName = '占卜';
  return {
    system:
      renderStaticHead(l) +
      '\n\n' +
      INSTRUCTIONS[instruction]
        .replace('{第一张}', () => cardLabel(cards[0]))
        .replace('{第二张}', () => cardLabel(cards[1])) +
      '\n\n' +
      playerDesireBlock(l),
    user: [ambienceBlock(l), '按【占卜】指令输出这一章的占卜。'].join('\n\n'),
    instruction,
  };
}

/**
 * **`archive` 侧链**（概要归并 · T0 的「概要归并」位 · 全局约 2~3 次）。
 *
 * ⚠️ **四条侧链里唯一不带欲望命题的一条**：system 只有 **[静态头] ＋ [归并指令]** 两段
 *    。它只读写公共概要 ⇒
 *    天然把自己摘在欲望的上下文之外 —— **不要**照另外四条那样补一段命题块。
 * ⚠️ user ③ = 【要归并的几天】＋【已有的归档段】＋ 末行 —— 顺序照 §6.10 的指令正文。
 * ⚠️ **计划由调用侧算好带进来**（`rules/archive.ts·planArchive`）：这里只负责渲染 ——
 *    装配与落地读的必须是**同一份 `plan`**，否则"模型看到的几天"与"真正被搬走的几天"会分裂。
 */
export function assembleArchive(l: Ledger, plan: ArchivePlan): AssembledPrompt {
  const instruction: InstructionName = '归并';
  return {
    system: renderStaticHead(l) + '\n\n' + INSTRUCTIONS[instruction],
    user: renderArchiveUser(l, plan),
    instruction,
  };
}

/**
 * **`ending` 侧链**（终局叙事 · 第 28 天判出**成功结局**之后 · 全局至多 1 次）。
 *
 * system 共**四段**：**[静态头] ＋ [结局指令] ＋ [这一局的风味] ＋ [玩家的欲望命题]**
 * —— 把会变的那一小段（命题）压在**最末**（§4.4 的三段式 ＋ §5.8「system ② 加风味」）。
 *
 * ⚠️ **风味与指令是两个东西**（用户 2026-09-18 裁定）：风味是**独立的一段**
 *    （`instructions.ts·ENDING_FLAVOR_NOTES`），按 `ledger.ending.flavor` **只挂中选的那一段** ——
 *    不是填进指令正文的占位符，四段也**不并列**（该挂哪一段是系统判定的输入，不需要模型自己选）。
 *    指令正文里那句「结尾收在下面这个风味上」照旧成立：风味段就接在它后面。
 * ⚠️ user ③ **只有三块**（概要全量 / 放格子 / 画像）：【玩家的欲望命题】按四条带欲望命题侧链的
 *    统一拼法搬去了 system 末段 —— 同一句命题**不许**在两处各出现一次。
 * ⚠️ 它**只认 `l.ending`**：调用侧（`turn/ending.ts·writeEnding`）已经判过"是成功结局、
 *    话术还没写过"⇒ 这里只做渲染，**不自己再判一遍**（两份判据 = 两处都能漏）。
 *    判不出来就当场抛 —— 那是**调用侧的接线错误**，不是数据问题。
 * ⚠️ **失败结局根本走不到这里**（`writeEnding` 在调用前就返回了）—— 七条失败局 0 调用。
 */
export function assembleEnding(l: Ledger): AssembledPrompt {
  const instruction: InstructionName = '结局';
  const e = l.ending;
  if (!e || e.kind !== '成功' || e.flavor === null) {
    throw new Error(
      `assembleEnding 只用于成功结局（现在是 ${e === null ? '还没有终局判定' : `${e.kind}·${e.name}`}）`,
    );
  }
  return {
    system:
      renderStaticHead(l) +
      '\n\n' +
      INSTRUCTIONS[instruction] +
      '\n\n' +
      // ⚠️ 风味段：**互斥**地挂中选的那一段（不是四支并列、也不是占位符替换）
      ENDING_FLAVOR_NOTES[e.flavor] +
      '\n\n' +
      endingDesireBlock(l),
    user: renderEndingUser(l),
    instruction,
  };
}

/** 只回答"这次调用该看到哪些组" —— `ledger/project.ts` 的标签表是唯一事实源 */
export function describeBlocks(o: RenderOptions = {}): string[] {
  const all = [
    'desire',
    'ambience',
    'summary',
    'buckets',
    'entityState',
    'currentState',
    'eventCard',
    'handling',
    'ability',
  ];
  return o.ignored ? all.filter((b) => b !== 'ability') : all;
}
