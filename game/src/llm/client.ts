// DeepSeek Chat Completions 薄封装 —— **不抛异常，只返回结构化结果**。
//
// 与 `probe/src/client.mjs` 的关系：那份是"看真实行为"的探针，刻意不做重试与兜底。
// 这份是**生产路径**，按《契约.md》§三 3.2 的容错表办事：
//   · 必检 `finish_reason`（非 `tool_calls` 一律视为失败；`length` = 截断）
//   · `JSON.parse` 包 try/except；失败 ⇒ 重试至多 **1** 次
//   · 重试仍失败 ⇒ **返回失败结果，由上层决定"跳过这一条"**（本 demo 不写模板文案兜底）
//   · 降级：`strict` 报 schema 错时，退回非 strict 重试一次（客户端校验本来就是唯一防线）
import type { LlmConfig } from './config.ts';
import { extractToolCall } from './snapshot.ts';

export interface LlmResult {
  /** 真正成功 = HTTP 2xx **且** `finish_reason==='tool_calls'` **且** `arguments` 能解析 */
  ok: boolean;
  status: number;
  elapsedMs: number;
  finishReason: string | null;
  toolName: string | null;
  /** 解析后的 arguments（`ok=false` 时为 null） */
  args: Record<string, unknown> | null;
  argsParseError: string | null;
  apiError: string | null;
  transportError: string | null;
  usage: Record<string, number> | null;
  rawText: string;
  /** 原始响应 JSON —— 快照要留全证据 */
  raw: unknown;
  /** 一共发了几次（含重试） */
  attempts: number;
  warnings: string[];
}

function fail(status: number, rawText: string, warnings: string[]): LlmResult {
  return {
    ok: false,
    status,
    elapsedMs: 0,
    finishReason: null,
    toolName: null,
    args: null,
    argsParseError: null,
    apiError: null,
    transportError: null,
    usage: null,
    rawText,
    raw: null,
    attempts: 1,
    warnings,
  };
}

/** 一次 HTTP 往返。**永不抛异常。** */
export async function sendChat(
  cfg: LlmConfig,
  body: Record<string, unknown>,
  opts: { baseUrl?: string; timeoutMs?: number } = {},
): Promise<LlmResult> {
  const root = (opts.baseUrl || cfg.betaBaseUrl).replace(/\/+$/, '');
  const url = root + '/chat/completions';
  const t0 = Date.now();
  let status = 0;
  let text = '';
  let transportError: string | null = null;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 120_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    transportError = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }

  const elapsedMs = Date.now() - t0;

  if (transportError) {
    return { ...fail(0, '', []), elapsedMs, transportError, attempts: 1 };
  }

  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  const { finishReason, toolName, argsRaw, usage } = extractToolCall(json);
  const apiError =
    json && typeof json === 'object' && 'error' in json
      ? JSON.stringify((json as { error: unknown }).error)
      : null;

  let args: Record<string, unknown> | null = null;
  let argsParseError: string | null = null;
  if (argsRaw !== null) {
    try {
      const parsed: unknown = JSON.parse(argsRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      } else {
        argsParseError = `arguments 不是对象（实为 ${Array.isArray(parsed) ? 'array' : typeof parsed}）`;
      }
    } catch (e) {
      argsParseError = e instanceof Error ? e.message : String(e);
    }
  }

  const httpOk = status >= 200 && status < 300;
  const ok = httpOk && finishReason === 'tool_calls' && args !== null;

  const warnings: string[] = [];
  if (httpOk && finishReason !== 'tool_calls') {
    warnings.push(
      finishReason === 'length'
        ? '⚠️ finish_reason=length —— 输出被截断，arguments 停在半个对象上（调大 max_tokens 或拆小输出）'
        : `⚠️ finish_reason=${finishReason} —— 不是 tool_calls`,
    );
  }

  return {
    ok,
    status,
    elapsedMs,
    finishReason,
    toolName,
    args,
    argsParseError,
    apiError,
    transportError: null,
    usage,
    rawText: text,
    raw: json,
    attempts: 1,
    warnings,
  };
}

