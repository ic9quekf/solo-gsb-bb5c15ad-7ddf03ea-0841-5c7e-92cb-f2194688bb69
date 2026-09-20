/**
 * 路由歧义分析核心逻辑。
 *
 * 路由模式由 `/` 分隔的段组成，段有三种：
 *  - static:  字面量，精确匹配一个段
 *  - param:   `:name`，匹配任意一个非空段
 *  - star:    `*`，匹配零个或多个段
 *
 * 冲突判定：两条规则存在共同匹配的具体路径即冲突。
 * 见证路径：把每条规则看作一个段级 NFA，在二者的积自动机上做 0-1 BFS，
 *           星号“跳过”是 0 代价 epsilon 边，消费一个段是 1 代价边，
 *           得到的即段数最短的具体见证路径。
 */

export type Segment =
  | { kind: 'static'; value: string }
  | { kind: 'param'; name: string }
  | { kind: 'star' };

export interface RuleInput {
  pattern: string;
  priority: number;
  enabled: boolean;
}

export interface AnalyzedRule {
  id: string; // R1、R2……按输入顺序
  index: number;
  pattern: string; // 规范化后的模式（保证以 / 开头）
  priority: number;
  enabled: boolean;
  segments: Segment[];
  error: string | null;
}

export interface ConflictPair {
  a: string; // 规则 id
  b: string;
  witness: string; // 最短共同命中的具体路径
  winner: string | null; // 所有启用规则中模拟最终命中的规则 id
  winnerInPair: boolean; // 胜出者是否就是冲突对之一
}

export interface AnalysisResult {
  rules: AnalyzedRule[];
  conflicts: ConflictPair[];
}

export interface MatchResult {
  path: string;
  matches: string[]; // 所有命中的启用规则 id，按胜出顺序排列
  winner: string | null;
}

/** 变更影响分类：命中迁移 / 新增命中 / 变为未命中 / 无变化。 */
export type ImpactCategory = 'migrated' | 'added' | 'removed' | 'unchanged';

/** 胜出规则的对外标识；是否“同一规则”只看规范化模式与优先级。 */
export interface WinnerRef {
  id: string; // 规则 id，仅用于展示
  pattern: string; // 规范化后的模式
  priority: number;
}

export interface SampleImpact {
  line: number; // 样本在输入中的行号（1 起）
  count: number; // 请求次数
  path: string; // 规范化后的请求路径
  baseline: WinnerRef | null; // 基线规则下的胜出规则
  candidate: WinnerRef | null; // 候选规则下的胜出规则
  category: ImpactCategory;
}

export interface InvalidSample {
  line: number;
  raw: string;
  error: string;
}

export interface CategorySummary {
  samples: number; // 样本条数
  requests: number; // 请求次数合计
}

export interface ImpactResult {
  baselineRules: AnalyzedRule[];
  candidateRules: AnalyzedRule[];
  samples: SampleImpact[];
  invalidSamples: InvalidSample[];
  summary: Record<ImpactCategory, CategorySummary> & { total: CategorySummary };
}

/** 复现包中一条入选路径覆盖的冲突对。 */
export interface ReproConflict {
  a: string; // 规则 id
  b: string;
}

/** 复现包中入选的一条见证路径。 */
export interface ReproPath {
  path: string; // 具体请求路径
  hits: string[]; // 实际命中的所选规则 id，按胜出顺序排列
  covers: ReproConflict[]; // 该路径实际覆盖的冲突对
}

/** 最小复现包：覆盖所选规则全部冲突对的最少见证路径集合。 */
export interface ReproResult {
  rules: AnalyzedRule[]; // 所选规则（按输入顺序）
  conflicts: ConflictPair[]; // 所选规则之间的全部冲突对
  candidatePaths: number; // 去重后的候选见证路径数
  totalConflicts: number; // 冲突对总数（= conflicts.length）
  paths: ReproPath[]; // 入选的最少路径集合（按路径字典序）
}

// ---------- 优先级修复 ----------

/** 一条期望推导出的规则间差值约束（边：from 的新优先级 + weight ≤ to 的新优先级）。 */
export interface RepairConstraint {
  fromId: string;
  toId: string;
  weight: 0 | 1; // 0：保持不低于即可；1：必须严格超过
}

/** 一条合法的修复期望及其验证结果。 */
export interface RepairExpectation {
  line: number; // 在输入中的行号（1 起）
  raw: string;
  path: string; // 规范化后的请求路径
  targetId: string; // 期望胜出规则 id
  matches: string[]; // 该路径命中的启用规则 id（按调整前胜出顺序）
  currentWinnerId: string | null; // 调整前胜出规则
  afterWinnerId: string | null; // 调整后胜出规则（不可行时为 null）
  verified: boolean; // 调整后实际胜出者是否等于期望
  constraints: RepairConstraint[]; // 该期望推导出的差值约束（按对手规则输入顺序）
}

/** 逐行解析失败的期望（非法路径、未命中、目标规则不匹配等）。 */
export interface RepairInvalidLine {
  line: number;
  raw: string;
  error: string;
}

/** 单条规则调整前后的优先级。 */
export interface RepairRuleChange {
  id: string;
  index: number;
  pattern: string;
  before: number;
  after: number;
  delta: number;
}

