// 针对编译产物 dist/analyzer.js 的断言测试：node test/analyzer.test.mjs
import assert from 'node:assert/strict';
import {
  parsePattern,
  matchSegments,
  intersectionWitness,
  analyze,
  simulate,
  splitPath,
  parseSampleLine,
  impact,
  buildRepro,
  selectMinCover,
  parseExpectationLine,
  repairPriorities,
} from '../dist/analyzer.js';

const P = (s) => parsePattern(s);

// ---------- 模式解析 ----------
assert.deepEqual(P('/'), []);
assert.deepEqual(P('/users/:id'), [
  { kind: 'static', value: 'users' },
  { kind: 'param', name: 'id' },
]);
assert.deepEqual(P('/a/*'), [
  { kind: 'static', value: 'a' },
  { kind: 'star' },
]);
assert.throws(() => P('/a/b*c'), /\* 必须单独成段/);
assert.throws(() => P('/a/:'), /缺少名称/);

// ---------- 单规则匹配 ----------
assert.equal(matchSegments(P('/users/:id'), splitPath('/users/42')), true);
assert.equal(matchSegments(P('/users/:id'), splitPath('/users')), false);
assert.equal(matchSegments(P('/users/:id'), splitPath('/users/42/posts')), false);
assert.equal(matchSegments(P('/a/*'), splitPath('/a')), true); // * 匹配零段
assert.equal(matchSegments(P('/a/*'), splitPath('/a/b/c/d')), true);
assert.equal(matchSegments(P('/*'), splitPath('/')), true);
assert.equal(matchSegments(P('/a/*/c'), splitPath('/a/c')), true);
assert.equal(matchSegments(P('/a/*/c'), splitPath('/a/x/y/c')), true);
assert.equal(matchSegments(P('/a/*/c'), splitPath('/a/x/y/d')), false);

// ---------- 求交见证 ----------
const W = (a, b) => {
  const w = intersectionWitness(P(a), P(b));
  return w === null ? null : '/' + w.join('/');
};
assert.equal(W('/users/new', '/users/:id'), '/users/new');
assert.equal(W('/users/:id', '/users/:name'), '/users/x');
assert.equal(W('/a/*', '/*'), '/a'); // 最短：星号都取零段
assert.equal(W('/*', '/a/b'), '/a/b');
assert.equal(W('/:x/b', '/a/:y'), '/a/b');
assert.equal(W('/:x/:y', '/a/*'), '/a/x');
assert.equal(W('/a', '/b'), null); // 无交集
assert.equal(W('/a/:x', '/a/b/c'), null); // 段数对不上且无星号
assert.equal(W('/a/*/d', '/a/b/*'), '/a/b/d'); // 双星号求交
assert.equal(W('/', '/*'), '/'); // 根路径与通配

// 见证必须真的同时命中两条规则
for (const [a, b] of [
  ['/api/:version/users', '/api/v1/*'],
  ['/*/health', '/internal/*'],
  ['/:a/:b/:c', '/x/*/:z'],
]) {
  const w = intersectionWitness(P(a), P(b));
  assert.ok(w !== null, `${a} 与 ${b} 应有交集`);
  assert.ok(matchSegments(P(a), w) && matchSegments(P(b), w), `见证须同时命中 ${a}、${b}`);
}

