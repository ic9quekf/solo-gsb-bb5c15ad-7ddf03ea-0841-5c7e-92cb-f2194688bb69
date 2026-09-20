import { useEffect, useRef, useState } from 'react';
import { computeRepair } from './api';
import type { RepairResult, RuleInput } from './types';

const EXPECTATIONS_EXAMPLE = `# 每行一条：请求路径 => 期望胜出规则ID
# => 两侧可留空格，# 开头为注释
/api/users/new => R1
/health => R4
`;

interface RepairViewProps {
  baselineText: string;
  onBaselineTextChange: (v: string) => void;
  baselineInputs: RuleInput[];
}

export default function RepairView(props: RepairViewProps) {
  const { baselineText, onBaselineTextChange, baselineInputs } = props;
  const [expectationsText, setExpectationsText] = useState(EXPECTATIONS_EXAMPLE);
  const [result, setResult] = useState<RepairResult | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);

  // 规则或期望变化后防抖重算；序号守卫丢弃过期响应
  const seq = useRef(0);
  useEffect(() => {
    const s = ++seq.current;
    const timer = setTimeout(() => {
      computeRepair(baselineInputs, expectationsText.split('\n'))
        .then((r) => {
          if (s !== seq.current) return;
          setResult(r);
          setRepairError(null);
        })
        .catch((err: Error) => {
          if (s !== seq.current) return;
          setRepairError(err.message);
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [baselineInputs, expectationsText]);

  const changedRules = result ? result.rules.filter((r) => r.delta > 0) : [];

  const downloadJson = () => {
    if (!result) return;
    const payload = {
      tool: 'api-gateway-route-ambiguity-analyzer',
      mode: 'priority-repair',
      exportedAt: new Date().toISOString(),
      feasible: result.feasible,
      rules: result.rules.map((r) => ({
        id: r.id,
        pattern: r.pattern,
        priorityBefore: r.before,
        priorityAfter: r.after,
        delta: r.delta,
      })),
      suggestions: result.feasible
        ? result.rules
            .filter((r) => r.delta > 0)
            .map((r) => ({ id: r.id, priorityAfter: r.after, delta: r.delta }))
        : [],
      expectations: result.expectations.map((e) => ({
        line: e.line,
        path: e.path,
        targetRuleId: e.targetId,
        currentWinnerId: e.currentWinnerId,
        afterWinnerId: e.afterWinnerId,
        verified: e.verified,
        matches: e.matches,
        constraints: e.constraints.map((c) => ({
          fromRuleId: c.fromId,
          toRuleId: c.toId,
          weight: c.weight,
        })),
      })),
      invalidLines: result.invalidLines,
      ...(result.conflictCycle
        ? {
            conflictCycle: result.conflictCycle.map((e) => ({
              fromRuleId: e.fromId,
              toRuleId: e.toId,
              weight: e.weight,
              expectationLines: e.expectationLines,
            })),
          }
        : {}),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `route-priority-repair-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="layout">
      <section className="panel">
        <h2>路由规则（当前规则）</h2>
        <textarea
          className="rule-input"
          value={baselineText}
          onChange={(e) => onBaselineTextChange(e.target.value)}
          spellCheck={false}
          rows={10}
          placeholder={'每行一条：<优先级> <路由模式>'}
        />
        <h2>修复期望</h2>
        <textarea
          className="rule-input"
          value={expectationsText}
          onChange={(e) => setExpectationsText(e.target.value)}
          spellCheck={false}
          rows={10}
          placeholder={'每行一条：请求路径 => 期望胜出规则ID\n例如：/api/users/new => R1'}
        />
        <div className="status-line">
          {repairError ? (
            <span className="error-text">计算失败：{repairError}</span>
          ) : result ? (
            <span>
              {result.feasible ? (
                <>
                  方案可行 · <strong>{changedRules.length}</strong> 条规则需提高优先级
                </>
              ) : (
                <span className="error-text">存在闭环冲突，只提高优先级无法同时满足</span>
              )}
              {result.invalidLines.length > 0 && (
                <span className="warn-text"> · {result.invalidLines.length} 行非法已跳过</span>
              )}
            </span>
          ) : (
            <span>计算中…</span>
          )}
          <button className="btn" onClick={downloadJson} disabled={!result}>
            下载建议 JSON
          </button>
        </div>
        <p className="muted">
          规则：优先级数字越大越先、平手按输入顺序。后端按每条期望推导规则间的 0/1
          差值约束（目标已胜对手为 0 差，落后为 1 差），在只允许提高整数优先级的前提下求逐项增幅最小的方案。
        </p>
      </section>

      <section className="panel">
        {result?.conflictCycle && (
          <>
            <h2>闭环冲突期望</h2>
            <div className="conflict-list">
              <div className="conflict-card cycle-card">
                <div className="conflict-body">
                  {result.conflictCycle.map((e, i) => (
                    <div key={i}>
                      <span className="badge">{e.fromId}</span>
                      <span className="cycle-arrow">
                        {' '}
                        —{e.weight}→{' '}
                      </span>
                      <span className="badge badge-winner">{e.toId}</span>
                      <span className="muted">
                        {' '}
                        要求 {e.toId} 比 {e.fromId} 高 {e.weight}（第{' '}
                        {e.expectationLines.join('、')} 行）
                      </span>
                    </div>
                  ))}
                </div>
                <div className="error-text" style={{ marginTop: 8 }}>
                  环中至少一条 1 差约束（严格超过），形成正权环：任何只提高优先级的方案都无法同时满足，请修改或删除相关期望行。
                </div>
              </div>
            </div>
          </>
        )}

        <h2>优先级调整（{changedRules.length} 条变化）</h2>
        {result && changedRules.length === 0 && (
          <p className="muted">
            {result.feasible ? '全部合法期望当前已满足，无需调整优先级。' : '方案不可行，未给出调整。'}
          </p>
        )}
        {result && changedRules.length > 0 && (
          <table className="rule-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>模式</th>
                <th>调整前</th>
                <th>调整后</th>
                <th>增幅</th>
              </tr>
            </thead>
            <tbody>
              {result.rules
                .filter((r) => r.delta > 0)
                .map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.id}</td>
                    <td className="mono">{r.pattern}</td>
                    <td className="mono muted">{r.before}</td>
                    <td className="mono">
                      <strong>{r.after}</strong>
                    </td>
                    <td className="mono delta-pos">+{r.delta}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}

        <h2>期望验证（{result?.expectations.length ?? 0}）</h2>
        <div className="conflict-list">
          {result?.expectations.map((e) => (
            <div className="conflict-card" key={e.line}>
              <div className="conflict-head">
                <span className="muted">第 {e.line} 行</span>
                <code className="witness">{e.path}</code>
                <span className="muted">⇒</span>
                <span className="badge badge-winner">{e.targetId}</span>
                {e.verified ? (
                  <span className="badge badge-ok">✓ 满足</span>
                ) : (
                  <span className="badge badge-fail">✗ 未满足</span>
                )}
              </div>
              <div className="conflict-body">
                <div>
                  调整前胜出：<span className="badge">{e.currentWinnerId ?? '未命中'}</span>
                  {' → '}
                  调整后胜出：
                  <span className={e.verified ? 'badge badge-winner' : 'badge badge-fail'}>
                    {e.afterWinnerId ?? '未命中'}
                  </span>
                </div>
                <div className="muted">
                  差值约束：
                  {e.constraints.map((c, i) => (
                    <span className="cover-list" key={i}>
                      <span className={c.weight === 1 ? 'badge badge-fail' : 'badge'}>
                        {c.fromId}→{c.toId}：{c.weight}
                      </span>{' '}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
          {result && result.expectations.length === 0 && (
            <p className="muted">还没有合法期望行。</p>
          )}
        </div>

        {result && result.invalidLines.length > 0 && (
          <>
            <h2>非法期望（{result.invalidLines.length}）</h2>
            <div className="invalid-list">
              {result.invalidLines.map((v) => (
                <div className="error-text" key={v.line}>
                  第 {v.line} 行：<code>{v.raw}</code> — {v.error}
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
