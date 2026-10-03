'use strict';

// 弱互模拟（weak bisimulation）核心：校验、解析、按轮次淘汰，
// 并为每项失败义务仅引用更早轮次已淘汰的状态对，支持自底向上复算。
//
// 弱转移约定（静默前缀后承接同动作，不吸收动作后的尾部 tau）：
//   s ==tau=>  p 当且仅当 s ==epsilon=> p
//   s ==a===>  p 当且仅当存在 u：s ==epsilon=> u 且 u --a--> p   （a 可观察）

const TAU = 'tau';
const MAX_STATES = 18;
const MAX_VISIBLE_ACTIONS = 4;
const TOKEN_RE = /^[!-~]+$/; // 非空白可见 ASCII

// ---------- 校验：一次收集全部问题 ----------

function validateSpec(spec, side) {
  const errors = [];
  const push = (code, field, message) => errors.push({ code, field, side, message });

  const states = Array.isArray(spec && spec.states) ? spec.states : [];
  const transitions = Array.isArray(spec && spec.transitions) ? spec.transitions : [];
  const initial = spec && typeof spec.initial === 'string' ? spec.initial : '';

  const seenNames = new Set();
  for (const raw of states) {
    const name = typeof raw === 'string' ? raw : raw && raw.name;
    if (typeof name !== 'string' || name.length === 0) {
      push('STATE_NAME_MISSING', 'states', '存在缺少名称的状态');
      continue;
    }
    if (!TOKEN_RE.test(name)) push('STATE_NAME_INVALID', 'states', `状态名必须为非空白可见 ASCII：${JSON.stringify(name)}`);
    if (seenNames.has(name)) push('STATE_DUPLICATE', 'states', `状态名重复：${name}`);
    seenNames.add(name);
  }
  if (states.length > MAX_STATES) {
    push('STATE_LIMIT', 'states', `状态数 ${states.length} 超出上限 ${MAX_STATES}`);
  }

  const visibleActions = new Set();
  const seenTids = new Set();
  for (const t of transitions) {
    if (!t || typeof t !== 'object') {
      push('TRANSITION_INVALID', 'transitions', '存在不是对象的迁移');
      continue;
    }
    const { id, from, action, to } = t;
    if (typeof id !== 'string' || id.length === 0) {
      push('TID_MISSING', 'transitions', '存在缺少唯一标识的迁移');
    } else if (!TOKEN_RE.test(id)) {
      push('TID_INVALID', 'transitions', `迁移标识必须为非空白可见 ASCII：${JSON.stringify(id)}`);
    } else if (seenTids.has(id)) {
      push('TID_DUPLICATE', 'transitions', `迁移标识重复：${id}`);
    } else {
      seenTids.add(id);
    }
    for (const key of ['from', 'to']) {
      const v = t[key];
      if (typeof v !== 'string' || v.length === 0) {
        push('ENDPOINT_MISSING', 'transitions', `迁移 ${id || '?'} 缺少 ${key} 端点`);
      } else if (!seenNames.has(v)) {
        push('ENDPOINT_UNKNOWN', 'transitions', `迁移 ${id || '?'} 的 ${key} 端点未声明：${v}`);
      }
    }
    if (typeof action !== 'string' || action.length === 0) {
      push('ACTION_MISSING', 'transitions', `迁移 ${id || '?'} 缺少动作`);
    } else if (action === TAU) {
      // 静默内部动作
    } else if (!TOKEN_RE.test(action)) {
      push('ACTION_INVALID', 'transitions', `迁移 ${id || '?'} 的动作必须为 tau 或非空白可见 ASCII：${JSON.stringify(action)}`);
    } else {
      visibleActions.add(action);
    }
  }
  if (visibleActions.size > MAX_VISIBLE_ACTIONS) {
    push('ACTION_LIMIT', 'actions', `可观察动作种类 ${visibleActions.size} 超出上限 ${MAX_VISIBLE_ACTIONS}`);
  }

  if (!initial) {
    push('INITIAL_MISSING', 'initial', '未设置初始状态');
  } else if (!seenNames.has(initial)) {
    push('INITIAL_UNKNOWN', 'initial', `初始状态未声明：${initial}`);
  }

  return errors;
}