// ---------- 整体分析：优先级与禁用 ----------
const rules = [
  { pattern: '/api/users/new', priority: 5, enabled: true },
  { pattern: '/api/users/:id', priority: 10, enabled: true },
  { pattern: '/api/*', priority: 1, enabled: true },
  { pattern: '/health', priority: 0, enabled: true },
];
const result = analyze(rules);
assert.equal(result.rules.length, 4);
assert.deepEqual(result.rules.map((r) => r.id), ['R1', 'R2', 'R3', 'R4']);
// R1∩R2 见证 /api/users/new，R2 优先级 10 > 5，胜出 R2
const c12 = result.conflicts.find((c) => c.a === 'R1' && c.b === 'R2');
assert.equal(c12.witness, '/api/users/new');
assert.equal(c12.winner, 'R2');
assert.equal(c12.winnerInPair, true);
// R1∩R3 见证 /api/users/new 也被 R2 命中，R2 优先级最高故胜出；R2∩R3 的胜出者是 R2
assert.equal(result.conflicts.find((c) => c.a === 'R1' && c.b === 'R3').winner, 'R2');
assert.equal(result.conflicts.find((c) => c.a === 'R2' && c.b === 'R3').winner, 'R2');
assert.equal(result.conflicts.length, 3);

// 禁用 R2 后重算：/api/users/new 的胜出者变为 R1
const disabled = analyze(rules.map((r, i) => (i === 1 ? { ...r, enabled: false } : r)));
assert.ok(!disabled.conflicts.some((c) => c.a === 'R2' || c.b === 'R2'));
assert.equal(disabled.conflicts.find((c) => c.a === 'R1' && c.b === 'R3').winner, 'R1');

// 平手按输入顺序：先出现者胜
const tie = analyze([
  { pattern: '/a/:x', priority: 3, enabled: true },
  { pattern: '/a/:y', priority: 3, enabled: true },
]);
assert.equal(tie.conflicts[0].winner, 'R1');

// 见证路径的胜出者可能是冲突对之外的第三方高优先级规则
const third = analyze([
  { pattern: '/:x/b', priority: 1, enabled: true },
  { pattern: '/a/:y', priority: 1, enabled: true },
  { pattern: '/a/b', priority: 10, enabled: true },
]);
const c12t = third.conflicts.find((c) => c.a === 'R1' && c.b === 'R2');
assert.equal(c12t.witness, '/a/b');
assert.equal(c12t.winner, 'R3'); // 第三方精确规则以更高优先级截胡
assert.equal(c12t.winnerInPair, false);

// ---------- 路径模拟 ----------
const sim = simulate(rules, '/api/users/new');
assert.equal(sim.winner, 'R2');
assert.deepEqual(sim.matches, ['R2', 'R1', 'R3']);
assert.equal(simulate(rules, '/nope').winner, null);
assert.equal(simulate(rules, '/health').winner, 'R4');

// ---------- 样本行解析 ----------
assert.deepEqual(parseSampleLine('10 /api/users/1'), { count: 10, path: '/api/users/1' });
assert.deepEqual(parseSampleLine('/api/users/1'), { count: 1, path: '/api/users/1' }); // 次数省略为 1
assert.equal(parseSampleLine(''), null); // 空行跳过
assert.equal(parseSampleLine('   '), null);
assert.equal(parseSampleLine('# 注释'), null); // 注释跳过
assert.ok('error' in parseSampleLine('10')); // 缺少路径
assert.ok('error' in parseSampleLine('0 /a')); // 次数必须为正整数
assert.ok('error' in parseSampleLine('-3 /a'));
assert.ok('error' in parseSampleLine('abc')); // 路径必须以 / 开头
assert.ok('error' in parseSampleLine('/a /b')); // 路径含空白
assert.ok('error' in parseSampleLine('2 /a /b'));