/** 正权环上的一条边及其由哪些期望行推导而来。 */
export interface RepairCycleEdge {
  fromId: string;
  toId: string;
  weight: number;
  expectationLines: number[]; // 产生该约束的输入行号
}

export interface RepairResult {
  feasible: boolean; // 是否存在只提高优先级即可满足全部期望的方案
  expectations: RepairExpectation[];
  invalidLines: RepairInvalidLine[];
  rules: RepairRuleChange[]; // 全部规则调整前后的优先级（按输入顺序）
  conflictCycle: RepairCycleEdge[] | null; // 不可行时的一组闭环冲突期望
}

const PARAM_PLACEHOLDER = 'x'; // 见证路径中为参数段生成的具体值
const MAX_SAMPLE_COUNT = 1_000_000_000; // 单条样本允许的最大请求次数

/** 把模式字符串解析为段序列；非法时抛出带说明的错误。 */
export function parsePattern(raw: string): Segment[] {
  const pattern = raw.trim();
  if (!pattern) throw new Error('模式为空');
  const parts = pattern.split('/').filter((p) => p.length > 0);
  return parts.map((part) => {
    if (part === '*') return { kind: 'star' };
    if (part.includes('*')) {
      throw new Error(`段 "${part}" 非法：* 必须单独成段`);
    }
    if (part.startsWith(':')) {
      const name = part.slice(1);
      if (!name) throw new Error('参数段 ":" 缺少名称');
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
        throw new Error(`参数名 "${name}" 非法`);
      }
      return { kind: 'param', name };
    }
    return { kind: 'static', value: part };
  });
}

/** 规范化模式：保证以 / 开头，去掉多余斜杠。 */
export function normalizePattern(raw: string): string {
  const parts = raw.trim().split('/').filter((p) => p.length > 0);
  return '/' + parts.join('/');
}

/** 把具体路径切分为段。 */
export function splitPath(path: string): string[] {
  return path.trim().split('/').filter((p) => p.length > 0);
}

/** 判断规则段序列是否匹配给定具体路径段（* 匹配零或多段）。 */
export function matchSegments(segments: Segment[], pathSegs: string[]): boolean {
  const n = segments.length;
  const m = pathSegs.length;
  // dp[i][j]：segments[i:] 是否匹配 pathSegs[j:]
  const dp: boolean[][] = Array.from({ length: n + 1 }, () =>
    new Array<boolean>(m + 1).fill(false),
  );
  dp[n][m] = true;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m; j >= 0; j--) {
      const seg = segments[i];
      if (seg.kind === 'star') {
        // 匹配零段，或消费一段后仍在星号状态
        dp[i][j] = dp[i + 1][j] || (j < m && dp[i][j + 1]);
      } else if (j < m) {
        const one =
          seg.kind === 'static' ? pathSegs[j] === seg.value : true; // param 匹配任意单段
        dp[i][j] = one && dp[i + 1][j + 1];
      }
    }
  }
  return dp[0][0];
}

/**
 * 计算两条规则段序列的最短共同见证路径（段数组），不存在时返回 null。
 * 在积自动机 (i, j) 上做 0-1 BFS：星号跳过为 0 代价边，消费一段为 1 代价边。
 */
export function intersectionWitness(a: Segment[], b: Segment[]): string[] | null {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const idx = (i: number, j: number) => i * width + j;
  const start = idx(0, 0);
  const target = idx(n, m);

  const dist = new Array<number>((n + 1) * (m + 1)).fill(Infinity);
  const prev = new Array<number>(dist.length).fill(-1);
  const prevSeg = new Array<string>(dist.length).fill('');
  const deque: number[] = [];
  dist[start] = 0;
  deque.push(start);

  const relax = (from: number, to: number, cost: number, seg: string | null) => {
    if (dist[from] + cost < dist[to]) {
      dist[to] = dist[from] + cost;
      prev[to] = from;
      prevSeg[to] = seg ?? '';
      if (cost === 0) deque.unshift(to);
      else deque.push(to);
    }
  };

  while (deque.length > 0) {
    const cur = deque.shift()!;
    const i = Math.floor(cur / width);
    const j = cur % width;
    const sa = i < n ? a[i] : null;
    const sb = j < m ? b[j] : null;

    // 0 代价边：星号匹配零段
    if (sa && sa.kind === 'star') relax(cur, idx(i + 1, j), 0, null);
    if (sb && sb.kind === 'star') relax(cur, idx(i, j + 1), 0, null);

    // 1 代价边：双方同时消费同一个具体段（一方已结束时无法再共同消费）
    if (sa && sb) {
      if (sa.kind === 'static' && sb.kind === 'static') {
        if (sa.value === sb.value) relax(cur, idx(i + 1, j + 1), 1, sa.value);
      } else if (sa.kind === 'static') {
        // b 为 param 或 star，具体段取 a 的字面量
        relax(cur, idx(i + 1, sb.kind === 'star' ? j : j + 1), 1, sa.value);
      } else if (sb.kind === 'static') {
        relax(cur, idx(sa.kind === 'star' ? i : i + 1, j + 1), 1, sb.value);
      } else {
        // param/star 组合：用占位具体段
        const ni = sa.kind === 'star' ? i : i + 1;
        const nj = sb.kind === 'star' ? j : j + 1;
        relax(cur, idx(ni, nj), 1, PARAM_PLACEHOLDER);
      }
    }
  }

  if (!Number.isFinite(dist[target])) return null;

  const segs: string[] = [];
  let cur = target;
  while (cur !== start) {
    const p = prev[cur];
    if (p < 0) return null;
    if (dist[cur] - dist[p] === 1) segs.unshift(prevSeg[cur]);
    cur = p;
  }
  return segs;
}

