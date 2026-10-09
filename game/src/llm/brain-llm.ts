// `Brain` 的**真实实现**
//
//   ① `verdict=投骰`  ⇒ **两段式**（2 次调用）：
//        user(裁定段) → assistant(tool_call: 裁定半) → tool({"档位","加成"}) → assistant(结算半)
//   ② 无需判定 / 直接成功 / 直接失败 ⇒ **一段式**（1 次调用）：
//        同一次调用里两半一起填完 ⇒ `settle` **不再发网络**，只是把已经拿到的结算半取出来
//
// ── 三条纪律（每一条都在代码结构里有落点，不是注释）──────────────────
//   · **修正先于叙事**：`adjudicate` 的 prompt 里**没有**档位、没有叙事位（指令 `裁定` 明写
//     "只裁定，不写剧情、不给结果"）；档位是**规则层**投出来的。
//   · **只回传 `{档位, 加成}`**：`d20` / `A` / `R` 永不进 `tool` 消息 —— 回传只会诱导模型
//     复述数字或二次揣测成败。`SettleInput` 就是"允许回传什么"的**唯一**地方。
//   · **失败即抛，不兜底**：§3.2 的口径是"重试仍失败 ⇒ 返回失败结果，由上层决定跳过这一条"。
//     ⇒ 这里抛 `LlmCallFailed`；`handleEvent` 在**落账之前**就抛，账本一个字节没动。
import {
  ATTR_KEYS,
  DESIRE_TIERS,
  DIFFICULTIES,
  TIERS,
  VERDICTS,
  type AttrKey,
  type Check,
  type DesireTier,
  type Difficulty,
  type DirectResult,
  type Tier,
  type Verdict,
} from '../contract/types.ts';
import { player, type GameEvent, type Ledger } from '../ledger/types.ts';
import {
  assembleArchive,
  assembleCompose,
  assembleCreate,
  assembleDivination,
  assembleEnding,
  assembleIgnore,
  assembleNarrate,
  assembleResolve,
  assembleWrap,
  type AssembledPrompt,
} from '../prompt/assemble.ts';
import type { HandlingRecord } from '../prompt/blocks.ts';
import { composeTool } from '../schema/compose.ts';
import { resolveTool, sceneTool } from '../schema/resolve.ts';
import { chapterShiftTool } from '../schema/chapter-shift.ts';
import { archiveTool } from '../schema/archive.ts';
import { endingTool } from '../schema/ending.ts';
import type { SceneEndReason } from '../rules/scene.ts';
import type { DivinationCards } from '../rules/tarot.ts';
import type { ArchivePlan } from '../rules/archive.ts';
import type {
  Adjudication,
  Brain,
  RawArchiveOutput,
  RawChapterShiftOutput,
  RawComposeOutput,
  RawEndingOutput,
  RawResolution,
  SceneStep,
  SceneView,
  SceneWrapView,
  SettleInput,
} from '../turn/brain.ts';
import { callTool, callToolStream, summarizeResult, type LlmResult } from './client.ts';
import type { LlmConfig } from './config.ts';
import {
  assistantToolCall,
  buildChatBody,
  systemMessage,
  toolMessage,
  userMessage,
  type CallPoint,
  type ChatMessage,
} from './request.ts';
import { extractToolCall, type SnapshotWriter } from './snapshot.ts';

/** 调用失败 —— 带得上"哪一步、什么样的响应"，便于上层决定跳过还是中止 */
export class LlmCallFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmCallFailed';
  }
}

/**
 * 一次调用落在哪个**阶段** —— 只用于日志/观测，不参与任何逻辑。
 * `生成` = `compose_day`（T0 换日那一次）。它不属于 `resolve` 的裁定/结算，
 * 别硬塞进那两个名字里（否则日志会撒谎）。
 * ⚠️ 多轮「穿越」同理**不能并进** `裁定` / `结算`：那两次在场景里会各出现十来遍
 *    （上限 10 轮 ⇒ 叙事 10 次＋收尾 0~1 次），和"一条事件一次结算"在成本上完全不是
 *    一回事 —— 日志认不出来就等于没有观测。
 * ⚠️ 侧链（`开局` / `占卜` / `归并` / `结局`…）各自单列，理由同上：它们是低频调用，
 *    混进主链名下会让"全局只发一次的那次调用"在证据里消失。
 */