// ---------- 变更影响分析 ----------
const baselineRules = [
  { pattern: '/api/users/:id', priority: 100, enabled: true },
  { pattern: '/api/users/new', priority: 10, enabled: true },
  { pattern: '/api/*', priority: 1, enabled: true },
  { pattern: '/health', priority: 0, enabled: true },
];
// 候选：/api/users/new 优先级提到 200；删除 /health；新增 /internal/*
const candidateRules = [
  { pattern: '/api/users/:id', priority: 100, enabled: true },
  { pattern: '/api/users/new', priority: 200, enabled: true },
  { pattern: '/api/*', priority: 1, enabled: true },
  { pattern: '/internal/*', priority: 2, enabled: true },
];
const imp = impact(
  baselineRules,
  candidateRules,
  [
    '5 /api/users/new', // 命中迁移：:id(100) → new(200)
    '3 /api/users/42', // 无变化：同为 /api/users/:id(100)
    '2 /health', // 变为未命中
    '7 /internal/ops', // 新增命中
    '/nope', // 两边都未命中 → 无变化
    'not-a-path', // 非法
    '4', // 非法：缺少路径
  ],
);
assert.equal(imp.samples.length, 5);
assert.equal(imp.invalidSamples.length, 2);
assert.deepEqual(
  imp.invalidSamples.map((v) => v.line),
  [6, 7],
); // 逐行提示，行号从 1 起
const byPath = Object.fromEntries(imp.samples.map((s) => [s.path, s]));
assert.equal(byPath['/api/users/new'].category, 'migrated');
assert.deepEqual(byPath['/api/users/new'].baseline, {
  id: 'R1',
  pattern: '/api/users/:id',
  priority: 100,
});
assert.deepEqual(byPath['/api/users/new'].candidate, {
  id: 'R2',
  pattern: '/api/users/new',
  priority: 200,
});
assert.equal(byPath['/api/users/42'].category, 'unchanged');
assert.equal(byPath['/health'].category, 'removed');
assert.equal(byPath['/health'].candidate, null);
assert.equal(byPath['/internal/ops'].category, 'added');
assert.equal(byPath['/internal/ops'].baseline, null);
assert.equal(byPath['/nope'].category, 'unchanged');
// 汇总：非法样本不参与统计
assert.deepEqual(imp.summary.migrated, { samples: 1, requests: 5 });
assert.deepEqual(imp.summary.removed, { samples: 1, requests: 2 });
assert.deepEqual(imp.summary.added, { samples: 1, requests: 7 });
assert.deepEqual(imp.summary.unchanged, { samples: 2, requests: 4 });
assert.deepEqual(imp.summary.total, { samples: 5, requests: 18 });

// 同一规则判定：规范化模式与优先级均相同 → 无变化（即使书写形式不同）
const written = impact(
  [{ pattern: '/api//users/', priority: 5, enabled: true }],
  [{ pattern: '/api/users', priority: 5, enabled: true }],
  ['/api/users'],
);
assert.equal(written.samples[0].category, 'unchanged');
// 模式相同但优先级不同 → 命中迁移
const prioChanged = impact(
  [{ pattern: '/api/users', priority: 5, enabled: true }],
  [{ pattern: '/api/users', priority: 6, enabled: true }],
  ['/api/users'],
);
assert.equal(prioChanged.samples[0].category, 'migrated');
// 禁用与非法规则不参与胜出
const withDisabled = impact(
  [
    { pattern: '/a', priority: 10, enabled: false },
    { pattern: '/a', priority: 1, enabled: true },
  ],
  [{ pattern: '/a', priority: 1, enabled: true }],
  ['/a'],
);
assert.equal(withDisabled.samples[0].category, 'unchanged');
assert.equal(withDisabled.samples[0].baseline.priority, 1);

// ---------- 最小复现包 ----------
// 共享见证：/a/b 同时命中三条规则，一条路径即可覆盖全部 3 组冲突
const reproRules1 = [
  { pattern: '/a/*', priority: 1, enabled: true }, // R1
  { pattern: '/a/b', priority: 2, enabled: true }, // R2
  { pattern: '/a/:x', priority: 3, enabled: true }, // R3
];
const repro1 = buildRepro(reproRules1, ['R1', 'R2', 'R3']);
assert.equal(repro1.totalConflicts, 3);
assert.equal(repro1.candidatePaths, 2); // 去重后：/a/b、/a/x
assert.equal(repro1.paths.length, 1); // 而非按冲突逐条保留 3 条
assert.equal(repro1.paths[0].path, '/a/b');
assert.deepEqual(repro1.paths[0].hits, ['R3', 'R2', 'R1']); // 按胜出顺序
assert.deepEqual(
  repro1.paths[0].covers,
  [
    { a: 'R1', b: 'R2' },
    { a: 'R1', b: 'R3' },
    { a: 'R2', b: 'R3' },
  ],
);
// 复现包自包含：胜出模拟限制在所选规则内
const ids1 = new Set(['R1', 'R2', 'R3']);
assert.ok(repro1.conflicts.every((c) => c.winner === null || ids1.has(c.winner)));

