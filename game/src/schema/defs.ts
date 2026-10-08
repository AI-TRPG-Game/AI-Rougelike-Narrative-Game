// JSON Schema 的共享 `$def` —— 基础类型的**逐字**落地（判据内联在本文件）
//
// ⚠️ 这些是**共享零件**：`resolve`（Phase 2）与 `compose_day`（Phase 3）引用**同一份**。
//    《装配规范.md》§1.1 的纪律：**只挂被引用到的 `$def`**，且 `$def` 放在 `parameters` 末尾
//    —— JSON 是字节前缀匹配，改靠后的 `$def` 不会动到前面字段的字节（缓存友好）。
//
// ⚠️ Node 22 的 type stripping **不做类型检查** ⇒ 这里全靠"抄得准"。
//    **不要在代码里顺手改写 `description`**：它是给模型看的提示词，改一个字都可能改变生成倾向。
//    要改就先改《契约.md》，再同步过来。
//
// ⚠️ `description` 里刻意保留的实测结论（`pattern` / 区间"只作提示、不作防线"）不要删——
//    它们是 Phase 0 花了一轮探针换来的，删掉会让下一个人重新以为服务端会校验。

/** JSON Schema 片段（不引第三方类型） */
export type JsonSchema = Record<string, unknown>;

// ── §6.3 `Check`（判定参数 —— 投骰之前）────────────────────────────
export const CHECK: JsonSchema = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: ['本次不裁定', '无需判定', '直接成功', '直接失败', '投骰'],
      description:
        '本题的判定方式，**它同时决定这一次调用走哪条路**：「投骰」= 这一次只给判定要素、结算留到下一次调用；「直接成功」/「直接失败」/「无需判定」= 不掷骰，**这一次就把结算一起填完**；例行公事、没有风险选「无需判定」。「本次不裁定」用于结算半（两段式的第 2 次调用）——表示这次调用不做裁定。**没有「拒绝」这个选项**：玩家再离谱的输入也由你按世界观合理化（见指令）',
    },
    participants: {
      type: 'array',
      description: '参与判定的属性，1~3 个，取平均后作目标值 A；无需判定时填空数组',
      items: { type: 'string', enum: ['争斗', '敏捷', '智慧', '魅力', '社交', '感知'] },
    },
    difficulty: {
      type: 'string',
      enum: ['无修正', '惩罚1', '惩罚2', '奖励1', '奖励2'],
      description:
        '惩罚=给骰子 +1d4 / +2d4（更难），奖励=−1d4 / −2d4（更易）。仅 verdict=投骰 时有效，其余填「无修正」',
    },
    direct_result: {
      type: 'string',
      enum: ['无', '大成功', '困难成功', '成功', '失败', '大失败'],
      description: '仅 verdict=直接成功/直接失败 时填，其余填「无」',
    },
  },
  required: ['verdict', 'participants', 'difficulty', 'direct_result'],
  additionalProperties: false,
};

// ── §6.2 `Place` ──────────────────────────────────────────────
export const PLACE: JsonSchema = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      pattern: '^@loc[0-9]+$',
      description:
        '**新地点一律填批次内临时编号**（形如 @loc1，本批唯一）——**不接受既有地点的正式 id**——系统落地时分配正式 id',
    },
    name: { type: 'string', description: '地点名，≤8 字' },
    desc: { type: 'string', description: '一句话描述（在哪、什么样子）' },
  },
  required: ['id', 'name', 'desc'],
  additionalProperties: false,
};

// ── §6.2 `Item` ───────────────────────────────────────────────
export const ITEM: JsonSchema = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      pattern: '^@it[0-9]+$',
      description:
        '**新物品一律填批次内临时编号**（形如 @it1，本批唯一）——**不接受既有物品的正式 id**——供本批的 vouchers / change / lost / 人物 items 引用。系统落地时分配正式 id，并把本批所有对该编号的引用一并改写为正式 id',
    },
    name: { type: 'string', description: '物品名，≤8 字' },
    kind: { type: 'string', enum: ['装备', '消耗品', '特殊物品'], description: '物品大类' },
    desc: { type: 'string', description: '一句话描述' },
    attr_bonus: {
      type: 'array',
      description:
        '属性加成。**可以有、也可以没有**——没有就填空数组 []（多数物品只有描述、没有数值）。有则**至多两项**，每项一个属性 ＋ 一个档值，**档值只取 1 / 2 / 3 / 5**（物品的「品级」由系统按这里最高的那个档值反推，**你不用管品级**）。加成是货物与馈赠里的少数，不必每件都给',
      items: {
        type: 'object',
        properties: {
          attr: { type: 'string', enum: ['争斗', '敏捷', '智慧', '魅力', '社交', '感知'], description: '加成属性' },
          bonus: { type: 'integer', enum: [1, 2, 3, 5], description: '加成数值' },
        },
        required: ['attr', 'bonus'],
        additionalProperties: false,
      },
    },
    holder: {
      type: 'string',
      description: '携带者 id；无人携带填空字符串。通常由系统维护，你不必填写',
    },
  },
  required: ['id', 'name', 'kind', 'desc', 'attr_bonus', 'holder'],
  additionalProperties: false,
};

