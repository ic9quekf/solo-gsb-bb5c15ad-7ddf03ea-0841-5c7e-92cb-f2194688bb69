import { useEffect, useRef, useState } from 'react';
import { repairPriority } from './api';
import type { PriorityRepairResult, RuleInput } from './types';

interface RepairViewProps {
  rulesText: string;
  onRulesTextChange: (v: string) => void;
  expectationsText: string;
  onExpectationsTextChange: (v: string) => void;
  ruleInputs: RuleInput[];
}

export default function RepairView(props: RepairViewProps) {
  const {
    rulesText,
    onRulesTextChange,
    expectationsText,
    onExpectationsTextChange,
    ruleInputs,
  } = props;

  const [result, setResult] = useState<PriorityRepairResult | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);

  // 规则或期望变化后防抖重算；序号守卫丢弃过期响应
  const seq = useRef(0);
  useEffect(() => {
    const s = ++seq.current;
    const timer = setTimeout(() => {
      repairPriority(ruleInputs, expectationsText.split('\n'))
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
  }, [ruleInputs, expectationsText]);

  const downloadJson = () => {
    if (!result) return;
    const payload = {
      tool: 'api-gateway-route-ambiguity-analyzer',
      mode: 'priority-repair',
      exportedAt: new Date().toISOString(),
      feasible: result.feasible,
      totalIncrease: result.totalIncrease,
      adjustments: result.adjustments.map((a) => ({
        id: a.id,
        pattern: a.pattern,
        before: a.before,
        after: a.after,
        increase: a.after - a.before,
      })),
      expectations: result.expectations.map((e) => ({
        line: e.line,
        path: e.path,
        expected: e.expected,
        winnerBefore: e.winnerBefore,
        satisfiedBefore: e.satisfiedBefore,
        winnerAfter: e.winnerAfter,
        satisfiedAfter: e.satisfiedAfter,
      })),
      invalidLines: result.invalidLines,
      conflict: result.conflict,
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

  const afterOf = new Map(result?.adjustments.map((a) => [a.id, a.after]) ?? []);
  const satisfiedCount =
    result?.expectations.filter((e) => e.satisfiedAfter === true).length ?? 0;

  return (
    <main className="layout">
      <section className="panel">
        <h2>路由规则（当前规则）</h2>
        <textarea
          className="rule-input"
          value={rulesText}
          onChange={(e) => onRulesTextChange(e.target.value)}
          spellCheck={false}
          rows={8}
          placeholder={'每行一条：<优先级> <路由模式>'}
        />
        <h2>期望胜出</h2>
        <textarea
          className="rule-input"
          value={expectationsText}
          onChange={(e) => onExpectationsTextChange(e.target.value)}
          spellCheck={false}
          rows={8}
          placeholder={'每行一条：请求路径 => 期望胜出规则ID\n例如：/api/users/new => R2'}
        />
        <div className="status-line">
          {repairError ? (
            <span className="error-text">计算失败：{repairError}</span>
          ) : !result ? (
            <span>计算中…</span>
          ) : !result.feasible ? (
            <span className="error-text">
              存在闭环冲突，无法仅靠提高优先级满足全部期望
            </span>
          ) : (
            <span>
              {result.adjustments.length > 0 ? (
                <>
                  需调整 <strong>{result.adjustments.length}</strong> 条规则 · 总增幅{' '}
                  {result.totalIncrease}
                </>
              ) : (
                '当前优先级已满足全部期望，无需调整'
              )}
              {result.invalidLines.length > 0 && (
                <span className="warn-text">
                  {' '}
                  · {result.invalidLines.length} 行非法期望已跳过
                </span>
              )}
            </span>
          )}
          <button className="btn" onClick={downloadJson} disabled={!result}>
            下载建议 JSON
          </button>
        </div>

        {result && result.rules.length > 0 && (
          <table className="rule-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>模式</th>
                <th>调整前</th>
                <th>调整后</th>
              </tr>
            </thead>
            <tbody>
              {result.rules.map((rule) => {
                const after = afterOf.get(rule.id);
                return (
                  <tr
                    key={rule.id}
                    className={rule.enabled ? '' : 'row-disabled'}
                    title={rule.error ?? undefined}
                  >
                    <td className="mono">{rule.id}</td>
                    <td className="mono">
                      {rule.pattern}
                      {rule.error && <div className="error-text">{rule.error}</div>}
                    </td>
                    <td className="mono">{rule.priority}</td>
                    <td className="mono">
                      {after !== undefined ? (
                        <span className="delta-up">
                          {after}（+{after - rule.priority}）
                        </span>
                      ) : (
                        rule.priority
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>
          期望验证（{result ? `${satisfiedCount}/${result.expectations.length}` : 0}）
        </h2>
        {result && !result.feasible && result.conflict && (
          <div className="conflict-card conflict-card-error">
            <div className="conflict-head">
              <span className="error-text">
                闭环冲突：以下期望相互矛盾，无法同时满足
              </span>
            </div>
            <div className="conflict-body">
              <div>
                涉及期望：
                {result.conflict.lines.map((l) => `第 ${l} 行`).join('、')}
              </div>
              {result.conflict.chain.map((c, i) => (
                <div className="mono muted" key={i}>
                  x[{c.a}] ≥ x[{c.b}]{c.diff === 1 ? ' + 1' : ''}（第 {c.line} 行）
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="conflict-list">
          {result?.expectations.map((e) => (
            <div className="conflict-card" key={e.line}>
              <div className="conflict-head">
                <span className="muted">第 {e.line} 行</span>
                <code className="witness">{e.path}</code>
                <span className="vs">⇒</span>
                <span className="badge">{e.expected}</span>
                {e.satisfiedAfter === true ? (
                  <span className="badge cat-added">✓ 调整后满足</span>
                ) : e.satisfiedAfter === false ? (
                  <span className="badge cat-removed">✗ 调整后仍不满足</span>
                ) : (
                  <span className="badge">不可解</span>
                )}
              </div>
              <div className="conflict-body">
                <div>
                  调整前胜出：
                  {e.winnerBefore ? (
                    <span className="badge">{e.winnerBefore}</span>
                  ) : (
                    <span className="muted">无</span>
                  )}
                  {e.satisfiedBefore && <span className="muted">（原本即满足）</span>}
                  {e.winnerAfter !== null && e.winnerAfter !== e.winnerBefore && (
                    <>
                      {' '}
                      → 调整后：<span className="badge badge-winner">{e.winnerAfter}</span>
                    </>
                  )}
                </div>
                <div className="muted">
                  命中规则（调整前胜出顺序）：{e.matched.join(' → ')}
                </div>
              </div>
            </div>
          ))}
          {result && result.expectations.length === 0 && (
            <p className="muted">
              没有合法期望。请在左侧按「请求路径 {'=>'} 期望胜出规则ID」逐行填写。
            </p>
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