// 自包含的胜出模拟：集外高优先级规则不参与复现包内的胜出判定
const reproSelf = buildRepro(
  [
    { pattern: '/a/:x', priority: 1, enabled: true }, // R1
    { pattern: '/a/b', priority: 2, enabled: true }, // R2
    { pattern: '/a/b', priority: 100, enabled: true }, // R3 不纳入选择
  ],
  ['R1', 'R2'],
);
assert.equal(reproSelf.conflicts.length, 1);
assert.equal(reproSelf.conflicts[0].winner, 'R2'); // 不被集外 R3 截胡
// 对照：全量分析中同一冲突对的胜出者是集外的 R3
const fullAnalysis = analyze([
  { pattern: '/a/:x', priority: 1, enabled: true },
  { pattern: '/a/b', priority: 2, enabled: true },
  { pattern: '/a/b', priority: 100, enabled: true },
]);
assert.equal(fullAnalysis.conflicts[0].winner, 'R3');

// 两组独立冲突 → 最少需要 2 条路径
const repro2 = buildRepro(
  [
    { pattern: '/a/:x', priority: 1, enabled: true }, // R1
    { pattern: '/a/b', priority: 1, enabled: true }, // R2
    { pattern: '/c/:y', priority: 1, enabled: true }, // R3
    { pattern: '/c/d', priority: 1, enabled: true }, // R4
  ],
  ['R1', 'R2', 'R3', 'R4'],
);
assert.equal(repro2.totalConflicts, 2);
assert.equal(repro2.paths.length, 2);
assert.deepEqual(
  repro2.paths.map((p) => p.path),
  ['/a/b', '/c/d'],
);
assert.deepEqual(repro2.paths[0].covers, [{ a: 'R1', b: 'R2' }]);
assert.deepEqual(repro2.paths[1].covers, [{ a: 'R3', b: 'R4' }]);

// 所选规则之间无冲突 → 空复现包（合法结果，非错误）
const repro3 = buildRepro(
  [
    { pattern: '/a', priority: 1, enabled: true },
    { pattern: '/b', priority: 1, enabled: true },
  ],
  ['R1', 'R2'],
);
assert.equal(repro3.totalConflicts, 0);
assert.equal(repro3.paths.length, 0);

// 确定性：相同输入重复计算结果完全一致
assert.deepEqual(buildRepro(reproRules1, ['R3', 'R1', 'R2']), repro1); // 选择顺序无关

// 非法选择：数量、重复、不存在、禁用、非法规则
assert.throws(() => buildRepro(reproRules1, ['R1']), /2～20/);
assert.throws(() => buildRepro(reproRules1, ['R1', 'R1']), /重复/);
assert.throws(() => buildRepro(reproRules1, ['R1', 'R9']), /不存在/);
assert.throws(
  () =>
    buildRepro(
      [
        { pattern: '/a', priority: 1, enabled: false },
        { pattern: '/b', priority: 1, enabled: true },
      ],
      ['R1', 'R2'],
    ),
  /禁用/,
);
assert.throws(
  () =>
    buildRepro(
      [
        { pattern: '/a/b*c', priority: 1, enabled: true },
        { pattern: '/b', priority: 1, enabled: true },
      ],
      ['R1', 'R2'],
    ),
  /非法/,
);
// 超过 20 条
const manyRules = Array.from({ length: 21 }, (_, i) => ({
  pattern: `/p${i}/:x`,
  priority: 1,
  enabled: true,
}));
assert.throws(
  () => buildRepro(manyRules, manyRules.map((_, i) => `R${i + 1}`)),
  /2～20/,
);
// 恰好 20 条合法（互无冲突 → 空复现包）
const twenty = manyRules.slice(0, 20);
const repro20 = buildRepro(twenty, twenty.map((_, i) => `R${i + 1}`));
assert.equal(repro20.totalConflicts, 0);

