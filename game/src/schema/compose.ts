// `compose_day` 的 tools 定义
//
// 一个 function、**两份指令**（同一 function 名，靠 system ② 区分）：
//   · 「生成」  —— T0 换日，产出当天的 popup_events ＋ canvas_events
//   · 「创建事件」—— 玩家自建，只填 1 条 canvas_events、popup_events 填空数组
//
// 组装纪律照 §1.1：`$def` 与 properties 平级、**只挂被引用到的**、放对象末尾。
// ⚠️ `PopupEvent` / `CanvasEvent` 是**本调用点私有**的 `$def`（`resolve` 用不到）⇒ 定义在这里，
//    不进 `defs.ts` —— `defs.ts` 只放**跨调用点共用**的零件（Check / Delta / Vouchers / Place / Person / Item）。
//
// ⚠️ **档 A 的 `delta` 不做收窄（2026-09-18 用户裁定）**：`options[].delta` 引用的就是**整个 `Delta`**。
//    「按调用点收窄」与指令正文里那条"只允许 gold / rep"的说明**一并去掉**
//    ⇒ 档 A 的 delta 在**声明与实现上都不受限**（`applyDelta` 本就是这个语义）。
//    文档里相关条目**标为「搁置」、以本文件为准**。
import { RESOLVE_DEFS, type JsonSchema } from './defs.ts';
import { buildToolFunction, usedDefs } from './resolve.ts';

// ── §6.4 `PopupEvent`（档 A —— 无 `tier`、带 `options`、`deadline` 恒 1）────────
const POPUP_EVENT: JsonSchema = {
  type: 'object',
  // ⚠️ 2026-10-07 用户裁定：把"这类事件很轻"写进 api 字段本身 —— 模型只有在这里才必读。
  description:
    '档 A（强制弹窗事件）。**此类型事件只需要玩家或其下属消耗很少的时间来处理**：玩家点选一个选项即完成，' +
    '不占行动点、不进判定、没有"派人去办"的过程 ⇒ 不要把它写成需要筹备、外出或多天才能了结的行动。',
  properties: {
    id: {
      type: 'string',
      description:
        '本地编号，形如 e1 / e2；仅在本次输出内唯一，供其他事件的 trigger 引用。系统落地时重写为全局 id，LLM 不用管全局格式',
    },
    title: { type: 'string', description: '事件标题，≤12 字' },
    seed_id: {
      type: 'string',
      description:
        '本事件承接的系统种子编号（形如 s1 / s2，从系统本次给出的种子列表里挑）；未承接任何种子填空字符串。**只填种子编号，不要填其它事件编号**——填了 `e*` 或不在本次种子列表里的编号，系统一律按「未承接」忽略（允许留空）。硬种子（checkpoint）必须被某条事件承接；未被承接的软种子当天丢弃',
    },
    stage: {
      type: 'string',
      description:
        '发生地点。**直接用实体表里已注册的地点名**（已注册 9 处，见《设定.md·预置地点》；同一地点固定用同一个名字，不要换写法）；**也可以新建**，并同时按 entities.places 登记（别只写在 stage 里）',
    },
    content: { type: 'string', description: '给玩家看的事件描述（到底发生了什么），2~3 句' },
    deadline: {
      type: 'integer',
      minimum: 1,
      maximum: 5,
      description: '**档 A 不过期**（恒为强制弹窗、必须当天处理完）⇒ 本字段仅为形状完整保留，固定填 1',
    },
    options: {
      type: 'array',
      description:
        '选项 1~3 个（通知类 1 个、if-else 类 2~3 个）。各选项预写好结果文案、一条**事件概要 `summary`**、一个**`欲向`**（只能填 `无关` / `偏离` / `趋近`）与**固定 Delta**（结算时不调用 LLM：套用文案 ＋ 应用该 Delta 即完成）；其中**至多 1 个带 trigger**',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: '选项文字（玩家点选前看到的按钮），≤16 字' },
          result_text: { type: 'string', description: '选中后立即显示的结算文案（选后看到的结果），2~3 句，要写出后果' },
          summary: {
            type: 'string',
            description:
              '选中后落进「已处理概要」的**事件级事实记录，≤75 字**：谁（名字）· 在哪儿 · 做了什么 · 结果如何等。写出相关人物 / 地点 / 物品的名字，**不写 id / 数值**。档 A 不调 LLM ⇒ 它是这件事在历史上留下的**唯一痕迹**',
          },
          delta: { $ref: '#/$def/Delta' },
          trigger: {
            type: 'string',
            description:
              '选中后当场出现的隐藏事件编号（形如 e2，同批事件里的本地 id）；不触发填空字符串。**被触发的隐藏事件不要回填父事件编号**',
          },
          欲向: {
            type: 'string',
            enum: ['无关', '偏离', '趋近'],
            description:
              '这个选项把他的欲望推向了哪里：**无关** = 跟他想要的东西没关系（**默认值，绝大多数选项都是它**）；**偏离** = 把他往反方向带了一点；**趋近** = 这一手明显地朝那个方向走了一步（不是沾边，是真在往那儿使劲）。⚠️ **只有三档**——点一下的轻量选择拿不到东西，所以**不出现「得偿」「盛宴」**。玩家点选时它随 `delta` / `summary` 一起落账，系统据此查表改欲念（你不给数）',
          },
        },
        required: ['label', 'result_text', 'summary', 'delta', 'trigger', '欲向'],
        additionalProperties: false,
      },
    },
  },
  required: ['id', 'title', 'seed_id', 'stage', 'content', 'deadline', 'options'],
  additionalProperties: false,
};