/** 在启用且合法的规则中，为给定路径段找出最终命中的规则（优先级大者先，平手按输入顺序）。 */
export function findWinner(
  rules: AnalyzedRule[],
  pathSegs: string[],
): AnalyzedRule | null {
  let best: AnalyzedRule | null = null;
  for (const rule of rules) {
    if (!rule.enabled || rule.error) continue;
    if (!matchSegments(rule.segments, pathSegs)) continue;
    if (
      !best ||
      rule.priority > best.priority ||
      (rule.priority === best.priority && rule.index < best.index)
    ) {
      best = rule;
    }
  }
  return best;
}

/** 完整分析：解析规则、两两求交找冲突、为每个冲突模拟最终命中。 */
export function analyze(inputs: RuleInput[]): AnalysisResult {
  const rules: AnalyzedRule[] = inputs.map((input, index) => {
    const base = {
      id: `R${index + 1}`,
      index,
      priority: Number.isFinite(input.priority) ? Math.trunc(input.priority) : 0,
      enabled: input.enabled !== false,
      pattern: '',
      segments: [] as Segment[],
      error: null as string | null,
    };
    try {
      base.pattern = normalizePattern(String(input.pattern ?? ''));
      base.segments = parsePattern(String(input.pattern ?? ''));
    } catch (err) {
      base.pattern = String(input.pattern ?? '').trim() || '(空)';
      base.error = err instanceof Error ? err.message : String(err);
    }
    return base;
  });

  const usable = rules.filter((r) => r.enabled && !r.error);
  const conflicts: ConflictPair[] = [];
  for (let x = 0; x < usable.length; x++) {
    for (let y = x + 1; y < usable.length; y++) {
      const ra = usable[x];
      const rb = usable[y];
      const witnessSegs = intersectionWitness(ra.segments, rb.segments);
      if (!witnessSegs) continue;
      const winner = findWinner(rules, witnessSegs);
      conflicts.push({
        a: ra.id,
        b: rb.id,
        witness: '/' + witnessSegs.join('/'),
        winner: winner ? winner.id : null,
        winnerInPair: winner !== null && (winner.id === ra.id || winner.id === rb.id),
      });
    }
  }
  return { rules, conflicts };
}

/** 模拟单条具体路径的最终命中。 */
export function simulate(inputs: RuleInput[], path: string): MatchResult {
  const { rules } = analyze(inputs);
  const pathSegs = splitPath(path);
  const hits = rules
    .filter((r) => r.enabled && !r.error && matchSegments(r.segments, pathSegs))
    .sort((x, y) => y.priority - x.priority || x.index - y.index);
  return {
    path: '/' + pathSegs.join('/'),
    matches: hits.map((r) => r.id),
    winner: hits.length > 0 ? hits[0].id : null,
  };
}

/**
 * 解析一行请求样本：格式为 “次数 路径”，次数省略时为 1。
 * 空行与 # 注释返回 null（跳过）；非法行返回 { error }。
 */
export function parseSampleLine(
  line: string,
): { count: number; path: string } | { error: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const tokens = trimmed.split(/\s+/);
  let count = 1;
  let pathToken: string;
  if (/^-?\d+$/.test(tokens[0])) {
    // 首个 token 是整数 → 视为次数
    const n = Number(tokens[0]);
    if (!Number.isSafeInteger(n) || n < 1) {
      return { error: `次数 "${tokens[0]}" 必须为正整数` };
    }
    if (n > MAX_SAMPLE_COUNT) {
      return { error: `次数 "${tokens[0]}" 超出上限 ${MAX_SAMPLE_COUNT}` };
    }
    if (tokens.length < 2) return { error: '缺少请求路径' };
    if (tokens.length > 2) return { error: '路径中不能包含空白字符' };
    count = n;
    pathToken = tokens[1];
  } else {
    if (tokens.length > 1) return { error: '路径中不能包含空白字符' };
    pathToken = tokens[0];
  }
  if (!pathToken.startsWith('/')) {
    return { error: `路径 "${pathToken}" 必须以 / 开头` };
  }
  return { count, path: pathToken };
}

function winnerRef(rule: AnalyzedRule | null): WinnerRef | null {
  return rule ? { id: rule.id, pattern: rule.pattern, priority: rule.priority } : null;
}

/** 规范化模式与优先级均相同才视为同一规则。 */
function sameWinner(a: WinnerRef | null, b: WinnerRef | null): boolean {
  if (a === null || b === null) return a === b;
  return a.pattern === b.pattern && a.priority === b.priority;
}