// ---------- 规范化 ----------

function normalize(spec) {
  const names = spec.states.map((s) => (typeof s === 'string' ? s : s.name)).sort();
  const stateSet = new Set(names);
  const actions = new Set();
  const out = new Map(names.map((n) => [n, new Map()]));
  const transitions = [];
  for (const t of spec.transitions) {
    if (!stateSet.has(t.from) || !stateSet.has(t.to) || typeof t.action !== 'string' || !t.action) continue;
    actions.add(t.action);
    if (!out.get(t.from).has(t.action)) out.get(t.from).set(t.action, new Set());
    out.get(t.from).get(t.action).add(t.to);
    transitions.push({ id: t.id, from: t.from, action: t.action, to: t.to });
  }
  transitions.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return { names, stateSet, actions, out, transitions, initial: spec.initial };
}

// ---------- 弱转移 ----------

function epsilonClosure(proc, src) {
  const seen = new Set([src]);
  const stack = [src];
  while (stack.length) {
    const u = stack.pop();
    const tauTargets = proc.out.get(u) && proc.out.get(u).get(TAU);
    if (tauTargets) {
      for (const v of tauTargets) {
        if (!seen.has(v)) {
          seen.add(v);
          stack.push(v);
        }
      }
    }
  }
  return seen;
}

function weakTargets(proc, src, action) {
  const result = new Set();
  if (action === TAU) {
    for (const p of epsilonClosure(proc, src)) result.add(p);
    return result;
  }
  for (const u of epsilonClosure(proc, src)) {
    const ts = proc.out.get(u).get(action);
    if (ts) for (const p of ts) result.add(p);
  }
  return result;
}

// ---------- 连续挑战路径 ----------
//
// 展示弱转移 origin ==a==> target 时，路径必须从实际挑战状态 origin 连续回放：
// 先经静默前缀（0 条或多条 tau）到达承接状态 u，再由 u 以一条可观察迁移到 target；
// 每一步都必须是录入的迁移标识，且上一步落点即下一步起点。绝不允许引用从 origin
// 不可达状态发出的同动作迁移（例如与初态不连通的状态上、id 排序更靠前的同动作边）。
//
// 存在多个有效静默前缀或汇合路径时，优先取步数最少的连续路径（最短静默前缀），
// 步数相同再按整条路径的迁移标识序列字典序取最小（序列为另一序列真前缀时较短者
// 更小），保证展示顺序稳定可复算。

const pathCache = new WeakMap(); // proc -> Map(origin -> Map(state -> 最优 tau 前缀边序列))

function compareEdgeLabels(p, q) {
  const n = Math.min(p.length, q.length);
  for (let i = 0; i < n; i += 1) {
    if (p[i].id < q[i].id) return -1;
    if (p[i].id > q[i].id) return 1;
  }
  return p.length - q.length;
}

// 路径全序：步数少者优先；步数相同按迁移标识序列字典序。
function comparePaths(p, q) {
  if (p.length !== q.length) return p.length - q.length;
  return compareEdgeLabels(p, q);
}

// 求 origin 经 tau 到每个静默可达状态的最优（步数最少、标识序列最小）迁移序列。
// 按该全序取最小的 Dijkstra：每条边权 1 且扩展标签为原标签真前缀，状态首次以
// 最优标签出队即全局最优；tau 环的绕行步数更多，不可能更优。
function tauPathsFrom(proc, origin) {
  let byOrigin = pathCache.get(proc);
  if (!byOrigin) {
    byOrigin = new Map();
    pathCache.set(proc, byOrigin);
  }
  const cached = byOrigin.get(origin);
  if (cached) return cached;

  const best = new Map([[origin, []]]);
  const queued = [{ state: origin, path: [] }];
  while (queued.length) {
    let idx = 0;
    for (let i = 1; i < queued.length; i += 1) {
      if (comparePaths(queued[i].path, queued[idx].path) < 0) idx = i;
    }
    const { state, path } = queued.splice(idx, 1)[0];
    const known = best.get(state);
    if (known !== undefined && comparePaths(known, path) < 0) continue;

    for (const edge of proc.transitions) {
      if (edge.from !== state || edge.action !== TAU) continue;
      const candidate = [...path, edge];
      const cur = best.get(edge.to);
      if (cur === undefined || comparePaths(candidate, cur) < 0) {
        best.set(edge.to, candidate);
        queued.push({ state: edge.to, path: candidate });
      }
    }
  }

  byOrigin.set(origin, best);
  return best;
}