// ---------- selectMinCover：精确最小覆盖与决胜规则 ----------
// 最小性：一条候选覆盖全部 → 不逐条保留
assert.deepEqual(
  selectMinCover([[0, 1, 2], [0], [1], [2]], [1, 1, 1, 1], ['/all', '/a', '/b', '/c'], 3),
  [0],
);
// 路径数优先于总段数：1 条长路径胜过 2 条短路径
assert.deepEqual(
  selectMinCover(
    [[0, 1], [0], [1]],
    [5, 1, 1],
    ['/long/path/here', '/a', '/b'],
    2,
  ),
  [0],
);
// 路径数并列 → 总段数少者胜
assert.deepEqual(
  selectMinCover([[0], [0]], [3, 1], ['/a/b/c', '/d'], 1),
  [1],
);
// 总段数并列 → 排序后路径字典序小者胜
assert.deepEqual(
  selectMinCover([[0], [0]], [1, 1], ['/b', '/a'], 1),
  [1],
);
// 多解组合并列：{0,3} 与 {1,2} 大小相同 → 比总段数
assert.deepEqual(
  selectMinCover(
    [[0], [0], [1], [1]],
    [1, 9, 9, 1],
    ['/a', '/bbbbbbbbb', '/ccccccccc', '/d'],
    2,
  ),
  [0, 3],
);
// 总段数也相同 → 集合内排序后字典序：[/a,/c] 胜过 [/a,/d]、[/b,/c]、[/b,/d]
assert.deepEqual(
  selectMinCover(
    [[0], [0], [1], [1]],
    [1, 1, 1, 1],
    ['/b', '/a', '/d', '/c'],
    2,
  ),
  [1, 3],
);
// 空全集 → 空解
assert.deepEqual(selectMinCover([], [], [], 0), []);

// ---------- 优先级修复：期望行解析 ----------
assert.deepEqual(parseExpectationLine('/a => R1'), { path: '/a', expected: 'R1' });
assert.deepEqual(parseExpectationLine('  /a/b  =>  R12  '), { path: '/a/b', expected: 'R12' });
assert.equal(parseExpectationLine(''), null); // 空行跳过
assert.equal(parseExpectationLine('   '), null);
assert.equal(parseExpectationLine('# 注释'), null); // 注释跳过
assert.ok('error' in parseExpectationLine('/a')); // 缺少 =>
assert.ok('error' in parseExpectationLine('/a => R1 => R2')); // 多个 =>
assert.ok('error' in parseExpectationLine('=> R1')); // 路径为空
assert.ok('error' in parseExpectationLine('/a =>')); // ID 为空
assert.ok('error' in parseExpectationLine('a => R1')); // 路径必须以 / 开头
assert.ok('error' in parseExpectationLine('/a b => R1')); // 路径含空白
assert.ok('error' in parseExpectationLine('/a => R')); // ID 非法
assert.ok('error' in parseExpectationLine('/a => r1'));