// ⚠️ **枚举必须与实际的 `send(req, …)` 调用点一一对应**：少一个成员不会有任何症状
//    ——Node 22 的 type stripping **不做类型检查**（`CallStage` 只进日志，不参与逻辑），
//    所以"漏了 `开局` / `占卜` / `归并`"这种事不会有编译器替我们喊。改动时手抄一遍。
export type CallStage =
  | '裁定'
  | '结算'
  | '生成'
  // ⚠️ 玩家自建与「生成」**共用同一个 function**（`compose_day`），但**必须分开登记** ——
  //    这正是上面那条纪律（"少一个成员不会有任何症状，改动时手抄一遍"）。
  //    `stage` 只进日志，所以漏了它不会报错、只会让"玩家敲的那一次"混进换日那一次里。
  | '创建事件'
  | '叙事'
  | '收尾'
  | '开局'
  | '占卜'
  | '归并'
  | '结局';

/** 一次调用的观测值（打印用：缓存命中、耗时、finish_reason） */
export interface CallTrace {
  callPoint: CallPoint;
  stage: CallStage;
  /** 第几次尝试（1 = 首次，2 = 重试） */
  attempt: number;
  result: LlmResult;
}

export interface LlmBrainDeps {
  cfg: LlmConfig;
  /** 请求 / 响应快照 —— 有它才谈得上"同一条链路可复现" */
  snapshot?: SnapshotWriter;
  onCall?: (t: CallTrace) => void;
  timeoutMs?: number;
}

// ── 续接凭据 ──────────────────────────────────────────────────

/** 两段式：留住 `tool_call_id` 与裁定半的原始 arguments，第二次调用才接得上 */
export interface TwoStageContinuation {
  stage: 'two';
  toolCallId: string;
  checkArgs: Record<string, unknown>;
}

/** 一段式：结算半已经在第一次调用里拿全了 ⇒ 直接捧出来，不再发网络 */
export interface OneStageContinuation {
  stage: 'one';
  args: Record<string, unknown>;
}

export type Continuation = TwoStageContinuation | OneStageContinuation;

// ── 请求组装（`--dry` 也用它 ⇒ 干跑与实跑走的是同一份代码）──────

export interface ResolveRequest {
  callPoint: CallPoint;
  prompt: AssembledPrompt;
  body: Record<string, unknown>;
}

function messagesOf(prompt: AssembledPrompt, extra: ChatMessage[] = []): ChatMessage[] {
  return [systemMessage(prompt.system), userMessage(prompt.user), ...extra];
}

function bodyOf(
  cfg: LlmConfig,
  callPoint: CallPoint,
  messages: ChatMessage[],
  toolChoiceName = 'resolve',
  /** 本次调用点要挂的那一个 function（默认 `resolve`；`compose_day` 传它自己） */
  tool: JsonSchema = resolveTool(),
): Record<string, unknown> {
  return buildChatBody({
    provider: cfg.provider,
    reasoningEffort: cfg.reasoningEffort,
    model: cfg.model,
    messages,
    // ⚠️ **只挂当前调用点需要的那一个 function**：未选中的 function 不进 prompt ⇒ 零成本
    tools: [tool],
    toolChoiceName,
    callPoint,
  });
}

/** 裁定半的请求（第一段） */
export function buildCheckRequest(cfg: LlmConfig, l: Ledger, ev: GameEvent, h: HandlingRecord): ResolveRequest {
  const prompt = assembleResolve(l, ev, h, '裁定');
  return { callPoint: 'resolve.check', prompt, body: bodyOf(cfg, 'resolve.check', messagesOf(prompt)) };
}

/**
 * 结算半的请求（第二段）。
 *
 * ⚠️ **消息序列**（既定约定）：`user → assistant(tool_calls) → tool(同 id) → assistant`。
 *    `user` 段用的是《装配规范.md》§4.3 的**结算半模板**（第一段的全部块原样保留
 *    ＋【判定结果】＋【已落账】）；**掷骰回填走 `role:"tool"` 消息**，不写进 user 文本。
 */
export function buildSettleRequest(
  cfg: LlmConfig,
  l: Ledger,
  ev: GameEvent,
  h: HandlingRecord,
  input: SettleInput,
  cont: TwoStageContinuation,
): ResolveRequest {
  const prompt = assembleResolve(l, ev, h, '结算', {
    tier: input.tier,
    bonuses: [...input.bonuses],
    landed: [...input.landed],
  });
  const extra: ChatMessage[] = [
    assistantToolCall(cont.toolCallId, 'resolve', cont.checkArgs),
    // ⚠️ **只回传 `{档位, 加成}`** —— 多一个数字都是在诱导模型复述或二次揣测
    toolMessage(cont.toolCallId, { 档位: input.tier, 加成: [...input.bonuses] }),
  ];
  return { callPoint: 'resolve.settle', prompt, body: bodyOf(cfg, 'resolve.settle', messagesOf(prompt, extra)) };
}