// ── §6.4 `CanvasEvent`（档 B/C —— 带 `tier`、无 `options`）────────────────────
const CANVAS_EVENT: JsonSchema = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description: '本地编号，形如 e4 / e5；仅在本次输出内唯一。系统落地时重写为全局 id',
    },
    title: { type: 'string', description: '事件标题，≤12 字' },
    seed_id: {
      type: 'string',
      description:
        '同 PopupEvent：承接的系统种子编号（s1 / s2…）；未承接填空字符串。只填种子编号，不填事件编号（填 `e*` 或列表外编号 → 系统按「未承接」忽略；可留空）',
    },
    stage: {
      type: 'string',
      description:
        '发生地点。**直接用实体表里已注册的地点名**（已注册 9 处，见《设定.md·预置地点》）；**也可以新建**，并同时按 entities.places 登记',
    },
    content: { type: 'string', description: '给玩家看的事件描述（到底发生了什么），2~3 句' },
    hint_attr: {
      type: 'array',
      description:
        '给玩家看的**参考判定属性**（**1~3 个**，= 这次判定预期的参与属性；多个则取平均成目标值 A）：玩家据它判断该派谁、怎么打；裁定半默认按它取，玩家换了打法、或裁定者判断该换时改用别的属性（它只是参考）',
      items: { type: 'string', enum: ['争斗', '敏捷', '智慧', '魅力', '社交', '感知'] },
    },
    min_people: {
      type: 'integer',
      minimum: 1,
      maximum: 5,
      description: '处理这条事件最少需要几人；**少于它系统直接不允许处理**。1 ≤ min ≤ max',
    },
    max_people: { type: 'integer', minimum: 1, maximum: 5, description: '最多可参与几人；超过则系统拒绝再派人' },
    tier: { type: 'string', enum: ['B', 'C'], description: 'B=单次判定；C=多轮对话（全场最贵，≤1 条/天）' },
    cost: {
      type: 'integer',
      minimum: 0,
      maximum: 20,
      description:
        '这条事件的**处理时长**（行动点，一天 = 4 点）。挡位只有 0 / 1 / 2 / 4 与 **4 的倍数（8 / 12 / 16 …）** —— **不存在 6**：要么当天做完（≤ 4），要么整天地跨（4 × 天数）。`> 4` 即跨天（主事者要离家多天：启程即扣光当天剩余、记作 `d`，归队日只回升 `d`）。**揭晓时刻 = 排布时刻 + cost** —— 生成侧只回答"这件事要花多久"，不预知玩家何时启程',
    },
    min_gold: {
      type: 'integer',
      minimum: 0,
      maximum: 200,
      description:
        '处理这条事件**至少需要投入多少金币**（0 = 不需要钱）。玩家提交时可以给得比它多——他给多少，这件事能消耗的钱上限 `P` 就是多少（多给 = 允许更大手笔的解法，如打点 / 买通 / 摆平）。⚠️ **`P` 是硬上限，且罩住这条事件的全部金币消耗——包括意外损失**（抢劫 / 偷盗 / 罚没）：**他们身上只带了这么多钱**。系统在提交那一刻就把这笔钱扣下、锁在这条事件里，结算时按**实际消耗**退还差额。⚠️ 经济口径：玩家每周一领 20 枚周例钱 ⇒ **多数事件的花费在 5 金币及以下**（min_gold ≤ 5）；低于 1 金币的视为免费（直接填 0）；只有真正的大手笔（重礼 / 赎金 / 重赌注）才配更高',
    },
    deadline: {
      type: 'integer',
      minimum: 1,
      maximum: 4,
      description:
        '处理时限（**按「天」计**：挡位 `1 / 2 / 4`、**最短 1 天** —— **它不属 `cost` 的点数挡位体系**）—— 生成日 + 这么多「天」的**日界**仍未处理即**过期**：系统当作一次「玩家选择忽略这件事」的标准结算，按事件的**重要程度**生成后果与概要（落账后状态同为 `已结算`）。',
    },
    dispatchable: {
      type: 'string',
      enum: ['两者皆可', '仅亲自', '仅派遣'],
      description: '处理方式限制。「仅派遣」用于远征/潜伏/商队等玩家无法亲自的长离岗事件',
    },
    required_person: {
      type: 'string',
      description:
        '若这件事**非他不可**（只有他会开那把锁 / 只有他认得那条路 / 只有他的身份进得去），填他的**人物编号**（形如 npc004，从实体表里挑、不要编）；若只是「他去最合适」，**填空字符串**——那种情况交给参考判定属性去引导玩家自己判断。⚠️ 它说的是**必须包含他**（可以再带帮手），不是「只能是他」',
    },
  },
  required: [
    'id',
    'title',
    'seed_id',
    'stage',
    'content',
    'hint_attr',
    'min_people',
    'max_people',
    'tier',
    'cost',
    'min_gold',
    'deadline',
    'dispatchable',
    'required_person',
  ],
  additionalProperties: false,
};