// ---------- 优先级修复：基本求解（只提高、逐项最小、确定性） ----------
const fixRules = [
  { pattern: '/api/users/:id', priority: 100, enabled: true }, // R1
  { pattern: '/api/users/new', priority: 10, enabled: true }, // R2
  { pattern: '/api/users/new', priority: 90, enabled: true }, // R3
  { pattern: '/api/*', priority: 1, enabled: true }, // R4
  { pattern: '/health', priority: 0, enabled: true }, // R5
];
const fix1 = repairPriorities(fixRules, [
  '# 注释与空行跳过',
  '',
  '/api/users/new => R2', // R2 需压过 R1(100)、R3(90)、R4(1)
  '/health => R5', // 原本即满足
]);
assert.equal(fix1.feasible, true);
assert.equal(fix1.conflict, null);
// R2 对 R1（顺序靠前）需 +1 → 101；对 R3（顺序靠后）持平即可 → 90；取最大 101
assert.deepEqual(fix1.adjustments, [
  { id: 'R2', pattern: '/api/users/new', before: 10, after: 101 },
]);
assert.equal(fix1.totalIncrease, 91);
const fix1Exp1 = fix1.expectations.find((e) => e.line === 3);
assert.equal(fix1Exp1.path, '/api/users/new');
assert.equal(fix1Exp1.winnerBefore, 'R1');
assert.equal(fix1Exp1.satisfiedBefore, false);
assert.equal(fix1Exp1.winnerAfter, 'R2');
assert.equal(fix1Exp1.satisfiedAfter, true);
assert.deepEqual(fix1Exp1.matched, ['R1', 'R3', 'R2', 'R4']); // 调整前胜出顺序
const fix1Exp2 = fix1.expectations.find((e) => e.line === 4);
assert.equal(fix1Exp2.satisfiedBefore, true);
assert.equal(fix1Exp2.satisfiedAfter, true);
assert.equal(fix1.invalidLines.length, 0);
// 确定性：相同输入重复计算结果完全一致
assert.deepEqual(repairPriorities(fixRules, ['# c', '', '/api/users/new => R2', '/health => R5']), fix1);

// 平手按输入顺序：顺序靠前者只需 >=（0 差约束），靠后者必须 +1（1 差约束）
const tieRules = [
  { pattern: '/a/:x', priority: 5, enabled: true }, // R1
  { pattern: '/a/:y', priority: 5, enabled: true }, // R2
];
const tieFront = repairPriorities(tieRules, ['/a/b => R1']);
assert.equal(tieFront.adjustments.length, 0); // 已满足且受零差约束保护，无需调整
assert.equal(tieFront.expectations[0].satisfiedAfter, true);
const tieBack = repairPriorities(tieRules, ['/a/b => R2']);
assert.deepEqual(tieBack.adjustments, [
  { id: 'R2', pattern: '/a/:y', before: 5, after: 6 },
]);

// 零差约束合并求解：链式传播把整条链拉到同一高度
const chainRules = [
  { pattern: '/a/*', priority: 1, enabled: true }, // R1
  { pattern: '/z', priority: 0, enabled: true }, // R2
  { pattern: '/*/x', priority: 3, enabled: true }, // R3
  { pattern: '/y', priority: 0, enabled: true }, // R4
  { pattern: '/b/x', priority: 5, enabled: true }, // R5
];
const chain = repairPriorities(chainRules, ['/a/x => R1', '/b/x => R3']);
assert.equal(chain.feasible, true);
// x[R1] >= x[R3]（0 差）、x[R3] >= x[R5]（0 差）→ 三者合并求解后同为 5
assert.deepEqual(chain.adjustments, [
  { id: 'R1', pattern: '/a/*', before: 1, after: 5 },
  { id: 'R3', pattern: '/*/x', before: 3, after: 5 },
]);
assert.equal(chain.totalIncrease, 6);
assert.ok(chain.expectations.every((e) => e.satisfiedAfter === true));