/**
 * 变更影响分析：对每条合法样本，分别用基线与候选规则模拟最终命中，
 * 按“命中迁移、新增命中、变为未命中、无变化”分类并汇总请求次数。
 * 非法样本逐行记录错误，不参与统计。
 */
export function impact(
  baselineInputs: RuleInput[],
  candidateInputs: RuleInput[],
  sampleLines: string[],
): ImpactResult {
  const baseline = analyze(baselineInputs);
  const candidate = analyze(candidateInputs);
  const samples: SampleImpact[] = [];
  const invalidSamples: InvalidSample[] = [];
  const summary: ImpactResult['summary'] = {
    migrated: { samples: 0, requests: 0 },
    added: { samples: 0, requests: 0 },
    removed: { samples: 0, requests: 0 },
    unchanged: { samples: 0, requests: 0 },
    total: { samples: 0, requests: 0 },
  };

  sampleLines.forEach((line, i) => {
    const parsed = parseSampleLine(line);
    if (parsed === null) return; // 空行或注释
    if ('error' in parsed) {
      invalidSamples.push({ line: i + 1, raw: line.trim(), error: parsed.error });
      return;
    }
    const pathSegs = splitPath(parsed.path);
    const bw = winnerRef(findWinner(baseline.rules, pathSegs));
    const cw = winnerRef(findWinner(candidate.rules, pathSegs));
    let category: ImpactCategory;
    if (bw === null && cw === null) category = 'unchanged';
    else if (bw === null) category = 'added';
    else if (cw === null) category = 'removed';
    else category = sameWinner(bw, cw) ? 'unchanged' : 'migrated';
    samples.push({
      line: i + 1,
      count: parsed.count,
      path: '/' + pathSegs.join('/'),
      baseline: bw,
      candidate: cw,
      category,
    });
    summary[category].samples += 1;
    summary[category].requests += parsed.count;
    summary.total.samples += 1;
    summary.total.requests += parsed.count;
  });

  return {
    baselineRules: baseline.rules,
    candidateRules: candidate.rules,
    samples,
    invalidSamples,
    summary,
  };
}

/** bigint 位掩码的 popcount。 */
function popcountBig(x: bigint): number {
  let c = 0;
  let v = x;
  while (v !== 0n) {
    v &= v - 1n;
    c++;
  }
  return c;
}

/**
 * 确定性分支限界求最小集合覆盖（精确算法，非贪心）。
 *
 * covers[i] 为候选 i 覆盖的冲突对下标列表；目标是选出覆盖全部 universeSize
 * 个冲突对的最少候选集合。并列时依次按以下规则决胜，保证结果唯一确定：
 *  1. 候选路径总段数少者优先；
 *  2. 集合内路径字符串排序后，字典序小者优先。
 *
 * 分支策略：每次选择“可用覆盖者最少”的未覆盖冲突对进行分支；第 j 个分支
 * 禁止再选前 j-1 个覆盖者，保证每个解恰好生成一次。剪枝下界为
 * 已选数 + ⌈剩余冲突对数 / 单候选最大剩余覆盖数⌉。
 *
 * 返回入选候选的下标，按路径字典序排列。
 */