// ── §6.2 `Person` ─────────────────────────────────────────────
export const PERSON: JsonSchema = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      pattern: '^@p[0-9]+$',
      description:
        '**新角色一律填批次内临时编号**（形如 @p1，本批唯一）——**不接受既有角色的正式 id**（改人物走 change）——系统落地时分配正式 id 并回写本批引用',
    },
    name: { type: 'string' },
    race: {
      type: 'string',
      enum: ['人类', '矮人', '半精灵', '精灵', '半兽人', '其他'],
      description:
        '种族。**预置阵容一律「人类」**——非人种族**不入阵容**，只作世界的边缘背景（如金庭市集的奴隶市场里的半兽人 / 半精灵）出现，或由你在剧情需要时为**新生成的边缘人物**填。**奇幻元素稀少、不作奇观处理**（没人围观、交易照常）。不进投掷，只作外貌与称呼的锚点',
    },
    basic: {
      type: 'string',
      description: '基础信息。一句话：头衔 / 与三王子的关系（如「国王，三王子之父」）',
    },
    identity: {
      type: 'string',
      enum: ['贵族', '平民', '奴隶', '罪犯', '异国人', '其他'],
      description:
        '身份。**只作叙事与语感用**：三王子能不能派人去做某件事，由你在可行性「权限」条里按常理判断（如「让一个奴隶代他上朝」就是不成的）——身份不是门槛，常理才是',
    },
    in_your_eyes: {
      type: 'string',
      description:
        '「你眼中的ta」——三王子（玩家）眼中这个人，一句话主观印象（≤20 字），**可能是错的**；随互动更新，未变时照抄原值。玩家本人（npc000）填空字符串',
    },
    openness: {
      type: 'integer',
      minimum: 0,
      maximum: 20,
      description:
        '「ta愿意展现给你的真实」——这个人愿意向三王子展现出的真实程度：**0 = 全套伪装 / 彻底疏离，20 = 完全坦诚**。它只说「愿意让你看到多少真实」，不写他心里怎么想；只作叙事与语气的指示，**不进投掷**。只对 NPC 有意义，玩家本人（npc000）填 0',
    },
    attrs: {
      type: 'object',
      description:
        '六项属性数值（各 1~20），判定用。**每个角色都给完整六维**；没把握时给 8~12，不要为了「强」而虚高。玩家本人 npc000 的六维由 `opening` 按两张塔罗反推（不属预置数据；序幕期间系统占位全 5），**硬约束：六项均值 ≤ 10**（他是「不成器的三王子」，开局不得比王储更能干）',
      properties: {
        争斗: { type: 'integer', minimum: 1, maximum: 20 },
        敏捷: { type: 'integer', minimum: 1, maximum: 20 },
        智慧: { type: 'integer', minimum: 1, maximum: 20 },
        魅力: { type: 'integer', minimum: 1, maximum: 20 },
        社交: { type: 'integer', minimum: 1, maximum: 20 },
        感知: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description:
            '**只用于术法 / 神明 / 超自然**相关判定——不承担日常的察觉 / 预感（那归智慧 / 敏捷）。世俗人物普遍偏低（4~9）',
        },
      },
      required: ['争斗', '敏捷', '智慧', '魅力', '社交', '感知'],
      additionalProperties: false,
    },
    items: {
      type: 'array',
      description: '该角色携带的物品 id，至多 4 个；无则填空数组。通常由系统维护',
      items: { type: 'string' },
    },
    affiliated: {
      type: 'string',
      enum: ['入队', '不入队'],
      description:
        '**他登场时就属于你吗** —— 即他**一出现就已经听你调遣、你派他办事他就去**。⚠️ 它与好感、亲近、血缘、官阶**全都不挂钩**：国王、王储、朝中大臣、你的血亲 —— 只要是臣属于王室的寻常角色，一律填「不入队」（他们是**世界里的人**，不是你的人；开局全城只有皮普一个人算你的）。**只有他出场即已听命于你**才填「入队」：你母族送来听你使唤的人、你买下的仆役、你早就安插好的眼线、已经效忠于你的旧部。想让自己的人变多，靠后面 `change.affiliated` 一格一格挣 —— **不要**在这里慷慨地批发。',
    },
  },
  required: ['id', 'name', 'race', 'basic', 'identity', 'in_your_eyes', 'openness', 'attrs', 'items', 'affiliated'],
  additionalProperties: false,
};