/** 本调用点可用的 `$def` 池 = 共用零件（`defs.ts`）＋ 两个**私有**零件 */
export const COMPOSE_DEFS: Record<string, JsonSchema> = {
  PopupEvent: POPUP_EVENT,
  CanvasEvent: CANVAS_EVENT,
  ...RESOLVE_DEFS,
};

const COMPOSE_PROPERTIES: JsonSchema = {
  popup_events: {
    type: 'array',
    description:
      '档 A 事件（通知类 1 个选项 / if-else 类 2~3 个选项），无数量上限（受自由事件总数 ≤5 约束）。**全部是强制弹窗**：进新的一天先弹、逐条处理完才解锁其他事件与「进下一天」⇒ 每一条都要值得打断玩家，别塞无意义的通知。每个选项预写好结果文案与固定 Delta（结算时不调用 LLM）',
    items: { $ref: '#/$def/PopupEvent' },
  },
  canvas_events: {
    type: 'array',
    description:
      '档 B（单次判定）/ 档 C（多轮）事件，无数量上限（受自由事件总数 ≤5 约束；档 C ≤1 条/天），需要玩家投入后再调用 resolve',
    items: { $ref: '#/$def/CanvasEvent' },
  },
};

const COMPOSE_REQUIRED = ['popup_events', 'canvas_events'];

/** `compose_day` 的 `parameters`。`$def` 只挂被引用到的（由 `usedDefs()` 反推，不手写清单）。 */
export function composeParameters(): JsonSchema {
  const properties = { ...COMPOSE_PROPERTIES };
  const names = usedDefs({ properties, required: COMPOSE_REQUIRED }, COMPOSE_DEFS);
  const defs: Record<string, JsonSchema> = {};
  for (const n of names) defs[n] = COMPOSE_DEFS[n];
  return {
    type: 'object',
    properties,
    required: COMPOSE_REQUIRED,
    additionalProperties: false,
    $def: defs, // ← 末尾，别提前
  };
}

export const COMPOSE_DESCRIPTION =
  '生成今天推送给玩家的事件。分两个通道：popup_events 走弹窗（**强制弹窗——玩家必须当天全部处理完，才能做别的事**；选中即时生效、不掷骰，所以你要**在 result_text 里直接把那一下的后果写好**）；canvas_events 走画布卡片（档 B/C，玩家投入人手或亲自去做，之后才判定成败）。自由事件总数 ≤5。';

export function composeTool(): JsonSchema {
  return buildToolFunction('compose_day', { description: COMPOSE_DESCRIPTION, parameters: composeParameters() });
}

/** §6.4 的两条硬顶 —— 供指令正文与**单测**共用一份，避免两处各写一个数 */
export const FREE_EVENT_CAP = 5;
export const MULTIROUND_CAP = 1;