export function selectMinCover(
  covers: number[][],
  segCounts: number[],
  paths: string[],
  universeSize: number,
): number[] {
  const n = covers.length;
  if (universeSize === 0 || n === 0) return [];

  // 候选按路径字典序排序，保证分支顺序确定
  const order = Array.from({ length: n }, (_, i) => i).sort((x, y) =>
    paths[x] < paths[y] ? -1 : paths[x] > paths[y] ? 1 : x - y,
  );
  const mask = order.map((orig) => {
    let m = 0n;
    for (const bit of covers[orig]) m |= 1n << BigInt(bit);
    return m;
  });
  const segs = order.map((orig) => segCounts[orig]);
  const keys = order.map((orig) => paths[orig]);
  const full = (1n << BigInt(universeSize)) - 1n;

  // coverers[b]：覆盖冲突对 b 的候选（按路径字典序）
  const coverers: number[][] = Array.from({ length: universeSize }, () => []);
  for (let si = 0; si < n; si++) {
    let m = mask[si];
    let b = 0;
    while (m !== 0n) {
      if (m & 1n) coverers[b].push(si);
      m >>= 1n;
      b++;
    }
  }

  interface Solution {
    count: number;
    segs: number;
    keys: string[]; // 集合内路径按字典序排列
  }
  let best: Solution | null = null;
  let bestSel: number[] = [];

  const avail = new Array<boolean>(n).fill(true);
  const chosen: number[] = [];
  let chosenSegs = 0;
  let covered = 0n;

  const isBetter = (sel: number[], totalSegs: number): boolean => {
    if (!best) return true;
    if (sel.length !== best.count) return sel.length < best.count;
    if (totalSegs !== best.segs) return totalSegs < best.segs;
    for (let k = 0; k < sel.length; k++) {
      const a = keys[sel[k]];
      const b = best.keys[k];
      if (a !== b) return a < b;
    }
    return false;
  };

  const search = (): void => {
    if (covered === full) {
      const sel = [...chosen].sort((x, y) => x - y); // 排序空间下标升序 = 路径字典序
      if (isBetter(sel, chosenSegs)) {
        best = { count: sel.length, segs: chosenSegs, keys: sel.map((si) => keys[si]) };
        bestSel = sel;
      }
      return;
    }
    const remaining = full & ~covered;
    // 找“可用覆盖者最少”的未覆盖冲突对作为分支目标，并统计下界所需数据
    let remainingCount = 0;
    let maxCover = 0;
    let targetCoverers: number[] | null = null;
    for (let b = 0; b < universeSize; b++) {
      if (!((remaining >> BigInt(b)) & 1n)) continue;
      remainingCount++;
      const cov = coverers[b].filter((si) => avail[si]);
      if (cov.length === 0) return; // 有冲突对无法覆盖（理论上不会发生）
      if (targetCoverers === null || cov.length < targetCoverers.length) {
        targetCoverers = cov;
      }
    }
    for (let si = 0; si < n; si++) {
      if (!avail[si]) continue;
      const c = popcountBig(mask[si] & remaining);
      if (c > maxCover) maxCover = c;
    }
    if (maxCover === 0 || targetCoverers === null) return;
    const lowerBound = chosen.length + Math.ceil(remainingCount / maxCover);
    if (best !== null) {
      const b = best as Solution;
      if (lowerBound > b.count) return;
      // 路径数已不可能更少，且段数只增不减，已超过最优段数时剪枝
      if (lowerBound === b.count && chosenSegs > b.segs) return;
    }
    // 分支：按字典序依次尝试 target 的覆盖者；第 j 个分支禁止再选
    // targetCoverers[0..j-1]，保证每个解恰好生成一次
    const banned: number[] = [];
    for (const si of targetCoverers) {
      chosen.push(si);
      chosenSegs += segs[si];
      const saved = covered;
      covered |= mask[si];
      avail[si] = false;
      search();
      covered = saved;
      chosen.pop();
      chosenSegs -= segs[si];
      banned.push(si); // avail[si] 保持 false，对后续兄弟分支生效
    }
    for (const si of banned) avail[si] = true;
  };

  search();
  return bestSel.map((si) => order[si]);
}

export const MIN_REPRO_RULES = 2;
export const MAX_REPRO_RULES = 20;

/**
 * 最小复现包：从所选规则（2～20 条启用且合法）已有的去重冲突见证路径出发，
 * 重新计算每条路径实际命中的规则与覆盖的冲突对，用确定性分支限界选出覆盖
 * 全部冲突对的最少路径集合。选择非法时抛出 Error。
 */
export function buildRepro(inputs: RuleInput[], selectedIds: string[]): ReproResult {
  const { rules } = analyze(inputs);
  const byId = new Map(rules.map((r) => [r.id, r]));
  if (
    !Array.isArray(selectedIds) ||
    selectedIds.length < MIN_REPRO_RULES ||
    selectedIds.length > MAX_REPRO_RULES
  ) {
    throw new Error(`需选择 ${MIN_REPRO_RULES}～${MAX_REPRO_RULES} 条规则`);
  }
  const seen = new Set<string>();
  const selected: AnalyzedRule[] = [];
  for (const id of selectedIds) {
    const rule = byId.get(id);
    if (!rule) throw new Error(`规则 ${id} 不存在`);
    if (seen.has(id)) throw new Error(`规则 ${id} 被重复选择`);
    seen.add(id);
    if (!rule.enabled) throw new Error(`规则 ${id} 已禁用，不能纳入复现包`);
    if (rule.error) throw new Error(`规则 ${id} 非法：${rule.error}`);
    selected.push(rule);
  }
  // 输出与后续冲突对顺序按规则输入顺序确定，与选择顺序无关
  selected.sort((x, y) => x.index - y.index);

  // 所选规则之间的全部冲突对；胜出模拟同样限制在所选集合内，保证复现包自包含
  const conflicts: ConflictPair[] = [];
  for (let x = 0; x < selected.length; x++) {
    for (let y = x + 1; y < selected.length; y++) {
      const ra = selected[x];
      const rb = selected[y];
      const witnessSegs = intersectionWitness(ra.segments, rb.segments);
      if (!witnessSegs) continue;
      const winner = findWinner(selected, witnessSegs);
      conflicts.push({
        a: ra.id,
        b: rb.id,
        witness: '/' + witnessSegs.join('/'),
        winner: winner ? winner.id : null,
        winnerInPair: winner !== null && (winner.id === ra.id || winner.id === rb.id),
      });
    }
  }

  // 候选：已有的去重冲突见证路径
  const candidates = [...new Set(conflicts.map((c) => c.witness))];

  // 重新计算每条候选路径实际命中的所选规则与覆盖的冲突对
  const conflictIndex: Map<string, number> = new Map(
    conflicts.map((c, i) => [`${c.a}|${c.b}`, i] as [string, number]),
  );
  const keyOf = (idX: string, idY: string): string => {
    const rx = byId.get(idX)!;
    const ry = byId.get(idY)!;
    return rx.index < ry.index ? `${idX}|${idY}` : `${idY}|${idX}`;
  };
  const hitsPerPath: string[][] = [];
  const covers: number[][] = [];
  const segCounts: number[] = [];
  for (const path of candidates) {
    const pathSegs = splitPath(path);
    segCounts.push(pathSegs.length);
    const hits = selected
      .filter((r) => matchSegments(r.segments, pathSegs))
      .sort((x, y) => y.priority - x.priority || x.index - y.index)
      .map((r) => r.id);
    hitsPerPath.push(hits);
    const cov = new Set<number>();
    for (let i = 0; i < hits.length; i++) {
      for (let j = i + 1; j < hits.length; j++) {
        // 同时命中同一条具体路径的两条规则必然互为冲突对
        const idx = conflictIndex.get(keyOf(hits[i], hits[j]));
        if (idx !== undefined) cov.add(idx);
      }
    }
    covers.push([...cov].sort((x, y) => x - y));
  }

  const picked = selectMinCover(covers, segCounts, candidates, conflicts.length);
  const paths: ReproPath[] = picked.map((i) => ({
    path: candidates[i],
    hits: hitsPerPath[i],
    covers: covers[i].map((ci) => ({ a: conflicts[ci].a, b: conflicts[ci].b })),
  }));

  return {
    rules: selected,
    conflicts,
    candidatePaths: candidates.length,
    totalConflicts: conflicts.length,
    paths,
  };
}