/**
 * **忽略结算**的请求（事件没人处理、等到过期时的那一次）。
 *
 * ⚠️ 与 `buildSettleRequest` 的区别**只有两点**：
 *    ① user 用忽略形态的【玩家的处理】、且【处理者能力】整段不存在；
 *    ② 消息序列只有 `system → user`（没有前一轮的 `assistant(tool_calls)` / `tool` 回填 —— 它不是两段式）。
 *    ⇒ `system` 字节**逐字相同**（静态头 ＋ 结算指令）⇒ 两个调用点**共享同一段前缀缓存**。
 */
export function buildIgnoreRequest(cfg: LlmConfig, l: Ledger, ev: GameEvent): ResolveRequest {
  const prompt = assembleIgnore(l, ev);
  return { callPoint: 'resolve.ignore', prompt, body: bodyOf(cfg, 'resolve.ignore', messagesOf(prompt)) };
}

/**
 * **生成半**的请求（T0 换日）—— 全场**输出量最大**的调用（`max_tokens` 8192），
 * 所以它更要能"先看请求、再花钱"：`--dry` 走的就是这个函数（干跑与实跑共一份代码）。
 *
 * ⚠️ 它**不是两段式**（没有裁定、没有掷骰可言）⇒ 消息序列只有 `system → user`。
 * ⚠️ `tools` 挂的是 **`compose_day` 那个 function**（不是 `resolve`）—— `tool_choice` 指的
 *    名字必须真的在 `tools` 里，否则服务端直接 400。
 * ⚠️ `system` 用的是**同一份静态头**（＋「生成」指令）⇒ 与 `resolve` 主链共享段 ① 的缓存前缀。
 */
/**
 * `required_person` 的动态 enum 候选（2026-10-09 用户裁定）：
 * **玩家本人 ＋ 当前已入队的人物** —— 生成那一刻谁调得动，谁才有资格「非他不可」。
 * 未入队的人不在候选里 ⇒ 模型想填也填不进 enum ⇒「required 指向调不动的人」的死局被结构性杜绝。
 */
function requiredCandidatesOf(l: Ledger): string[] {
  const me = player(l);
  return [me.id, ...l.entities.people.filter((p) => p.affiliated && p.id !== me.id).map((p) => p.id)];
}

export function buildComposeRequest(cfg: LlmConfig, l: Ledger): ResolveRequest {
  const prompt = assembleCompose(l);
  return {
    callPoint: 'compose_day',
    prompt,
    body: bodyOf(cfg, 'compose_day', messagesOf(prompt), 'compose_day', composeTool(requiredCandidatesOf(l))),
  };
}

/**
 * **玩家自建**的请求（「我想做点什么」· 时间线 T2-d）。
 *
 * ⚠️ 与生成半是**同一个 function**（`compose_day`）⇒ `tools` 挂的仍是 `composeTool()`、
 *    `tool_choice` 也仍指 `compose_day`（指错了服务端直接 400）。变的只有**指令**与
 *    **user ③**（`assembleCreate` / `renderCreateUser`：把【本日调度】换成【玩家的处理方式】）
 *    ⇒ system 前缀在**指令段**分岔 —— 与 `resolve` / `compose_day` 之间的隔离方式同族
 *    （§1.2「每个调用点只挂它需要的那一个 function」管的是 `tools`，不是 `system`）。
 * ⚠️ `callPoint` 用 **`'create_event'`** 而不是 `'compose_day'`：调用点同时被**快照文件名**
 *    与 **`max_tokens`** 用 —— 混用会让"一天换日那一次"与"玩家敲一句话那一次"
 *    在证据里认不出来（`MAX_TOKENS` 里那条注释写着同一条理由）。
 * ⚠️ `stage` 用 **`'创建事件'`** —— 与 `callPoint` 分开是刻意的：前者进**人看的日志**、
 *    后者进**机器读的文件名**，两边各有各的读者（同 `scene.*` 那一族的做法）。
 */
export function buildCreateRequest(cfg: LlmConfig, l: Ledger, approach: string): ResolveRequest {
  const prompt = assembleCreate(l, approach);
  return {
    callPoint: 'create_event',
    prompt,
    body: bodyOf(cfg, 'create_event', messagesOf(prompt), 'compose_day', composeTool(requiredCandidatesOf(l))),
  };
}


