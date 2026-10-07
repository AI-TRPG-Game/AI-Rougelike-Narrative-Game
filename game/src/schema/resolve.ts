// `resolve` 的 tools 定义
//
// 组装纪律（§1.1）：
//   · `$def` 是 `parameters` 对象里的**兄弟键**（与 properties / required / additionalProperties 平级）
//   · **只挂被引用到的 `$def`** —— resolve 用 Check · Delta · Vouchers · Place · Person · Item
//   · **`$def` 放对象末尾** —— JSON 字节前缀匹配，改 `$def` 不动前面字段的字节
//
// 请求纪律（§1.2 / §3.3）：
//   · `base_url` = `https://api.deepseek.com/beta`（strict 是 Beta 能力）
//   · 每个 function 都 `strict: true`
//   · `tool_choice` = `{"type":"function","function":{"name":"resolve"}}` **锁死**
//   · ⚠️ 前提：**必须关闭思考模式**（见 llm/request.ts —— 那里没有"不传"这个选项）
import { RESOLVE_DEFS, type JsonSchema } from './defs.ts';

/** 递归收集 schema 里所有 `$ref` 指向的名字 */
function refNames(node: unknown, acc: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const x of node) refNames(x, acc);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === '$ref' && typeof v === 'string') {
        const m = /^#\/\$def\/(.+)$/.exec(v);
        if (m) acc.add(m[1]);
      } else {
        refNames(v, acc);
      }
    }
  }
  return acc;
}

/** 收集 schema 里实际会被引用到的 `$def` 名字（含传递闭包：Delta → Place/Person/Item）
 *  ⚠️ **`compose_day` 也用它**（见 `schema/compose.ts`）—— 它是通用的"只挂被引用到的"实现，不属于 resolve。 */
export function usedDefs(root: unknown, pool: Record<string, JsonSchema>): string[] {
  const seen = new Set<string>();
  const queue = [...refNames(root)];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const def = pool[name];
    if (!def) continue;
    for (const n of refNames(def)) if (!seen.has(n)) queue.push(n);
  }
  return [...seen];
}

export interface ToolSpec {
  description: string;
  parameters: JsonSchema;
}

/**
 * 组装一个调用点的 `tools` 条目。
 * ⚠️ `$def` 放最后 —— 这个顺序是缓存友好度的一部分，不要为了"好看"把它提前。
 */
export function buildToolFunction(name: string, spec: ToolSpec): JsonSchema {
  return { type: 'function', function: { name, strict: true, description: spec.description, parameters: spec.parameters } };
}