const MAX_REPAIR_LINES = 5000;
const MAX_REPAIR_LINE_LEN = 500;

/**
 * 解析一行修复期望：格式 “请求路径 => 期望胜出规则ID”，=> 两侧可留空白。
 * 空行与 # 注释返回 null；格式非法返回 { error }。路径与规则本身的合法性由修复流程逐行校验。
 */
export function parseRepairLine(
  line: string,
): { path: string; targetId: string } | { error: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const parts = trimmed.split('=>');
  if (parts.length !== 2) {
    return { error: '格式应为 “请求路径 => 期望胜出规则ID”' };
  }
  const pathToken = parts[0].trim();
  const targetId = parts[1].trim();
  if (/\s/.test(pathToken)) {
    return { error: '路径中不能包含空白字符' };
  }
  if (!pathToken.startsWith('/')) {
    return { error: `路径 "${pathToken || '(空)'}" 必须以 / 开头` };
  }
  if (/\s/.test(targetId)) {
    return { error: '规则 ID 中不能包含空白字符' };
  }
  if (!/^R\d+$/.test(targetId)) {
    return { error: `规则 ID "${targetId || '(空)'}" 非法，应为 R1、R2 形式` };
  }
  return { path: pathToken, targetId };
}

interface RepairEdge {
  from: number;
  to: number;
  weight: 0 | 1;
  lines: number[]; // 产生该边的期望输入行号
}

/** Tarjan 强连通分量（迭代实现，避免大输入递归过深）；返回每个规则的分量号与分量列表。 */
function tarjanSCC(
  n: number,
  adjacency: number[][],
): { compOf: number[]; components: number[][] } {
  const indexOf = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const onStack = new Array<boolean>(n).fill(false);
  const stack: number[] = [];
  let nextIndex = 0;
  const compOf = new Array<number>(n).fill(-1);
  const components: number[][] = [];

  for (let s = 0; s < n; s++) {
    if (indexOf[s] !== -1) continue;
    // 迭代 DFS：帧 [节点, 下一条待访问邻边下标]
    const frames: Array<[number, number]> = [[s, 0]];
    indexOf[s] = low[s] = nextIndex++;
    stack.push(s);
    onStack[s] = true;
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const v = frame[0];
      if (frame[1] < adjacency[v].length) {
        const w = adjacency[v][frame[1]++];
        if (indexOf[w] === -1) {
          indexOf[w] = low[w] = nextIndex++;
          stack.push(w);
          onStack[w] = true;
          frames.push([w, 0]);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], indexOf[w]);
        }
      } else {
        if (low[v] === indexOf[v]) {
          const comp: number[] = [];
          let cid: number;
          do {
            cid = stack.pop()!;
            onStack[cid] = false;
            compOf[cid] = components.length;
            comp.push(cid);
          } while (cid !== v);
          comp.sort((x, y) => x - y);
          components.push(comp);
        }
        frames.pop();
        if (frames.length > 0) {
          const parent = frames[frames.length - 1][0];
          low[parent] = Math.min(low[parent], low[v]);
        }
      }
    }
  }
  return { compOf, components };
}

/**
 * 从含正权环的 SCC 中确定性地找出一条由 d=1 边构成的闭环。
 * 从该分量内编号最小的 d=1 边出发（行号最小者优先），沿分量内邻边 BFS 回到其起点。
 */
