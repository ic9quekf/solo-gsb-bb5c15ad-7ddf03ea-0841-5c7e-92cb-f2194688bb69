// 与后端 analyzer.ts 对应的类型定义
export interface RuleInput {
  pattern: string;
  priority: number;
  enabled: boolean;
}

export type Segment =
  | { kind: 'static'; value: string }
  | { kind: 'param'; name: string }
  | { kind: 'star' };

export interface AnalyzedRule {
  id: string;
  index: number;
  pattern: string;
  priority: number;
  enabled: boolean;
  segments: Segment[];
  error: string | null;
}

export interface ConflictPair {
  a: string;
  b: string;
  witness: string;
  winner: string | null;
  winnerInPair: boolean;
}

export interface AnalysisResult {
  rules: AnalyzedRule[];
  conflicts: ConflictPair[];
}

export interface MatchResult {
  path: string;
  matches: string[];
  winner: string | null;
}

// ---------- 变更影响 ----------
export type ImpactCategory = 'migrated' | 'added' | 'removed' | 'unchanged';

export interface WinnerRef {
  id: string;
  pattern: string;
  priority: number;
}

export interface SampleImpact {
  line: number;
  count: number;
  path: string;
  baseline: WinnerRef | null;
  candidate: WinnerRef | null;
  category: ImpactCategory;
}

export interface InvalidSample {
  line: number;
  raw: string;
  error: string;
}

export interface CategorySummary {
  samples: number;
  requests: number;
}

export interface ImpactResult {
  baselineRules: AnalyzedRule[];
  candidateRules: AnalyzedRule[];
  samples: SampleImpact[];
  invalidSamples: InvalidSample[];
  summary: Record<ImpactCategory, CategorySummary> & { total: CategorySummary };
}

// ---------- 最小复现包 ----------
export interface ReproConflict {
  a: string;
  b: string;
}

export interface ReproPath {
  path: string;
  hits: string[];
  covers: ReproConflict[];
}

export interface ReproResult {
  rules: AnalyzedRule[];
  conflicts: ConflictPair[];
  candidatePaths: number;
  totalConflicts: number;
  paths: ReproPath[];
}

// ---------- 优先级修复 ----------
export interface RepairConstraint {
  fromId: string;
  toId: string;
  weight: 0 | 1;
}

export interface RepairExpectation {
  line: number;
  raw: string;
  path: string;
  targetId: string;
  matches: string[];
  currentWinnerId: string | null;
  afterWinnerId: string | null;
  verified: boolean;
  constraints: RepairConstraint[];
}

export interface RepairInvalidLine {
  line: number;
  raw: string;
  error: string;
}

export interface RepairRuleChange {
  id: string;
  index: number;
  pattern: string;
  before: number;
  after: number;
  delta: number;
}

export interface RepairCycleEdge {
  fromId: string;
  toId: string;
  weight: number;
  expectationLines: number[];
}

export interface RepairResult {
  feasible: boolean;
  expectations: RepairExpectation[];
  invalidLines: RepairInvalidLine[];
  rules: RepairRuleChange[];
  conflictCycle: RepairCycleEdge[] | null;
}