// ── §6.2 `Vouchers`（⚠️ 是**数组**，不是对象）──────────────────────
export const VOUCHERS: JsonSchema = {
  type: 'array',
  description:
    '本次结算产生的【结局凭证】。**没有就填空数组**——绝大多数结算为空，只在真出现「获得成果 / 手段契合 / 赢得认可」或「成果失效 / 认可被撤回」时才填；**裁定半也填空数组**。三类：the_great_achievement（伟大的成果）· the_proper_way（正当的手段）· the_resonance_of_the_other（他者的共鸣）。',
  items: {
    type: 'object',
    properties: {
      dim: {
        type: 'string',
        enum: ['the_great_achievement', 'the_proper_way', 'the_resonance_of_the_other'],
        description:
          '结局维度。the_great_achievement = 伟大的成果：一件【成果的物证】——⚠️ 它可以是**具体物体**（一枚印章、一把剑），也可以是**抽象概念**（一个头衔、一纸约定、一个众人皆知的名声）；系统会用一张「成果类凭证」卡把它记在玩家名下，可失效（被夺 / 损毁 / 送出 / 被推翻）。the_proper_way = 正当的手段：一次【事件】——注意「正当」**不是客观道德**，而是【**玩家自己认定的**正当】，即【他的欲望】里「**手段**」那一句所指的路子（「通过 X 来 Y」里的 X）；只要这一手是**走那条路子**、且做得足够漂亮，就算数，事实既成、永不撤回。⚠️ 判据是**手段那一句**，不是「目的」（目的管 `欲向`）、也不是「宣言」（宣言只是气氛）。the_resonance_of_the_other = 他者的共鸣：某个关键人物对玩家的真心理解 / 认可（不限预置人物），可被该人撤回。',
      },
      action: {
        type: 'string',
        enum: ['produce', 'recall'],
        description:
          'produce = 本次新增一条；recall = 撤回一条已有的（成果失效 / 认可被反悔）。三类都能 produce；只有 the_great_achievement 与 the_resonance_of_the_other 能 recall，the_proper_way 永不 recall。',
      },
      item: {
        type: 'string',
        pattern: '^(@it[0-9]+|it[0-9]{3,})?$',
        description:
          '仅 the_great_achievement 用：绑定物件的 **id**（不是物品名）。produce = 填该物件在本批 entities.items 里的 id（**新建 → 它的批次内临时编号**，如 @it1，须与该 Item.id 一致；**既有 → 它的正式 id**），系统落地时解析并绑定；recall = 填失效那件既有物品的**正式 id**（系统会一并把它移出账本）。其余维度填空字符串。',
      },
      person: {
        type: 'string',
        pattern: '^(@p[0-9]+|npc[0-9]{3,})?$',
        description:
          '仅 the_resonance_of_the_other 用：人物 **id**（**新建 → 它的批次内临时编号**，如 @p1；**既有 → 实体表里的正式 id**）。其余维度填空字符串。',
      },
      desc: {
        type: 'string',
        description:
          '这条凭证的【描述】——玩家点开凭证卡时读的那段说明，三类都要写：**30~75 字**。the_great_achievement = 写清这件成果是什么、凭什么算数（成果可以是具体物体，也可以是抽象概念：头衔、约定、名声等）；the_proper_way = 写清这次的手段为何算走的是他自己说的那条路子（对着「手段」那一句写）；the_resonance_of_the_other = 写清那个人给出的那句诺言 / 认可，与他为何心悦诚服。recall 时填撤回原因，可空字符串。',
      },
      rarity: {
        type: 'string',
        enum: ['普通', '罕见', '珍稀', '传说'],
        description:
          '这条凭证的【稀有度】，四档单选：普通 / 罕见 / 珍稀 / 传说 —— 按这条成果、手段或认可**本身的分量与难得程度**来评：顺手可得、日常性质的填「普通」；要费一番功夫、或恰逢其时才成全的填「罕见」；真正难得、足以在人前称道的填「珍稀」；一局里屈指可数、近乎传奇的填「传说」。produce 时必填；recall 时也照填（撤回不消耗稀有度判断）。',
      },
    },
    required: ['dim', 'action', 'item', 'person', 'desc', 'rarity'],
    additionalProperties: false,
  },
};