/** 把 `strict` 关掉的那份 tools（`$def` 降级路径用） */
function withoutStrict(tools: unknown[]): unknown[] {
  return tools.map((t) => {
    const fn = (t as { function?: Record<string, unknown> }).function;
    if (!fn || !('strict' in fn)) return t;
    const { strict, ...rest } = fn as Record<string, unknown> & { strict?: unknown };
    void strict;
    return { ...(t as object), function: rest };
  });
}

function looksLikeSchemaError(r: LlmResult): boolean {
  if (r.status !== 400) return false;
  const s = (r.apiError ?? '') + r.rawText;
  return /schema|strict|\$def|\$ref|parameters/i.test(s);
}

export interface CallOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /** 是否允许"strict 报错 ⇒ 退回非 strict 重试一次"。默认允许（§3.2 降级行）。 */
  allowStrictDowngrade?: boolean;
  /** 每次拿到结果后的回调 —— 快照落盘挂在这里，**重试的两次都会各留一份证据** */
  onExchange?: (attempt: number, body: Record<string, unknown>, result: LlmResult) => void;
}

/**
 * 带重试的调用。**重试至多 1 次**（即最多 2 次请求）—— §3.2。
 * 重试触发条件：HTTP 非 2xx（且不是 schema 错）· `finish_reason` 不是 `tool_calls` · `arguments` 解析失败。
 */
export async function callTool(
  cfg: LlmConfig,
  body: Record<string, unknown>,
  o: CallOptions = {},
): Promise<LlmResult> {
  const allowDowngrade = o.allowStrictDowngrade ?? true;
  let attempts = 0;
  const warnings: string[] = [];
  let last: LlmResult = await fail(0, '', []);

  for (let round = 0; round < 2; round++) {
    attempts += 1;
    last = await sendChat(cfg, body, { baseUrl: o.baseUrl, timeoutMs: o.timeoutMs });
    o.onExchange?.(attempts, body, last);
    warnings.push(...last.warnings);
    if (last.ok) break;

    // strict / schema 报错 ⇒ 降级一次，然后重试
    if (round === 0 && allowDowngrade && looksLikeSchemaError(last)) {
      warnings.push('⚠️ strict / schema 报错 ⇒ 退回非 strict 重试一次（客户端校验仍是唯一防线）');
      body = { ...body, tools: withoutStrict(body.tools as unknown[]) };
      continue;
    }

    // 传输错误不重试（重试也大概率不通，且会拖时间）
    if (last.transportError) break;
  }

  return { ...last, attempts, warnings: [...new Set(warnings)] };
}

/** 一行摘要（打印用） */
export function summarizeResult(r: LlmResult): string {
  if (r.transportError) return `传输错误：${r.transportError}`;
  if (r.apiError) return `HTTP ${r.status} —— ${r.apiError}`;
  if (r.status < 200 || r.status >= 300) return `HTTP ${r.status}（无 error 字段）：${r.rawText.slice(0, 200)}`;
  const bits = [`HTTP ${r.status}`, `finish=${r.finishReason}`, `${r.elapsedMs}ms`];
  if (r.toolName) bits.push(`tool=${r.toolName}`);
  if (r.argsParseError) bits.push(`arguments 解析失败：${r.argsParseError}`);
  if (r.usage) {
    bits.push(`in=${r.usage.prompt_tokens ?? '?'} out=${r.usage.completion_tokens ?? '?'}`);
    if (r.usage.prompt_cache_hit_tokens !== undefined) {
      bits.push(`cache_hit=${r.usage.prompt_cache_hit_tokens}`);
    }
    if (r.usage.prompt_cache_miss_tokens !== undefined) {
      bits.push(`cache_miss=${r.usage.prompt_cache_miss_tokens}`);
    }
  }
  if (r.attempts > 1) bits.push(`重试 ${r.attempts - 1} 次`);
  return bits.join(' · ');
}

// ── 流式调用（2026-10-07 用户裁定：场景对话的回应要以流式呈现）────────
//
// ⚠️ **流式只服务"显示"，不是"第二份真相"**：`narration` 的增量文本边到边回调给 UI 打字；
//    而**权威结果**永远是流拼完后那份完整 `arguments`（照旧 `JSON.parse` ＋ `extractToolCall`
//    ＋上层校验）—— 流式文本显示到一半连接断了，权威路径照常失败、照常重试，语义不变。
// ⚠️ DeepSeek 的流式 `tool_calls` 是 **arguments 字符串的碎片**（JSON 还没成形）⇒
//    想边到边抽出 `narration` 的值，只能对**累积 buffer** 做增量扫描（下面的 `narrSlice`）。

