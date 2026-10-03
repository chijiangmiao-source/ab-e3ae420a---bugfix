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
  const valid = [];
  for (const t of spec.transitions) {
    if (!stateSet.has(t.from) || !stateSet.has(t.to) || typeof t.action !== 'string' || !t.action) continue;
    actions.add(t.action);
    valid.push({ id: t.id, from: t.from, action: t.action, to: t.to });
  }
  // 迁移统一按标识排序：所有路径枚举均以此为稳定次序
  valid.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const transitions = [];
  const tauOut = new Map(names.map((n) => [n, []]));
  for (const t of valid) {
    if (!out.get(t.from).has(t.action)) out.get(t.from).set(t.action, new Set());
    out.get(t.from).get(t.action).add(t.to);
    if (t.action === TAU) tauOut.get(t.from).push(t); // valid 已按 id 排序
    transitions.push(t);
  }
  return { names, stateSet, actions, out, tauOut, transitions, initial: spec.initial };
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

// 挑战路径：必须从被审计的实际挑战状态连续回放——
// 静默前缀（0 条或多条 tau，每步引用录入的迁移标识）+ 可观察动作迁移，逐步衔接至目标。
// 路径选择稳定：按迁移标识升序枚举候选（valid 迁移已按 id 排序），
// 故存在多个有效静默前缀或汇合路径时展示顺序确定，且不会引用从挑战状态不可达的同动作迁移。
function challengePath(proc, origin, action, target) {
  if (action === TAU) {
    const path = shortestTauPath(proc, origin, target);
    // 可达即连续路径（origin===target 时为零步静默前缀）；不可达不应发生，给占位以便排查
    return path !== null ? path : [{ id: null, from: origin, action: TAU, to: target }];
  }
  // 在 origin 的 epsilon 闭包（经静默前缀可达）内寻找承接状态 u：
  // 闭包按到达路径长短分层、同层按状态名稳定排序，使静默前缀选择确定。
  for (const u of closureLayers(proc, origin)) {
    for (const edgeId of sortedEdgeIds(proc, u, action, target)) {
      return [...shortestTauPath(proc, origin, u), { id: edgeId, from: u, action, to: target }];
    }
  }
  return [{ id: null, from: origin, action, to: target }];
}

// 按迁移标识升序返回 u --action--> target 的迁移标识
function sortedEdgeIds(proc, u, action, target) {
  return proc.transitions
    .filter((t) => t.from === u && t.action === action && t.to === target)
    .map((t) => t.id);
}

// BFS 枚举 epsilon 闭包：先短路径后长路径；同一深度按状态名排序
function closureLayers(proc, src) {
  const seen = new Set([src]);
  const layers = [[src]];
  let frontier = [src];
  while (frontier.length) {
    const next = new Set();
    for (const u of frontier) {
      for (const t of proc.tauOut.get(u)) {
        if (!seen.has(t.to)) {
          seen.add(t.to);
          next.add(t.to);
        }
      }
    }
    if (!next.size) break;
    const layer = [...next].sort();
    layers.push(layer);
    frontier = layer;
  }
  return layers.flat();
}

// BFS 求 origin 到 goal 的最短 tau 路径；前驱状态按名称、同深度迁移按标识升序展开，路径确定
function shortestTauPath(proc, origin, goal) {
  if (origin === goal) return [];
  const prev = new Map([[origin, null]]);
  let frontier = [origin];
  while (frontier.length) {
    frontier.sort();
    const next = new Map(); // toState -> 选取的前驱迁移（按展开次序首次到达）
    for (const u of frontier) {
      for (const t of proc.tauOut.get(u)) {
        if (!prev.has(t.to) && !next.has(t.to)) next.set(t.to, t);
      }
    }
    if (!next.size) break;
    for (const [v, t] of next) {
      prev.set(v, t);
      if (v === goal) {
        const steps = [];
        let cur = goal;
        while (cur !== origin) {
          const edge = prev.get(cur);
          steps.push({ id: edge.id, from: edge.from, action: TAU, to: edge.to });
          cur = edge.from;
        }
        steps.reverse();
        return steps;
      }
    }
    frontier = [...next.keys()];
  }
  return null; // 不可达
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
              challengePath: challengePath(challengerProc, d.origin, d.action, src),
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
                challengePath: challengePath(challengerProc, d.origin, d.action, src),
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
  audit,
};