// ── resolve ────────────────────────────────────────────────────
const RESOLVE_PROPERTIES: JsonSchema = {
  intent_summary: {
    type: 'string',
    description: '用一句话复述玩家这次的方案，供 UI 确认。两段式的第 2 次调用（结算半）填空字符串',
  },
  check: { $ref: '#/$def/Check' },
  narration: {
    type: 'string',
    description:
      '给玩家看的叙事，2~4 句。多轮时写本轮场景与人物回应；收尾时写结算叙事。**要掷骰（verdict=投骰）时这一次留空** —— 掷骰之前不该有结果；不掷骰的三条走法必须在这里写完',
  },
  delta: { $ref: '#/$def/Delta' },
  scene_over: {
    type: 'boolean',
    description:
      '场景是否已自然收束（对方明确拒绝 / 事情办完）。收尾恒为 true；多轮互动的**中途轮填 false**。**要掷骰时这一次填 false**（掷骰之前还不到判断收束的时候）',
  },
  summary: {
    type: 'string',
    description:
      '事件级事实记录，≤75 字：谁（名字）· 在哪儿 · 做了什么 · 结果如何等。写出相关人物 / 地点 / 物品的名字，**不写 id / 数值**。仅 scene_over=true 时填（会替换这段过程的原始记录，成为后续调用看到的历史）；否则填空字符串。**要掷骰时这一次留空**',
  },
  next_seeds: {
    type: 'array',
    description:
      '本事件 / 场景留下的后续钩子，作次日生成的种子。仅 scene_over=true 时填；否则填空数组。⚠️ **重要物品到手时（尤其成果凭证物）必须留一条指向它的钩子**——否则它只能躺在账本里，世界对它不会有任何反应。**要掷骰时这一次留空**',
    items: { type: 'string' },
  },
  vouchers: { $ref: '#/$def/Vouchers' },
  欲向: {
    type: 'string',
    enum: ['无关', '偏离', '趋近', '得偿', '盛宴'],
    description:
      '玩家这一手把他的欲望推向了哪里：**无关** = 跟他想要的东西没关系（**默认值，绝大多数结算都是它**）；**偏离** = 方向是反的，为了别的东西把自己想要的推远了一点；**趋近** = 朝那个方向实实在在地近了一步（学到 / 试到 / 搭上线 / 摸出门道）；**得偿** = **真的拿到了**（或拿到关键的一块）；**盛宴** = **一次痛快淋漓的放纵 / 超额兑现**——把欲望喂得饱饱的，痛快，也失控。⚠️ 判的是「**他做的事**」不是「事件本身多精彩」：做得再漂亮，跟他的欲望不沾边 ⇒ 仍是「无关」。⚠️ **判据是【他的欲望】里的「目的」那一句**（那是他真正想要的东西）。⚠️ **不要用「手段」那一句判这里** —— 手段管的是另一个维度（`vouchers.the_proper_way`）；「宣言」只是气氛，一个字都不参与判定。⚠️ **它可能还没有出现**（那是他的指望，不保证这局里会有）——在它真的出现、真的被他碰到之前，「他今天又想着它」**不算**「趋近」：**趋近 / 得偿必须有一次实物进展**（听说这个名字、远远看见那个人、拿到一件属于他的东西、摸出门道）。**要掷骰时这一次填「无关」**（掷骰后系统还会问你一次）；不掷骰时必须按实际判。数值由规则层查表，你不给数',
  },
};

const RESOLVE_REQUIRED = [
  'intent_summary',
  'check',
  'narration',
  'delta',
  'scene_over',
  'summary',
  'next_seeds',
  'vouchers',
  '欲向',
];

/**
 * `resolve` 的 `parameters`。`$def` **只挂真正被引用到的**那几条 —— 这里由 `usedDefs()`
 * 从 `properties` 反推，不靠手写清单（手写清单会随字段增删悄悄漂移）。
 */
export function resolveParameters(): JsonSchema {
  const properties = { ...RESOLVE_PROPERTIES };
  const names = usedDefs({ properties, required: RESOLVE_REQUIRED }, RESOLVE_DEFS);
  const defs: Record<string, JsonSchema> = {};
  for (const n of names) defs[n] = RESOLVE_DEFS[n];
  return {
    type: 'object',
    properties,
    required: RESOLVE_REQUIRED,
    additionalProperties: false,
    $def: defs, // ← 末尾，别提前
  };
}

export const RESOLVE_DESCRIPTION =
  '结算玩家的一次事件处理，先判断需要不要判定，不需要则直接结算；需要则按格式输出如何结算，不输出其他；有判定结果时直接结算。';

export function resolveTool(): JsonSchema {
  return buildToolFunction('resolve', { description: RESOLVE_DESCRIPTION, parameters: resolveParameters() });
}