/**
 * 从**累积的** arguments 文本里扫出 `narration` 的字符串值（前缀）。
 * 返回 `null` = 键还没出现 / 值还没开引号（调用方继续等）；`done=true` = 字符串已闭合。
 * ⚠️ 逐字符状态机：处理 `\"` `\\` `\/` `\n` `\t` `\r` `\uXXXX` 与"转义被切断"（等下一片）。
 * ⚠️ 只在**有且仅有**第一个 `"narration"` 键上工作 —— 工具 JSON 里它只有一个。
 */
function narrSlice(buf: string): { done: boolean; text: string } | null {
  const keyIdx = buf.indexOf('"narration"');
  if (keyIdx < 0) return null;
  let i = buf.indexOf(':', keyIdx + 11);
  if (i < 0) return null;
  i += 1;
  while (i < buf.length && /\s/.test(buf[i])) i += 1;
  if (i >= buf.length) return null;
  if (buf[i] !== '"') return null; // 值不是字符串（不该发生）⇒ 不回调，交给权威路径报错
  i += 1;
  let out = '';
  while (i < buf.length) {
    const ch = buf[i];
    if (ch === '\\') {
      const n = buf[i + 1];
      if (n === undefined) break; // 转义符是最后一片 ⇒ 等更多
      if (n === '"') { out += '"'; i += 2; continue; }
      if (n === '\\') { out += '\\'; i += 2; continue; }
      if (n === '/') { out += '/'; i += 2; continue; }
      if (n === 'n') { out += '\n'; i += 2; continue; }
      if (n === 't') { out += '\t'; i += 2; continue; }
      if (n === 'r') { out += '\r'; i += 2; continue; }
      if (n === 'b') { out += '\b'; i += 2; continue; }
      if (n === 'f') { out += '\f'; i += 2; continue; }
      if (n === 'u') {
        if (i + 6 > buf.length) break; // \uXXXX 被切断
        out += String.fromCharCode(parseInt(buf.slice(i + 2, i + 6), 16));
        i += 6;
        continue;
      }
      out += n;
      i += 2;
      continue;
    }
    if (ch === '"') return { done: true, text: out }; // 闭合
    out += ch;
    i += 1;
  }
  return { done: false, text: out }; // 还在流式中
}

export interface StreamCallOptions extends CallOptions {
  /**
   * `narration` 字段的增量文本（**已解码**）—— UI 拿它打字。
   * ⚠️ `reset=true` = 重试开始，此前收到的**全部作废**（UI 应清空重新打）。
   */
  onNarrDelta?: (chunk: string, reset: boolean) => void;
}

/**
 * 带重试的**流式**调用 —— 与 `callTool` 同一套触发条件与次数（至多 2 次），
 * 差别只在：`stream: true` ＋ 边到边把 `narration` 增量回调出去。
 * ⚠️ 结果判定与 `sendChat` 完全同源：把流拼出的 `arguments` 塞回标准响应形状，
 *    复用 `extractToolCall` —— **成功标准不因为流式而放松一个字**。
 */