function extractCycle(
  component: number[],
  outAdj: Map<number, RepairEdge[]>,
  n: number,
): RepairEdge[] {
  const inComp = new Set(component);
  const firstEdges: RepairEdge[] = [];
  for (const v of component) {
    for (const e of outAdj.get(v) ?? []) {
      if (e.weight === 1 && inComp.has(e.to)) firstEdges.push(e);
    }
  }
  firstEdges.sort((a, b) => a.from - b.from || a.to - b.to || a.lines[0] - b.lines[0]);
  const start = firstEdges[0];

  // BFS：start.to → start.from，只走分量内的边；记录前驱边
  const prevEdge = new Array<RepairEdge | null>(n).fill(null);
  const seen = new Array<boolean>(n).fill(false);
  seen[start.to] = true;
  const queue: number[] = [start.to];
  let head = 0;
  while (head < queue.length) {
    const v = queue[head++];
    const neighbors = [...(outAdj.get(v) ?? [])].sort(
      (a, b) => a.to - b.to || a.lines[0] - b.lines[0],
    );
    for (const e of neighbors) {
      if (!inComp.has(e.to) || seen[e.to]) continue;
      seen[e.to] = true;
      prevEdge[e.to] = e;
      queue.push(e.to);
    }
  }
  const cycle: RepairEdge[] = [start];
  let cur = start.from;
  while (cur !== start.to) {
    const e = prevEdge[cur];
    if (!e) break; // 同 SCC 内理论上必然可达
    cycle.unshift(e);
    cur = e.from;
  }
  return cycle;
}

/**
 * 优先级修复：逐行读取“请求路径 => 期望胜出规则ID”，按当前匹配与
 * “优先级高者先、平手按输入顺序”推导规则间的 0/1 差值约束，在只允许提高
 * 整数优先级的前提下，给出逐项增幅最小的确定性方案。
 *
 * 约束模型：对期望目标 t 与其路径上的每个对手 r，新优先级 P' 满足
 *   P'[t] ≥ P'[r] + d，d 为 0（t 当前已胜 r）或 1（r 当前胜 t）；
 * 另有 P'[v] ≥ P[v]（只许提高）。用 Tarjan 求强连通分量：分量内存在 d=1
 * 边即正权环（互相要求严格超过，闭环冲突）；零权环在分量内合并为等值变量，
 * 缩点 DAG 上取最长路径即得逐点最小整数解。
 */