/**
 * **`chapter_shift` 侧链**的请求（章节占卜 · 第 1 / 8 / 15 / 22 天，《契约.md》§6.6）。
 *
 * ⚠️ `tools` 只挂它**自己的 function**（平时不挂、这一刻才挂，《装配规范.md》§1.2）——
 *    `tool_choice` 指的名字必须真的在 `tools` 里。
 * ⚠️ system 是**三段式**（静态头 ＋ 占卜指令 ＋ 【玩家欲望】），由 `assembleDivination` 拼；
 *    两张牌由调用侧抽好、填进段 ② 的两个占位符 —— 本函数**不抽牌**。
 */
export function buildChapterShiftRequest(
  cfg: LlmConfig,
  l: Ledger,
  cards: DivinationCards,
): ResolveRequest {
  const prompt = assembleDivination(l, cards);
  return {
    callPoint: 'chapter_shift',
    prompt,
    body: bodyOf(cfg, 'chapter_shift', messagesOf(prompt), 'chapter_shift', chapterShiftTool()),
  };
}

/**
 * 概要归并的请求组装（`archive` 侧链 · 全局约 2~3 次）。
 *
 * ⚠️ 与其它侧链的差别只有一处、但很要紧：它的 `system` **没有第三段**（不带欲望命题）⇒
 *    这里能证明"例外"是真的例外 —— 别顺手补一段命题块上去。
 * ⚠️ `plan` 由调用侧算好传进来（`rules/archive.ts·planArchive`）—— 这里**不重算**。
 */
export function buildArchiveRequest(cfg: LlmConfig, l: Ledger, plan: ArchivePlan): ResolveRequest {
  const prompt = assembleArchive(l, plan);
  return {
    callPoint: 'archive',
    prompt,
    body: bodyOf(cfg, 'archive', messagesOf(prompt), 'archive', archiveTool()),
  };
}

/**
 * **`ending` 侧链**的请求（终局叙事 · 全局至多 1 次，《契约.md》§6.9）。
 *
 * ⚠️ `tools` 只挂它**自己的 function**（平时不挂、这一刻才挂，《装配规范.md》§1.2）——
 *    `tool_choice` 指的名字必须真的在 `tools` 里。
 * ⚠️ system 是**四段**（静态头 ＋ 结局指令 ＋ **这一局的风味** ＋ 【玩家的欲望命题】），
 *    由 `assembleEnding` 拼。**风味与指令是两个东西**（用户 2026-09-18 裁定）：四段风味
 *    提示词各自独立（`instructions.ts·ENDING_FLAVOR_NOTES`），装配时**只挂中选的那一段**，
 *    **不是**填进指令正文的占位符 —— 指令里那句「结尾收在下面这个风味上」照旧成立。
 * ⚠️ 它是**唯一一个"不用调用侧额外交东西"的侧链** —— 概要 / 放格子 / 命题 / 画像全在账本里。
 * ⚠️ **失败结局根本走不到这里**（`writeEnding` 在调用前就返回了）—— 七条失败局 0 调用。
 */
export function buildEndingRequest(cfg: LlmConfig, l: Ledger): ResolveRequest {
  const prompt = assembleEnding(l);
  return {
    callPoint: 'ending',
    prompt,
    body: bodyOf(cfg, 'ending', messagesOf(prompt), 'ending', endingTool()),
  };
}


// ── 多轮「穿越」的请求组装────────────────────

/**
 * 场景的**累积对话凭据** —— `Ledger.scene.conv` 里装的就是它。
 *
 * ⚠️ **不含 `system`**：静态头每次按账本重算（它逐字稳定），装进历史只会白花 token。
 * ⚠️ **跨轮保留整串历史**（含前几轮的 `user` 与 `assistant`）
 *    「同一场景内的多轮**保留 assistant 历史**，否则 NPC 前后不搭」；
 *    跨天 / 跨事件才全清 —— 那由"场景置回 `null`、`conv` 随之弃掉"完成。
 * ⚠️ 消息**严格配对**：`assistant(tool_calls) → tool(同 id) → assistant`。中途插入任意
 *    tool 消息服务端直接拒 ⇒ 每一轮的 `tool` 回填都紧跟着它自己的 `assistant`，
 *    且**只在那一轮内**出现（一段式的轮次压根没有 tool 消息）。
 */
export interface SceneConv {
  messages: ChatMessage[];
}