// ── §6.1 `Delta`（世界状态的唯一写入口）────────────────────────────
export const DELTA: JsonSchema = {
  type: 'object',
  description:
    '本次结算对世界状态的全部增量，逐项写在 ops 数组里。每一项只带一个键（键名即变化类型，如 gold / rep / entities / change / lost）；没有变化就填空数组 []；**要掷骰（verdict=投骰）时这一次填 `{"ops":[]}`**（系统掷骰后还会给你一次调用，那时才写实际增量）；不掷骰的三条走法必须在这里写全。**数值类变化一律求和、与顺序无关**；同一个键可以出现多次。',
  properties: {
    ops: {
      type: 'array',
      description: '本次结算的全部变化。每项只带一个键；无变化填空数组 []',
      items: {
        anyOf: [
          {
            type: 'object',
            properties: {
              gold: {
                type: 'integer',
                minimum: -9999,
                maximum: 9999,
                description:
                  '金币增减，负数 = 花掉 / 损失。**照实写这一笔实际花了或得了多少**，不要管余额够不够——系统按这次投入的托管上限结账。单次数量级：几枚是日常，十几枚已是大事',
              },
            },
            required: ['gold'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              rep: {
                type: 'object',
                properties: {
                  善名: {
                    type: 'integer',
                    minimum: -20,
                    maximum: 20,
                    description:
                      '**百姓口中你的好**：护了弱者、赈济、公正断事 ⇒ 加；盘剥、苛待、见死不救 ⇒ 减。别人怎么传你，不是你心里怎么想',
                  },
                  恶名: {
                    type: 'integer',
                    minimum: -20,
                    maximum: 20,
                    description:
                      '**对民的暴戾与出格的恶**：当众行凶、酷虐、纵容手下害人 ⇒ 加；恶行被洗清 / 被遗忘 ⇒ 减。与善名可以同时存在（不同的人看到不同的你）',
                  },
                  侠名: {
                    type: 'integer',
                    minimum: -20,
                    maximum: 20,
                    description:
                      '**江湖式的义气**：替人出头、仗义疏财、说到做到、敢为朋友扛事 ⇒ 加；出卖、临阵脱逃、欺压同道 ⇒ 减。这条名声走的是下城与市井，不看身份',
                  },
                  怪名: {
                    type: 'integer',
                    minimum: -20,
                    maximum: 20,
                    description:
                      '**荒诞离奇、令人侧目的名声**：做出常人不会做的事、与灵异传闻扯上关系 ⇒ 加；风气一变、传闻被淡忘 ⇒ 减。可以是笑柄，也可以是传说',
                  },
                  权势: {
                    type: 'integer',
                    minimum: -20,
                    maximum: 20,
                    description:
                      '**在朝中的分量**：攀上靠山、结交权贵、拿到实职 ⇒ 加；得罪权臣、失宠、被贬 ⇒ 减。⚠️ 五格里**只有它参与判定**，且**只作事件的门槛 / 捷径**（够不够得着），**不进投掷**',
                  },
                },
                required: ['善名', '恶名', '侠名', '怪名', '权势'],
                additionalProperties: false,
              },
            },
            required: ['rep'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              entities: {
                type: 'object',
                description:
                  '**只新建**：本批新出现的地点 / 新人物 / 新物品，一律填批次内临时编号；没有的填空数组。**既有实体不要写在这里**（改人物走 change，物品得失走 vouchers / lost / holder；地点没有动态状态）',
                properties: {
                  places: { type: 'array', items: { $ref: '#/$def/Place' } },
                  people: { type: 'array', items: { $ref: '#/$def/Person' } },
                  items: { type: 'array', items: { $ref: '#/$def/Item' } },
                },
                required: ['places', 'people', 'items'],
                additionalProperties: false,
              },
            },
            required: ['entities'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              change: {
                type: 'object',
                description:
                  '对【已有】角色的逐人变化（hp / san / 属性 / 印象 / 真实度 / **归属**）。每人一项；新建角色走 entities.people',
                properties: {
                  who: {
                    type: 'string',
                    pattern: '^(玩家|参与者|主事者|@[a-z]+[0-9]+|(npc|loc|it)[0-9]{3,})$',
                    description:
                      '角色 id；也可用角色词「玩家」（=npc000）「参与者」「主事者」，系统落账时解析为具体 id',
                  },
                  hp: {
                    type: 'integer',
                    minimum: -5,
                    maximum: 5,
                    description:
                      'HP 增减（负数 = 受伤）。量级：−1 轻伤（挨了一下、擦破皮）· −2 重伤（挂彩见血、被打倒）· −3 濒死。**= 1 已无法处理事件（但还能被抬去医馆）；= 0 即死亡、直接终局**。无变化填 0',
                  },
                  san: {
                    type: 'integer',
                    minimum: -5,
                    maximum: 5,
                    description:
                      'SAN 增减（负数 = 消耗 / 崩坏）。量级：−1 受了刺激 · −2 见了不该见的、信念被撬动 · −3 濒临崩溃。**= 1 已无法处理事件（但还能去神殿）；= 0 即永久疯狂、直接终局**。无变化填 0',
                  },
                  attrs: {
                    type: 'array',
                    description: '永久属性增减（可正可负）；没有填空数组',
                    items: {
                      type: 'object',
                      properties: {
                        attr: { type: 'string', enum: ['争斗', '敏捷', '智慧', '魅力', '社交', '感知'] },
                        delta: {
                          type: 'integer',
                          minimum: -5,
                          maximum: 5,
                          description:
                            '该属性的增减，单次 ≤3（负数 = 退步）。**只有事件真的改变了他才给**（历练、伤病、开窍）；多数结算应为空数组',
                        },
                      },
                      required: ['attr', 'delta'],
                      additionalProperties: false,
                    },
                  },
                  in_your_eyes: {
                    type: 'string',
                    description:
                      '重写后的整句「你眼中的ta」，≤20 字（整句重写，不是拼接）。**只有印象真的变了才重写**——他做了什么让你重新看他；没变就填空字符串',
                  },
                  openness: {
                    type: 'integer',
                    minimum: -20,
                    maximum: 20,
                    description:
                      '「ta愿意展现给你的真实」的增量（正 = 更坦诚、负 = 更伪装）。量级：一次推心置腹 +2~4 · 被识破伪装 / 撕破脸 −3~5 · 交心级别的突破 +5 以上。无变化填 0',
                  },
                  affiliated: {
                    type: 'string',
                    enum: ['保持', '入队', '离队'],
                    description:
                      '**归属变更**：这个人从此算不算「你的人」（他听不听你的调遣、你派他办事他去不去）。⚠️ **不是好感、不是关系变近、不是他喜不喜欢你** —— 他完全可以在心里瞧不起你，但只要他听你的，就算入队。**什么时候动这一格**：「入队」= 他明确接下你给的差事 / 答应替你办事 / 公开站到你这边 / 把自己绑上了你这条船；「离队」= 他明确脱身、改投他人、撕破脸后不再听你调遣。⚠️ 死亡与单纯离开王城**不在这里**（那走 `lost`：人会从账本里移走）；单纯的互信上升也**不在这里**（那走 `openness`）。⚠️ 这是**罕有的转折点**：一次结算**至多给一个人**改这一格；没发生这种事就填「保持」—— **绝大多数结算都该是「保持」**。它直接决定你每天能办多少事，别慷慨。',
                  },
                },
                required: ['who', 'hp', 'san', 'attrs', 'in_your_eyes', 'openness', 'affiliated'],
                additionalProperties: false,
              },
            },
            required: ['change'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              lost: {
                type: 'object',
                properties: {
                  people: {
                    type: 'array',
                    description: '离队 / 死亡的人手 id（**正式 id**）。其随身物品默认回到「未携带」（留在账本）',
                    items: { type: 'string', pattern: '^npc[0-9]{3,}$' },
                  },
                  items: {
                    type: 'array',
                    description: '失去的物品 id（**正式 id**；送出 / 被夺 / 损毁 / 随人离开）；没有填空数组',
                    items: { type: 'string', pattern: '^it[0-9]{3,}$' },
                  },
                },
                required: ['people', 'items'],
                additionalProperties: false,
              },
            },
            required: ['lost'],
            additionalProperties: false,
          },
        ],
      },
    },
  },
  required: ['ops'],
  additionalProperties: false,
};

/** `resolve` 引用到的 `$def` */
export const RESOLVE_DEFS: Record<string, JsonSchema> = {
  Check: CHECK,
  Delta: DELTA,
  Vouchers: VOUCHERS,
  Place: PLACE,
  Person: PERSON,
  Item: ITEM,
};