export function repairPriorities(
  inputs: RuleInput[],
  lines: string[],
): RepairResult {
  const { rules } = analyze(inputs);
  const n = rules.length;
  const expectations: RepairExpectation[] = [];
  const invalidLines: RepairInvalidLine[] = [];
  // 同一条 (from,to) 边合并：取最大权重，行号去重
  const edgeMap = new Map<string, RepairEdge>();

  const addEdge = (from: number, to: number, weight: 0 | 1, lineNo: number) => {
    const key = `${from}|${to}`;
    const existing = edgeMap.get(key);
    if (existing) {
      if (weight > existing.weight) existing.weight = weight;
      if (!existing.lines.includes(lineNo)) {
        existing.lines.push(lineNo);
        existing.lines.sort((a, b) => a - b);
      }
    } else {
      edgeMap.set(key, { from, to, weight, lines: [lineNo] });
    }
  };

  lines.forEach((rawLine, i) => {
    const lineNo = i + 1;
    const trimmed = rawLine.trim();
    const parsed = parseRepairLine(rawLine);
    if (parsed === null) return; // 空行或注释
    if ('error' in parsed) {
      invalidLines.push({ line: lineNo, raw: trimmed, error: parsed.error });
      return;
    }
    const targetRule = rules.find((r) => r.id === parsed.targetId);
    if (!targetRule) {
      invalidLines.push({
        line: lineNo,
        raw: trimmed,
        error: `规则 ${parsed.targetId} 不存在`,
      });
      return;
    }
    if (targetRule.error) {
      invalidLines.push({
        line: lineNo,
        raw: trimmed,
        error: `规则 ${parsed.targetId} 非法：${targetRule.error}`,
      });
      return;
    }
    if (!targetRule.enabled) {
      invalidLines.push({
        line: lineNo,
        raw: trimmed,
        error: `规则 ${parsed.targetId} 已禁用，不能作为期望胜出规则`,
      });
      return;
    }
    const pathSegs = splitPath(parsed.path);
    const normPath = '/' + pathSegs.join('/');
    const hits = rules
      .filter((r) => r.enabled && !r.error && matchSegments(r.segments, pathSegs))
      .sort((x, y) => y.priority - x.priority || x.index - y.index);
    if (hits.length === 0) {
      invalidLines.push({ line: lineNo, raw: trimmed, error: `路径 ${normPath} 未命中任何规则` });
      return;
    }
    if (!hits.some((r) => r.id === parsed.targetId)) {
      invalidLines.push({
        line: lineNo,
        raw: trimmed,
        error: `规则 ${parsed.targetId} 不匹配路径 ${normPath}`,
      });
      return;
    }
    const t = targetRule.index;
    const constraints: RepairConstraint[] = [];
    for (const r of hits) {
      if (r.index === t) continue;
      // t 当前已胜 r（更高优先级，或平手且输入顺序更靠前）→ d=0；否则 d=1
      const winsNow =
        targetRule.priority > r.priority ||
        (targetRule.priority === r.priority && targetRule.index < r.index);
      const d: 0 | 1 = winsNow ? 0 : 1;
      addEdge(r.index, t, d, lineNo); // P'[t] ≥ P'[r] + d
      constraints.push({ fromId: r.id, toId: targetRule.id, weight: d });
    }
    expectations.push({
      line: lineNo,
      raw: trimmed,
      path: normPath,
      targetId: targetRule.id,
      matches: hits.map((r) => r.id),
      currentWinnerId: hits[0].id,
      afterWinnerId: null,
      verified: false,
      constraints,
    });
  });

  // 建图（只包含约束边；P'[v] ≥ P[v] 由初值 P[v] 统一承担）
  const outAdj = new Map<number, RepairEdge[]>();
  const adjacency: number[][] = Array.from({ length: n }, () => []);
  for (const e of edgeMap.values()) {
    const list = outAdj.get(e.from);
    if (list) list.push(e);
    else outAdj.set(e.from, [e]);
    adjacency[e.from].push(e.to);
  }

  const { compOf, components } = tarjanSCC(n, adjacency);

  // 正权环：分量内存在 d=1 边
  let conflictComp: number[] | null = null;
  for (const comp of components) {
    if (comp.length < 2) continue;
    const inComp = new Set(comp);
    let positive = false;
    for (const v of comp) {
      for (const e of outAdj.get(v) ?? []) {
        if (e.weight === 1 && inComp.has(e.to)) {
          positive = true;
          break;
        }
      }
      if (positive) break;
    }
    if (positive) {
      conflictComp = comp;
      break;
    }
  }

  const baseRules: RepairRuleChange[] = rules.map((r) => ({
    id: r.id,
    index: r.index,
    pattern: r.pattern,
    before: r.priority,
    after: r.priority,
    delta: 0,
  }));

  let conflictCycle: RepairCycleEdge[] | null = null;
  if (conflictComp) {
    const cycle = extractCycle(conflictComp, outAdj, n);
    conflictCycle = cycle.map((e) => ({
      fromId: rules[e.from].id,
      toId: rules[e.to].id,
      weight: e.weight,
      expectationLines: [...e.lines],
    }));
    return {
      feasible: false,
      expectations,
      invalidLines,
      rules: baseRules,
      conflictCycle,
    };
  }

  // 缩点 DAG 上最长路径：分量初值为成员当前优先级最大值（零权环合并、只许提高）
  const compCount = components.length;
  const compValue = new Array<number>(compCount).fill(0);
  components.forEach((comp, ci) => {
    compValue[ci] = Math.max(...comp.map((v) => rules[v].priority));
  });
  const compEdges: Array<{ from: number; to: number; weight: 0 | 1 }> = [];
  const compEdgeSeen = new Set<string>();
  for (const e of edgeMap.values()) {
    const cf = compOf[e.from];
    const ct = compOf[e.to];
    if (cf === ct) continue; // 可行分量内只有 d=0 边，不影响取值
    const key = `${cf}|${ct}`;
    const prev = compEdges.find((x) => x.from === cf && x.to === ct);
    if (prev) {
      if (e.weight > prev.weight) prev.weight = e.weight;
    } else if (!compEdgeSeen.has(key)) {
      compEdgeSeen.add(key);
      compEdges.push({ from: cf, to: ct, weight: e.weight });
    }
  }
  // Tarjan 分量号即逆拓扑序，正向遍历需按依赖顺序；用入度 Kahn 保证确定
  const indegree = new Array<number>(compCount).fill(0);
  const compAdj: number[][] = Array.from({ length: compCount }, () => []);
  for (const e of compEdges) {
    compAdj[e.from].push(e.to);
    indegree[e.to]++;
  }
  for (const arr of compAdj) arr.sort((a, b) => a - b);
  const queue: number[] = [];
  for (let ci = 0; ci < compCount; ci++) if (indegree[ci] === 0) queue.push(ci);
  queue.sort((a, b) => a - b);
  let head = 0;
  while (head < queue.length) {
    const cf = queue[head++];
    for (const ct of compAdj[cf]) {
      const edge = compEdges.find((x) => x.from === cf && x.to === ct)!;
      compValue[ct] = Math.max(compValue[ct], compValue[cf] + edge.weight);
      if (--indegree[ct] === 0) {
        // 按编号插入保持队列确定
        let lo = head;
        let hi = queue.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (queue[mid] < ct) lo = mid + 1;
          else hi = mid;
        }
        queue.splice(lo, 0, ct);
      }
    }
  }

  const newPriority = rules.map((r) => compValue[compOf[r.index]]);

  // 用调整后的优先级重新模拟，验证每条期望
  const adjusted: RuleInput[] = rules.map((r) => ({
    pattern: r.pattern,
    priority: newPriority[r.index],
    enabled: r.enabled,
  }));
  const { rules: adjustedRules } = analyze(adjusted);
  expectations.forEach((exp) => {
    const winner = findWinner(adjustedRules, splitPath(exp.path));
    exp.afterWinnerId = winner ? winner.id : null;
    exp.verified = winner !== null && winner.id === exp.targetId;
  });

  const ruleChanges: RepairRuleChange[] = baseRules.map((r) => ({
    ...r,
    after: newPriority[r.index],
    delta: newPriority[r.index] - r.before,
  }));

  return {
    feasible: true,
    expectations,
    invalidLines,
    rules: ruleChanges,
    conflictCycle: null,
  };
}

export { MAX_REPAIR_LINES, MAX_REPAIR_LINE_LEN };