export async function callToolStream(
  cfg: LlmConfig,
  body: Record<string, unknown>,
  o: StreamCallOptions = {},
): Promise<LlmResult> {
  const allowDowngrade = o.allowStrictDowngrade ?? true;
  let attempts = 0;
  const warnings: string[] = [];
  let last: LlmResult = await fail(0, '', []);

  for (let round = 0; round < 2; round++) {
    attempts += 1;
    o.onNarrDelta?.('', true); // 重试 ⇒ 之前流到一半的文字全部作废
    const sBody = { ...body, stream: true };
    const root = (o.baseUrl || cfg.betaBaseUrl).replace(/\/+$/, '');
    const t0 = Date.now();
    let status = 0;
    let errText = '';
    let transportError: string | null = null;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 120_000);
    let toolName: string | null = null;
    let toolId: string | null = null;
    let argsText = '';
    let finishReason: string | null = null;
    let usage: Record<string, number> | null = null;
    let emitted = 0;

    try {
      const res = await fetch(root + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
        body: JSON.stringify(sBody),
        signal: ac.signal,
      });
      status = res.status;
      if (!res.ok || !res.body) {
        errText = await res.text(); // 非 2xx 的错误体是普通 JSON，不是 SSE
      } else {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            let j: {
              choices?: Array<{
                delta?: { tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> };
                finish_reason?: string | null;
              }>;
              usage?: Record<string, number>;
            };
            try {
              j = JSON.parse(payload);
            } catch {
              continue; // 坏行跳过（SSE 允许注释行等）
            }
            const ch = j.choices?.[0];
            if (ch?.finish_reason) finishReason = ch.finish_reason;
            if (j.usage) usage = j.usage;
            const tc = ch?.delta?.tool_calls?.[0];
            if (!tc) continue;
            if (tc.id) toolId = tc.id;
            if (tc.function?.name) toolName = tc.function.name;
            if (tc.function?.arguments) {
              argsText += tc.function.arguments;
              const s = narrSlice(argsText);
              if (s && s.text.length > emitted) {
                o.onNarrDelta?.(s.text.slice(emitted), false);
                emitted = s.text.length;
              }
            }
          }
        }
      }
    } catch (e) {
      transportError = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer);
    }

    const elapsedMs = Date.now() - t0;

    if (transportError) {
      last = { ...fail(0, '', []), elapsedMs, transportError, attempts };
      warnings.push(...last.warnings);
      break; // 传输错误不重试（与 callTool 同一纪律）
    }
    if (status < 200 || status >= 300) {
      last = { ...fail(status, errText, []), elapsedMs, attempts };
      warnings.push(...last.warnings);
      // schema / strict 报错 ⇒ 降级一次再试（与 callTool 同款）
      if (round === 0 && allowDowngrade && looksLikeSchemaError(last)) {
        warnings.push('⚠️ strict / schema 报错 ⇒ 退回非 strict 重试一次（客户端校验仍是唯一防线）');
        body = { ...body, tools: withoutStrict(body.tools as unknown[]) };
        continue;
      }
      continue;
    }

    // 流拼完了 ⇒ 塞回标准响应形状，走**同一套**成功判定
    const std = {
      choices: [
        {
          message: {
            tool_calls: [{ id: toolId ?? 'call_stream', type: 'function', function: { name: toolName ?? '', arguments: argsText } }],
          },
          finish_reason: finishReason ?? (argsText !== '' ? 'tool_calls' : null),
        },
      ],
      usage,
    };
    const { finishReason: fr, toolName: tn, argsRaw, usage: us } = extractToolCall(std);
    let args: Record<string, unknown> | null = null;
    let argsParseError: string | null = null;
    if (argsRaw !== null) {
      try {
        const parsed: unknown = JSON.parse(argsRaw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        } else {
          argsParseError = `arguments 不是对象（实为 ${Array.isArray(parsed) ? 'array' : typeof parsed}）`;
        }
      } catch (e) {
        argsParseError = e instanceof Error ? e.message : String(e);
      }
    }
    const httpOk = status >= 200 && status < 300;
    const ok = httpOk && fr === 'tool_calls' && args !== null;
    if (httpOk && fr !== 'tool_calls') {
      warnings.push(
        fr === 'length'
          ? '⚠️ finish_reason=length —— 输出被截断，arguments 停在半个对象上（调大 max_tokens 或拆小输出）'
          : `⚠️ finish_reason=${fr} —— 不是 tool_calls`,
      );
    }
    last = {
      ok,
      status,
      elapsedMs,
      finishReason: fr,
      toolName: tn,
      args,
      argsParseError,
      apiError: null,
      transportError: null,
      usage: us,
      rawText: argsText,
      raw: std,
      attempts,
      warnings,
    };
    o.onExchange?.(attempts, sBody, last);
    warnings.push(...last.warnings);
    if (ok) break;
    // 失败 ⇒ 下一轮重试（round 1）；没有 schema 降级分支（能流到这一步说明 HTTP 是通的）
  }

  return { ...last, attempts, warnings: [...new Set(warnings)] };
}