function edgeStep(edge) {
  return { id: edge.id, from: edge.from, action: edge.action, to: edge.to };
}

// 构造从 origin 连续到 target 的挑战路径；target 必须确为该动作的弱转移落点。
// 可观察动作：在 origin 的静默可达状态中，选择完整路径（tau 前缀 + 承接边）
// 步数最少、标识序列最小者。tau 动作：直接取 origin 到 target 的最优 tau 路径
// （0 步时为空序列）。
function buildChallengePath(proc, origin, action, target) {
  const prefixes = tauPathsFrom(proc, origin);

  if (action === TAU) {
    const prefix = prefixes.get(target);
    return prefix === undefined ? null : prefix.map(edgeStep);
  }

  let chosen = null;
  for (const [u, prefix] of prefixes) {
    for (const edge of proc.transitions) {
      if (edge.from !== u || edge.action !== action || edge.to !== target) continue;
      const candidate = [...prefix, edge];
      if (chosen === null || comparePaths(candidate, chosen.full) < 0) {
        chosen = { full: candidate };
      }
    }
  }
  if (!chosen) return null; // 不应发生：target 必由某条弱转移到达
  return chosen.full.map(edgeStep);
}

// ---------- 按轮次淘汰 ----------
//
// R_0 为全部跨侧状态对；第 k 轮用上一轮存活集 R_{k-1} 检查每个存活对的
// 全部义务（对双方每个有弱转移的动作，挑战方每条弱转移都须由被挑战方
// 以静默前缀后承接同动作，且落点对仍存活）。无法履行义务的对在本轮淘汰。
// 因检查时 alive 尚未写入本轮淘汰，失败义务引用的落点对必然来自更早轮次。

function pairKey(a, b) {
  return `${a} ${b}`;
}
function splitKey(k) {
  const i = k.indexOf(' ');
  return [k.slice(0, i), k.slice(i + 1)];
}
function cmpPair(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return 0;
}
function asAB(challenger, pk) {
  const [p, q] = splitKey(pk);
  // 统一以 [A 侧状态, B 侧状态] 展示
  return challenger === 'A' ? [p, q] : [q, p];
}