/** 容错读法：`conv` 从账本来（可能是 `null`，也可能被存档 / 人手改坏） */
function convOf(conv: unknown): SceneConv {
  const o = (conv && typeof conv === 'object' ? conv : {}) as { messages?: unknown };
  return { messages: Array.isArray(o.messages) ? (o.messages as ChatMessage[]) : [] };
}

/** 场景调用的消息序列：`system →（累积历史）→ user(本轮)` */
function sceneMessages(prompt: AssembledPrompt, history: readonly ChatMessage[]): ChatMessage[] {
  return [systemMessage(prompt.system), ...history, userMessage(prompt.user)];
}

/**
 * 场景**一轮**的请求 —— 2026-10-07 起**每轮只有这一次调用**（场景不掷骰，两段式整条退休）。
 * ⚠️ `tools` 挂的是**场景自己的 function**（`scene`：无 `intent_summary` / `check`），
 *    `tool_choice` 指的名字必须真的在 `tools` 里，否则服务端直接 400。
 * ⚠️ 历史里的每一条 `assistant(tool_calls)` 都**紧跟一条同 id 的 `tool` 回执**
 *    （见 `sceneTurn` 的 conv 维护）—— DeepSeek 对此是**硬校验**：
 *    `assistant(tool_calls)` 后面直接跟 `user` 会 400
 *    （"…must be followed by tool messages…"，2026-10-07 实测）。
 */
export function buildSceneTurnRequest(
  cfg: LlmConfig,
  l: Ledger,
  ev: GameEvent,
  h: HandlingRecord,
  view: SceneView,
  conv: SceneConv,
): ResolveRequest {
  const prompt = assembleNarrate(l, ev, h, view.round, view.presentIds, { landed: [...view.ledgered] });
  return {
    callPoint: 'scene.turn',
    prompt,
    body: bodyOf(cfg, 'scene.turn', sceneMessages(prompt, conv.messages), 'scene', sceneTool()),
  };
}

/**
 * 场景**收尾** —— 与「叙事」同为多轮、**指令不同** ⇒ 这两次的 system 前缀在指令处
 * 就分岔、各自独立缓存。**刻意的**：中途轮共享同一段前缀（那是绝大多数调用），
 * 收尾只多花它自己那一次的前缀钱。
 */
export function buildSceneWrapRequest(
  cfg: LlmConfig,
  l: Ledger,
  ev: GameEvent,
  reason: SceneEndReason,
  view: SceneWrapView,
  conv: SceneConv,
): ResolveRequest {
  const prompt = assembleWrap(l, ev, reason, { turns: [...view.turns], landed: [...view.ledgered] });
  return {
    callPoint: 'scene.wrap',
    prompt,
    body: bodyOf(cfg, 'scene.wrap', sceneMessages(prompt, conv.messages), 'scene', sceneTool()),
  };
}

// ── 输出归一化（服务端不校验 ⇒ 规则层是唯一防线）────────────────

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function oneOf<T extends string>(v: unknown, pool: readonly T[], fallback: T): T {
  return typeof v === 'string' && (pool as readonly string[]).includes(v) ? (v as T) : fallback;
}

/**
 * 把模型给的 `check` 归一化成一个**结构完整**的 `Check`。
 * ⚠️ 非法 `verdict` 兜到 `投骰`（= 最保守的默认路径：档位仍由**规则层**投出来，
 *    不会因为一个畸形枚举就凭空给玩家一个成败）。
 */
export function normalizeCheck(raw: unknown): Check {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const verdict: Verdict = oneOf<Verdict>(o.verdict, VERDICTS, '投骰');
  const participants = (Array.isArray(o.participants) ? o.participants : [])
    .filter((x): x is AttrKey => typeof x === 'string' && (ATTR_KEYS as readonly string[]).includes(x))
    .slice(0, 3); // `calcA` 断言上限 3
  const direct = oneOf<string>(o.direct_result, [...TIERS, '无'], '无');
  return {
    verdict,
    participants,
    difficulty:
      verdict === '投骰' ? oneOf<Difficulty>(o.difficulty, DIFFICULTIES, '无修正') : '无修正',
    direct_result: direct as DirectResult,
  };
}