// ── scene（多轮「穿越」专用）───────────────────────────────────
//
// ⚠️⚠️ **2026-10-07 用户裁定：场景内不做投掷判定**（用户原话「场景内的LLM对话不需要投掷
//    判定，去掉相关的输出要求和系统逻辑」）⇒ 场景的每一轮与收尾**不再有**
//    `intent_summary`（那是裁定半的复述位）与 `check`（裁定半本身）。
//    与 `resolve` 的差别**只有这两处**：其余字段（narration / delta / scene_over /
//    summary / next_seeds / vouchers / 欲向）逐字沿用 —— 字段说明里"要掷骰时…"那几句
//    随之**删净**（那条走法在场景里已经不存在）。
const SCENE_PROPERTY_OVERRIDES: Record<string, JsonSchema> = {
  narration: {
    type: 'string',
    description: '给玩家看的叙事，2~4 句。多轮时写本轮场景与人物的回应；收尾时写结算叙事。',
  },
  scene_over: {
    type: 'boolean',
    description: '场景是否已自然收束（对方明确拒绝 / 事情办完）。收尾恒为 true；多轮互动的**中途轮填 false**',
  },
  summary: {
    type: 'string',
    description:
      '事件级事实记录，≤75 字：谁（名字）· 在哪儿 · 做了什么 · 结果如何等。写出相关人物 / 地点 / 物品的名字，**不写 id / 数值**。仅 scene_over=true 时填（会替换这段过程的原始记录，成为后续调用看到的历史）；否则填空字符串',
  },
  next_seeds: {
    type: 'array',
    description:
      '本事件 / 场景留下的后续钩子，作次日生成的种子。仅 scene_over=true 时填；否则填空数组。⚠️ **重要物品到手时（尤其成果凭证物）必须留一条指向它的钩子**——否则它只能躺在账本里，世界对它不会有任何反应',
    items: { type: 'string' },
  },
  欲向: {
    type: 'string',
    enum: ['无关', '偏离', '趋近', '得偿', '盛宴'],
    description:
      '玩家这一手把他的欲望推向了哪里：**无关** = 跟他想要的东西没关系（**默认值，绝大多数结算都是它**）；**偏离** = 方向是反的；**趋近** = 朝那个方向实实在在地近了一步（学到 / 试到 / 搭上线 / 摸出门道）；**得偿** = **真的拿到了**（或拿到关键的一块）；**盛宴** = **一次痛快淋漓的放纵 / 超额兑现**。⚠️ 判的是「**他做的事**」不是「事件本身多精彩」。⚠️ **判据是【他的欲望】里的「目的」那一句**（那是他真正想要的东西）。⚠️ **不要用「手段」那一句判这里**。⚠️ **它可能还没有出现**——在它真的被他碰到之前，「他今天又想着它」**不算**「趋近」：**趋近 / 得偿必须有一次实物进展**。数值由规则层查表，你不给数',
  },
};

const SCENE_PROPERTIES: JsonSchema = Object.fromEntries(
  Object.entries(RESOLVE_PROPERTIES)
    .filter(([k]) => k !== 'intent_summary' && k !== 'check')
    .map(([k, v]) => [k, SCENE_PROPERTY_OVERRIDES[k] ?? v]),
);

const SCENE_REQUIRED = [
  'narration',
  'delta',
  'scene_over',
  'summary',
  'next_seeds',
  'vouchers',
  '欲向',
];

export function sceneParameters(): JsonSchema {
  const properties = { ...SCENE_PROPERTIES };
  const names = usedDefs({ properties, required: SCENE_REQUIRED }, RESOLVE_DEFS);
  const defs: Record<string, JsonSchema> = {};
  for (const n of names) defs[n] = RESOLVE_DEFS[n];
  return {
    type: 'object',
    properties,
    required: SCENE_REQUIRED,
    additionalProperties: false,
    $def: defs, // ← 末尾，别提前
  };
}

export const SCENE_DESCRIPTION =
  '推进场景一轮或为场景收尾：基于世界观与剧情，对玩家的输入给出合理的文字回应与场景结算，不掷骰、不判定。';

export function sceneTool(): JsonSchema {
  return buildToolFunction('scene', { description: SCENE_DESCRIPTION, parameters: sceneParameters() });
}

/**
 * 自检：`$ref` 指向的名字必须都在 `$def` 里。
 * ⚠️ Node 的 type stripping 不做类型检查 ⇒ schema 写错不会有人告诉你，
 *    所以这条断言要有 —— 它抓的是"引用了但忘了挂"这类静默错误。
 */
export function checkRefs(parameters: JsonSchema): string[] {
  const defs = (parameters.$def ?? {}) as Record<string, unknown>;
  const missing = [...refNames(parameters)].filter((n) => !(n in defs));
  return missing;
}