function sortedActions(A, B) {
  const actions = new Set([...A.actions, ...B.actions]);
  return [...actions].sort((x, y) => {
    if (x === TAU) return 1;
    if (y === TAU) return -1;
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

function audit(specA, specB) {
  const errors = [...validateSpec(specA, 'A'), ...validateSpec(specB, 'B')];
  if (errors.length) {
    // 输入无效：一次显示所有问题并清除旧结论（无等价判定、无轮次）
    return { ok: false, equivalent: null, errors, rounds: [], eliminatedPairs: [], firstEliminated: null, initialPairs: [] };
  }

  const A = normalize(specA);
  const B = normalize(specB);
  const actionList = sortedActions(A, B);

  const allPairs = [];
  for (const x of A.names) for (const y of B.names) allPairs.push(pairKey(x, y));

  // 预计算每个状态对的全部义务（与轮次无关）：
  // 动作顺序固定；同一动作 A 方挑战排在 B 方挑战之前。
  const duties = new Map();
  for (const x of A.names) {
    for (const y of B.names) {
      const list = [];
      for (const action of actionList) {
        const aSrc = weakTargets(A, x, action);
        const bSrc = weakTargets(B, y, action);
        if (aSrc.size) list.push({ action, challenger: 'A', responder: 'B', origin: x, sources: [...aSrc].sort() });
        if (bSrc.size) list.push({ action, challenger: 'B', responder: 'A', origin: y, sources: [...bSrc].sort() });
      }
      duties.set(pairKey(x, y), list);
    }
  }

  const alive = new Set(allPairs); // R_0
  const eliminateRound = new Map(); // pairKey -> 淘汰轮次
  const elimination = new Map(); // pairKey -> 详情
  const rounds = [];
  let roundNo = 0;

  while (true) {
    roundNo += 1;
    const removed = [];

    for (const key of allPairs) {
      if (!alive.has(key)) continue;
      let firstFailure = null;

      for (const d of duties.get(key)) {
        const responderProc = d.responder === 'A' ? A : B;
        const challengerProc = d.challenger === 'A' ? A : B;
        const responderState = d.challenger === 'A' ? splitKey(key)[1] : splitKey(key)[0];
        const responderTargets = weakTargets(responderProc, responderState, d.action);
        const failedTransitions = [];

        if (responderTargets.size === 0) {
          // 该侧完全无法承接此动作
          for (const src of d.sources) {
            failedTransitions.push({
              source: src,
              challengePath: buildChallengePath(challengerProc, d.origin, d.action, src),
              reason: 'NO_MATCHING_ACTION',
              responses: [],
            });
          }
        } else {
          const targetsSorted = [...responderTargets].sort();
          for (const src of d.sources) {
            const responses = [];
            let matched = false;
            for (const tgt of targetsSorted) {
              const pk = d.challenger === 'A' ? pairKey(src, tgt) : pairKey(tgt, src);
              if (alive.has(pk)) {
                matched = true; // 存在仍存活的候选响应即履行义务
              } else {
                responses.push({ target: tgt, pair: asAB(d.challenger, pk), eliminatedRound: eliminateRound.get(pk) });
              }
            }
            if (!matched) {
              // 依据按轮次递减、再按状态对稳定排序；只引用更早轮次的淘汰结果
              responses.sort((u, v) => v.eliminatedRound - u.eliminatedRound || cmpPair(u.pair, v.pair));
              failedTransitions.push({
                source: src,
                challengePath: buildChallengePath(challengerProc, d.origin, d.action, src),
                reason: 'ALL_RESPONSES_ELIMINATED',
                responses,
              });
            }
          }
        }

        if (failedTransitions.length && firstFailure === null) {
          firstFailure = {
            action: d.action,
            challenger: d.challenger,
            responder: d.responder,
            // 挑战转移按源状态稳定排序
            transitions: failedTransitions.sort((u, v) => (u.source < v.source ? -1 : u.source > v.source ? 1 : 0)),
          };
        }
      }

      if (firstFailure) {
        const pair = splitKey(key);
        removed.push({ key, detail: { pair, round: roundNo, ...firstFailure } });
      }
    }

    removed.sort((r1, r2) => cmpPair(r1.detail.pair, r2.detail.pair));
    rounds.push({
      round: roundNo,
      eliminated: removed.map((r) => ({ pair: r.detail.pair, action: r.detail.action, challenger: r.detail.challenger })),
    });

    if (removed.length === 0) break; // 到达不动点
    for (const r of removed) {
      alive.delete(r.key);
      eliminateRound.set(r.key, roundNo);
      elimination.set(r.key, r.detail);
    }
  }

  // 关系按对称二元关系呈现：同时包含 (A态,B态) 与 (B态,A态) 两个方向，
  // 因而初始状态在关系中产生两个初始状态对。
  const keyAB = pairKey(specA.initial, specB.initial);
  const initSurvives = alive.has(keyAB);
  const equivalent = initSurvives;

  const eliminatedPairs = [...elimination.values()].sort((x, y) => x.round - y.round || cmpPair(x.pair, y.pair));
  const canonicalRelation = [...alive].map(splitKey).sort(cmpPair);
  const finalRelation = [
    ...canonicalRelation.map(([a, b]) => [a, b]),
    ...canonicalRelation.map(([a, b]) => [b, a]),
  ].sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0));

  return {
    ok: true,
    equivalent,
    errors: [],
    rounds,
    finalRelation,
    eliminatedPairs,
    firstEliminated: eliminatedPairs.length ? eliminatedPairs[0] : null,
    initialPairs: [
      [specA.initial, specB.initial],
      [specB.initial, specA.initial],
    ],
    initialAlive: [initSurvives, initSurvives],
  };
}

module.exports = {
  TAU,
  MAX_STATES,
  MAX_VISIBLE_ACTIONS,
  validateSpec,
  normalize,
  epsilonClosure,
  weakTargets,
  buildChallengePath,
  audit,
};
