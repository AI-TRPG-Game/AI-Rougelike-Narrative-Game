// 请求组装 —— 三条硬护栏的落点
//
// ① **不提供「不传 `thinking`」这个选项** —— Phase 0 实测：不传即默认**开启**思考模式（A4c），
//    而思考模式下「`tool_choice` 指定具体 function」**必 400**（A2 / A4c）。⇒ 这里没有开关。
// ② 不传 `temperature` / `top_p` —— 统一非思考模式（`contract.md` §5.5 纪律 1）。
// ③ **`assistant.tool_calls` 回填进下一轮之前必须自己 `JSON.parse` + 规范化** ——
//    历史回填内容服务端**完全不校验**（T1 / T2），畸形内容会一路带下去且无人报警。
//    ⇒ `assistantToolCall()` 只收**已经解析过的对象**，从签名上堵住"原样透传字符串"。
//
// `max_tokens` 按 §3.1 的表显式给足：**给大只抬上限、不抬费用**（按实际输出计费）；
// 给小才是亲手招来 `finish_reason=length`（`arguments` 停在半个对象上）。

/** 各调用点的输出预算 —— 初值来自《契约.md》§3.1，等真实输出分布出来再回调 */
export const MAX_TOKENS = {
  'compose_day': 8192,
  /**
   * 玩家自建（`compose_day` **单条版** · 《契约.md》§三「创建事件」· 时间线 T2-d）。
   * ⚠️ 与 `compose_day` **分开登记**：调用点同时被快照文件名与 `tool_choice` 用 ——
   *    混用会让"一天换日那一次"与"玩家敲了一句话那一次"在证据里认不出来。
   * ⚠️ 预算比生成半小得多：它**只产 1 条** `canvas_event`（`popup_events` 恒空数组）。
   * ⚠️ `tool_choice` 指的名字仍是 **`compose_day`**（function 名没变，变的是指令与 user ③）
   *    —— `callPoint` 只管输出预算与快照登记，不管 `tools`。
   */
  'create_event': 2048,
  'resolve.check': 1024,
  'resolve.settle': 2048,
  /** 忽略结算（事件过期）—— 与 `resolve.settle` 同档：它同样要写叙事 ＋ `delta` */
  'resolve.ignore': 2048,
  /**
   * 多轮「穿越」的调用点 —— 2026-10-07 起**每轮只有一次**（场景不掷骰，裁定半整条退休）：
   *   · `scene.turn` = 一轮叙事（写本轮的叙事 ＋ 中途 `delta`，量级同原 `resolve.settle`）
   *   · `scene.wrap` = 收尾（整场 `summary` ＋ 尚未落账的 `delta`）
   * ⚠️ 原 `scene.check` / `scene.settle`（两段式）已随"场景不掷骰"的裁定整条删除。
   */
  'scene.turn': 2048,
  'scene.wrap': 2048,
  'opening': 1024,
  'chapter_shift': 1024,
  'ending': 2048,
  'archive': 1024,
} as const;

export type CallPoint = keyof typeof MAX_TOKENS;

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: ToolCallFunction;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  /** ⚠️ 带 `tool_calls` 的历史消息 `content` 必须是 `''` 而**不是** `null`（用 null 会 400） */
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface BuildOptions {
  model: string;
  messages: ChatMessage[];
  /** **只放当前调用点需要的那一个 function**（未选中的 function 不进 prompt ⇒ 零成本） */
  tools: unknown[];
  /** 锁死到具体 function 名 */
  toolChoiceName: string;
  /** 不传则按调用点取 §3.1 的初值 */
  maxTokens?: number;
  callPoint?: CallPoint;
}

/** 请求体。⚠️ `thinking` 是硬编码，**没有让它缺席的代码路径**。 */
export function buildChatBody(o: BuildOptions): Record<string, unknown> {
  const maxTokens =
    o.maxTokens ?? (o.callPoint ? MAX_TOKENS[o.callPoint] : MAX_TOKENS['resolve.settle']);
  return {
    model: o.model,
    messages: o.messages,
    stream: false,
    tools: o.tools,
    tool_choice: { type: 'function', function: { name: o.toolChoiceName } },
    // ① 硬编码：不传 = 思考模式 = tool_choice 指定 function 直接 400
    thinking: { type: 'disabled' },
    max_tokens: maxTokens,
    // ② 刻意不传 temperature / top_p（非思考模式下 top_p 恒为 1.0，传了也被忽略）
  };
}

/**
 * 造一条 `assistant` 的 tool_calls 历史消息。
 * ⚠️ `args` 必须是**已解析并规范化过的对象** —— 这是护栏 ③ 的签名级落实。
 */
export function assistantToolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): ChatMessage {
  return {
    role: 'assistant',
    content: '', // ⚠️ 空串，不是 null
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  };
}

/**
 * 造一条 `tool` 回填消息。**必须与前面的 `assistant(tool_calls)` 成对**（§2.4）：
 * Chat Completion 不允许中途插入任意 tool 消息，序列只能是
 * `assistant(tool_calls) → tool(同 id) → assistant`。
 */
export function toolMessage(toolCallId: string, payload: unknown): ChatMessage {
  return { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(payload) };
}

export function systemMessage(content: string): ChatMessage {
  return { role: 'system', content };
}

export function userMessage(content: string): ChatMessage {
  return { role: 'user', content };
}