/** 结算半 → `RawResolution`（**原始**形状：`delta` / `vouchers` 一律交给 `validateDelta` 再碰） */
export function extractResolution(args: Record<string, unknown>): RawResolution {
  const 欲向 = oneOf<DesireTier>(args.欲向, DESIRE_TIERS, '无关');
  return {
    narration: asString(args.narration),
    delta: args.delta ?? { ops: [] },
    summary: asString(args.summary),
    next_seeds: asStringArray(args.next_seeds),
    vouchers: args.vouchers,
    欲向,
    // ⚠️ **只认字面 `true`**（与 `verdict` 的"非法就兜到最保守那条"同一套思路）：
    //    多轮的 `scene_over` 一旦被当成真，`turn/scene.ts` 就会**跳过收尾调用** ——
    //    而那一跳是"整场没有 summary"的直接原因。畸形的字符串 "true" / 数字 1 一律不算。
    scene_over: args.scene_over === true,
  };
}

// ── Brain 本体 ────────────────────────────────────────────────

export function llmBrain(deps: LlmBrainDeps): Brain {
  const { cfg, snapshot, onCall, timeoutMs } = deps;

  /** 每次往返都留证据（**重试的两次各留一份**），并把观测值报给 `onCall` */
  function exchange(callPoint: CallPoint, stage: CallStage) {
    return (attempt: number, body: Record<string, unknown>, result: LlmResult): void => {
      const label = result.ok ? callPoint : `${callPoint}-fail${attempt}`;
      snapshot?.record(label, body, result.raw, `第 ${attempt} 次 · ${result.ok ? 'ok' : '失败'}`);
      onCall?.({ callPoint, stage, attempt, result });
    };
  }

  async function send(
    req: ResolveRequest,
    stage: CallStage,
    /** 传了 ⇒ 走流式（`narration` 增量边到边回调出去）；不传 ⇒ 与以前逐字一致 */
    onNarrDelta?: (chunk: string, reset: boolean) => void,
  ): Promise<{ args: Record<string, unknown>; raw: unknown }> {
    const r = onNarrDelta
      ? await callToolStream(cfg, req.body, {
          onExchange: exchange(req.callPoint, stage),
          timeoutMs,
          onNarrDelta,
        })
      : await callTool(cfg, req.body, {
          onExchange: exchange(req.callPoint, stage),
          timeoutMs,
        });
    if (!r.ok || r.args === null) {
      throw new LlmCallFailed(`${stage}半调用失败（${req.callPoint}）：${summarizeResult(r)}`);
    }
    return { args: r.args, raw: r.raw };
  }

  return {
    async adjudicate(ev, l, h): Promise<Adjudication> {
      const { args, raw } = await send(buildCheckRequest(cfg, l, ev, h), '裁定');
      const check = normalizeCheck(args.check);

      // ⚠️ 分叉点就在这一行：`投骰` 要等规则层的结果，其余四种这次就填完了。
      const continuation: Continuation =
        check.verdict === '投骰'
          ? {
              stage: 'two',
              // 两段式必须靠这个 id 把 `tool` 消息接回 `assistant(tool_calls)`（§2.4）
              toolCallId: extractToolCall(raw).toolCallId ?? 'call_resolve',
              checkArgs: args,
            }
          : { stage: 'one', args };

      return { intent_summary: asString(args.intent_summary), check, continuation };
    },

    async settle(ev, l, h, adj, input): Promise<RawResolution> {
      const cont = adj.continuation as Continuation | null;
      if (!cont) {
        throw new Error('settle 缺少 continuation —— adjudicate 与 settle 必须成对，且 adj 要原样传递');
      }
      // 一段式：结算半在第一次调用里已经有了 ⇒ **不发网络**（省一次往返，也不多花一分钱）
      if (cont.stage === 'one') return extractResolution(cont.args);

      const { args } = await send(buildSettleRequest(cfg, l, ev, h, input, cont), '结算');
      return extractResolution(args);
    },

    /**
     * **忽略结算** —— 一次调用、没有持续凭据（`continuation` 那套完全用不上）。
     * ⚠️ 与 `settle` 复用同一个 `stage` 标签（'结算'）：对观测者来说它们都是"写结果的那一次"。
     */
    async ignore(ev, l): Promise<RawResolution> {
      const { args } = await send(buildIgnoreRequest(cfg, l, ev), '结算');
      return extractResolution(args);
    },

    /**
     * **生成半** —— T0 换日那一次。
     *
     * ⚠️ **原样交回**（只兜"两个通道必须是数组"这一层）—— 逐字段校验是**落地层**
     *    （`turn/land-compose.ts`）的事。在这里顺手清洗，等于把"规则层是唯一防线"拆成两处，
     *    而两处防线 = 两处都能漏（Phase 0 已经吃过一次"以为服务端会拦"的亏）。
     * ⚠️ **失败即抛**（与本文件顶栏第 3 条同一纪律）：由 `turn/t0.ts·enterDay` 决定
     *    "今天没有自由事件"并**留一条刺眼的日志** —— 静默返回空会造出"本来就没事件"的假象。
     * ⚠️ 玩家自建（「创建事件」）将来也走这里：同一个 function、另一份指令、另一份 user ③
     *    （`assembleCreate`），输出形状逐字相同。
     */
    async composeDay(l): Promise<RawComposeOutput> {
      const { args } = await send(buildComposeRequest(cfg, l), '生成');
      const popups = args.popup_events;
      const canvases = args.canvas_events;
      if (!Array.isArray(popups) || !Array.isArray(canvases)) {
        throw new LlmCallFailed(
          `生成半输出形状错：popup_events 是 ${Array.isArray(popups) ? '数组' : typeof popups}、` +
            `canvas_events 是 ${Array.isArray(canvases) ? '数组' : typeof canvases}（两个都必须是数组）`,
        );
      }
      return { popup_events: popups, canvas_events: canvases };
    },

    /**
     * **玩家自建**（`compose_day` **单条版** · 时间线 T2-d）。
     *
     * ⚠️ 形状检查与 `composeDay` **逐字同款**（"两个通道必须是数组"）—— 它俩是同一个
     *    function，输出形状本来就没区别；差别只在**语义**上多一条"档 A 那半必须是空数组"，
     *    而那一条**不由这里负责**：落地层按结构分通道、`mode: 'create'` 会把档 A 整批忽略
     *    （在这里顺手清一遍 = 同一个口径两处实现，而两处都能漏）。
     * ⚠️ **失败即抛**：由 `turn/create.ts` / UI 侧把异常交出去 —— 玩家敲了那句话却什么都没
     *    发生，是**肉眼可见**的；悄悄补一条默认事件比这坏得多。
     */
    async createEvent(l, approach): Promise<RawComposeOutput> {
      const { args } = await send(buildCreateRequest(cfg, l, approach), '创建事件');
      const popups = args.popup_events;
      const canvases = args.canvas_events;
      if (!Array.isArray(popups) || !Array.isArray(canvases)) {
        throw new LlmCallFailed(
          `自建输出形状错：popup_events 是 ${Array.isArray(popups) ? '数组' : typeof popups}、` +
            `canvas_events 是 ${Array.isArray(canvases) ? '数组' : typeof canvases}（两个都必须是数组）`,
        );
      }
      return { popup_events: popups, canvas_events: canvases };
    },

    /**
     * **章节占卜**（`chapter_shift` 侧链 · 每章一次）。
     *
     * ⚠️ 只校验**形状**（两个键在不在、类型对不对）—— 与 `opening` 同一条纪律：
     *    形状错 ⇒ 抛；语义（氛围非空且 ≤30 字、欲念变化钳 −20~+20、双轨判定）不在这里判，
     *    由 `turn/chapter-shift.ts·applyChapterShift` 承担（**服务端对输出完全不校验**，Phase 0 §三）。
     * ⚠️ `章节欲念变化` 只要求是**数字**（不要求整数 —— 模型给 3.0 也让过，落地层会 `Math.trunc`）；
     *    越界**不在这里拒** —— 落地层钳，而不是废掉整次占卜（氛围还等着落账）。
     * ⚠️ **失败即抛**：调用侧（`t0.ts`）记警告、这一章的氛围保持上一版，但**不炸掉 T0**。
     */
    async chapterShift(l, cards): Promise<RawChapterShiftOutput> {
      const { args } = await send(buildChapterShiftRequest(cfg, l, cards), '占卜');
      if (typeof args.章节氛围 !== 'string') {
        throw new LlmCallFailed(`占卜输出形状错：章节氛围是 ${typeof args.章节氛围}（必须是字符串）`);
      }
      if (typeof args.章节欲念变化 !== 'number') {
        throw new LlmCallFailed(
          `占卜输出形状错：章节欲念变化是 ${typeof args.章节欲念变化}（必须是数字）`,
        );
      }
      return { 章节欲念变化: args.章节欲念变化, 章节氛围: args.章节氛围 };
    },

    /**
     * **概要归并**（`archive` 侧链 · 全局约 2~3 次）。
     * ⚠️ **失败即抛**：调用侧（`t0.ts`）记警告、概要保持原样，但**不炸掉 T0**。
     */
    async archive(l, plan): Promise<RawArchiveOutput> {
      const { args } = await send(buildArchiveRequest(cfg, l, plan), '归并');
      if (typeof args.归档段 !== 'string') {
        throw new LlmCallFailed(`归并输出形状错：归档段是 ${typeof args.归档段}（必须是字符串）`);
      }
      return { 归档段: args.归档段 };
    },

    /**
     * **终局叙事**（`ending` 侧链 · 全局至多 1 次）。
     *
     * ⚠️ 只校验**形状**（那个键在不在、是不是字符串）—— 与 `chapterShift` / `archive`
     *    同一条纪律：形状错 ⇒ 抛；语义（判词 100~200 字）不在这里判，
     *    由 `turn/ending.ts·applyEnding` 承担（**服务端对输出完全不校验**，Phase 0 §三）。
     * ⚠️ **失败即抛**：调用侧（`writeEnding`）记警告、话术保持缺失 ——
     *    但 `closeGame` 已经定下的结局**不受影响**（判定与话术是两件事）。
     *
     * ⚠️⚠️ **2026-10-06 用户裁定：只读一个字段。**
     *   `结局标题` **不再读**（模型不给了；标题由规则层在 `finalEndingOf` 里写定）⇒
     *   **多出来的键一律忽略，绝不因此报错**（那是把模型的礼貌当契约）。
     */
    async ending(l): Promise<RawEndingOutput> {
      const { args } = await send(buildEndingRequest(cfg, l), '结局');
      if (typeof args.结局判词 !== 'string') {
        throw new LlmCallFailed(`结局输出形状错：结局判词是 ${typeof args.结局判词}（必须是字符串）`);
      }
      return { 结局判词: args.结局判词 };
    },

    /**
     * **多轮「穿越」· 一轮**（2026-10-07 起**每轮一次调用**，不掷骰、无裁定半）。
     *
     * ⚠️⚠️ **DeepSeek 的 tool 消息硬校验**（2026-10-07 实测 400 的根因）：
     *    `assistant(tool_calls)` 后面**必须紧跟**对每一条 `tool_call_id` 的 `tool` 回执，
     *    中间隔一条 `user` 都不行（"…must be followed by tool messages following
     *    tool_calls…"）。旧两段式有两处违反：一段式的轮次把 `assistant(tool_calls)`
     *    裸留在历史末尾；两段式则把叙事半的 `user` 插在了 `tool` 回执**之前**。
     *    ⇒ 现在每轮都把**三元组** `user → assistant(tool_calls) → tool(同 id 回执)` 一并
     *      存进 `conv`，历史永远自洽；回执只说"已交给玩家"，不夹带任何结算数值。
     */
    async sceneTurn(ev, l, h, view, conv, onNarrDelta): Promise<SceneStep<RawResolution>> {
      const c0 = convOf(conv);
      const req = buildSceneTurnRequest(cfg, l, ev, h, view, c0);
      const { args, raw } = await send(req, '叙事', onNarrDelta);
      const toolCallId = extractToolCall(raw).toolCallId ?? 'call_scene';
      return {
        value: extractResolution(args),
        conv: {
          messages: [
            ...c0.messages,
            userMessage(req.prompt.user),
            assistantToolCall(toolCallId, 'scene', args),
            toolMessage(toolCallId, { 收到: '本轮回应已交给玩家' }),
          ],
        },
      };
    },

    /**
     * **多轮「穿越」· 收尾** —— 一次调用，产出整场 `summary` ＋ 尚未落账的 `delta`。
     * ⚠️ 它**可以被省掉**（末轮已 `scene_over=true`）—— 省不省由 `turn/scene.ts` 决定，
     *    不在这里：这里只负责"被叫到就把它做好"。
     * ⚠️ 收尾之后 `conv` 随场景一起弃掉，但回执**照样补上** —— 历史自洽不靠"反正没人再看"。
     */
    async sceneWrap(ev, l, reason, view, conv): Promise<SceneStep<RawResolution>> {
      const c0 = convOf(conv);
      const req = buildSceneWrapRequest(cfg, l, ev, reason, view, c0);
      const { args, raw } = await send(req, '收尾');
      const toolCallId = extractToolCall(raw).toolCallId ?? 'call_scene_wrap';
      return {
        value: extractResolution(args),
        conv: {
          messages: [
            ...c0.messages,
            userMessage(req.prompt.user),
            assistantToolCall(toolCallId, 'scene', args),
            toolMessage(toolCallId, { 收到: '收尾结算已落账' }),
          ],
        },
      };
    },
  };
}