// 已满足的期望也受保护：其他期望抬高相关规则时，已满足的目标被一并抬高
const protect = repairPriorities(
  [
    { pattern: '/a', priority: 10, enabled: true }, // R1
    { pattern: '/*', priority: 5, enabled: true }, // R2
    { pattern: '/c', priority: 100, enabled: true }, // R3
  ],
  ['/a => R1', '/c => R2'],
);
assert.equal(protect.feasible, true);
// R2 被抬到 100 后，若不与 R1 合并求解，/a 的期望会被打破；保护性零差约束把 R1 一并抬到 100
assert.deepEqual(protect.adjustments, [
  { id: 'R1', pattern: '/a', before: 10, after: 100 },
  { id: 'R2', pattern: '/*', before: 5, after: 100 },
]);
assert.ok(protect.expectations.every((e) => e.satisfiedAfter === true));

// ---------- 优先级修复：正权环 → 闭环冲突期望 ----------
// 同一路径期望两个不同胜者：x[R2] >= x[R1]+1 与 x[R1] >= x[R2] 构成正权环
const loop2 = repairPriorities(tieRules, ['/a/b => R2', '/a/b => R1']);
assert.equal(loop2.feasible, false);
assert.deepEqual(loop2.conflict.lines, [1, 2]);
assert.equal(loop2.conflict.chain.length, 2);
assert.equal(loop2.adjustments.length, 0);
assert.equal(loop2.totalIncrease, 0);
assert.equal(loop2.expectations.length, 2);
assert.ok(loop2.expectations.every((e) => e.satisfiedAfter === null && e.winnerAfter === null));

// 三条期望构成的闭环：只报告环上的期望（第 2、3 行），环外期望不株连
const loop3 = repairPriorities(chainRules, ['/a/x => R1', '/b/x => R3', '/b/x => R5']);
assert.equal(loop3.feasible, false);
assert.deepEqual(loop3.conflict.lines, [2, 3]);
// 确定性：相同输入的冲突报告完全一致
assert.deepEqual(repairPriorities(chainRules, ['/a/x => R1', '/b/x => R3', '/b/x => R5']), loop3);

// ---------- 优先级修复：逐行错误提示 ----------
const errs = repairPriorities(fixRules, [
  'not-a-path => R1', // 路径必须以 / 开头
  '/nope/here => R1', // 未命中
  '/api/users/new => R9', // 规则不存在
  '/health => R1', // 目标规则不匹配该路径
  '/api/users/new => R2', // 合法
]);
assert.equal(errs.expectations.length, 1);
assert.deepEqual(
  errs.invalidLines.map((v) => v.line),
  [1, 2, 3, 4],
); // 逐行提示，行号从 1 起
assert.match(errs.invalidLines[0].error, /以 \/ 开头/);
assert.match(errs.invalidLines[1].error, /未命中/);
assert.match(errs.invalidLines[2].error, /不存在/);
assert.match(errs.invalidLines[3].error, /不匹配/);
// 非法行不参与求解：合法行照常得到方案
assert.equal(errs.feasible, true);
assert.deepEqual(errs.adjustments, [
  { id: 'R2', pattern: '/api/users/new', before: 10, after: 101 },
]);

// 禁用与非法规则不能作为期望目标
const disTarget = repairPriorities(
  [
    { pattern: '/a', priority: 1, enabled: false }, // R1 已禁用
    { pattern: '/a', priority: 1, enabled: true }, // R2
  ],
  ['/a => R1'],
);
assert.match(disTarget.invalidLines[0].error, /禁用/);
const badTarget = repairPriorities(
  [
    { pattern: '/a/b*c', priority: 1, enabled: true }, // R1 非法
    { pattern: '/a', priority: 1, enabled: true }, // R2
  ],
  ['/a => R1'],
);
assert.match(badTarget.invalidLines[0].error, /非法/);

// 空期望列表 → 可行且无需调整
const empty = repairPriorities(fixRules, []);
assert.equal(empty.feasible, true);
assert.equal(empty.adjustments.length, 0);
assert.equal(empty.expectations.length, 0);

console.log('✔ analyzer 全部测试通过');
