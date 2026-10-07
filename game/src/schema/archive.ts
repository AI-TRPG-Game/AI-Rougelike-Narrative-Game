// `archive` 的 tools 定义
//
// ⚠️ 它**平时不挂 `tools`** —— 只在 T0 的「概要归并」位（章首检查超限 / 总量越硬顶）挂上、
//    用完即卸。
//
// ⚠️ 无 `$def` 依赖（§1.2 表里 `archive` 的 `$def` 列为「无」）—— 单字段内联。
// ⚠️ `maxLength` 不写：写了也**只是给模型看的提示**，服务端对模型输出**完全不校验**
//    （Phase 0 §三：`minimum` / `maximum` / `enum` 一概穿透）⇒ ≤300 字的钳制由
//    `turn/archive.ts·applyArchive` 承担。**别把 schema 当防线。**
import type { JsonSchema } from './defs.ts';
import { buildToolFunction } from './resolve.ts';
import { ARCHIVE_SEGMENT_MAX } from '../rules/archive.ts';

export const ARCHIVE_DESCRIPTION =
  '把最老的几天事件概要归并成一段更短的历史，作为后续调用要看的长期记忆。只在 T0 的「概要归并」位调用。';

const ARCHIVE_PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    归档段: {
      type: 'string',
      description:
        `归并后的一段历史，≤${ARCHIVE_SEGMENT_MAX} 字。写实（人名 / 地点 / 事由 / 结果）——**人名 / 地名 / 物名一律照抄**（同一个人不要写成两种称呼）；**不写 id、不写数值**；不写情绪形容词、不写推测、不写总结陈词`,
    },
  },
  required: ['归档段'],
  additionalProperties: false,
};

export function archiveTool(): JsonSchema {
  return buildToolFunction('archive', {
    description: ARCHIVE_DESCRIPTION,
    parameters: ARCHIVE_PARAMETERS,
  });
}
