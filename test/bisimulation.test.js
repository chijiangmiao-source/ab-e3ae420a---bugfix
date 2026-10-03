'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { audit, weakTargets, normalize, buildChallengePath, TAU } = require('../src/bisimulation');
const { samples } = require('../src/samples');

test('仅以 tau 环重命名而等价：关系包含两个初始状态对', () => {
  const r = audit(samples.equivalent.procA, samples.equivalent.procB);
  assert.equal(r.ok, true);
  assert.equal(r.equivalent, true);
  assert.deepEqual(r.initialPairs, [['S0', 'P0'], ['P0', 'S0']]);
  assert.ok(r.initialAlive.every(Boolean));
  assert.ok(r.finalRelation.some((p) => p[0] === 'S0' && p[1] === 'P0'));
  assert.ok(r.finalRelation.some((p) => p[0] === 'P0' && p[1] === 'S0'));
  // 行为不同的配对（如 S0 与终态 P1）被淘汰属正常；初始对存活即等价
  assert.ok(!r.eliminatedPairs.some((p) => p.pair[0] === 'S0' && p.pair[1] === 'P0'));
});

test('缺失匹配动作：不等价，首个失败义务是缺失侧无法承接的动作', () => {
  const r = audit(samples.missing.procA, samples.missing.procB);
  assert.equal(r.equivalent, false);
  const f = r.firstEliminated;
  assert.equal(f.action, 'x'); // 有 x 的 A 方挑战，B 方无法承接
  assert.equal(f.challenger, 'A');
  assert.ok(f.transitions.some((t) => t.reason === 'NO_MATCHING_ACTION'));
  // 四个跨侧对中三个无法匹配（死态对 (a1,b1) 存活）
  assert.equal(r.rounds[0].eliminated.length, 3);
  const initPair = r.eliminatedPairs.find((p) => p.pair[0] === 'a0' && p.pair[1] === 'b0');
  assert.equal(initPair.round, 1);
});

test('多轮级联：初始对第 2 轮淘汰，失败义务只引用第 1 轮淘汰对', () => {
  const r = audit(samples.cascade.procA, samples.cascade.procB);
  assert.equal(r.equivalent, false);

  const p11 = r.eliminatedPairs.find((p) => p.pair[0] === 'a1' && p.pair[1] === 'b1');
  assert.equal(p11.round, 1);
  assert.equal(p11.action, 'y');

  const p00 = r.eliminatedPairs.find((p) => p.pair[0] === 'a0' && p.pair[1] === 'b0');
  assert.equal(p00.round, 2);
  assert.equal(p00.action, 'x');
  assert.equal(p00.challenger, 'A');

  const fail = p00.transitions.find((t) => t.source === 'a1');
  assert.equal(fail.reason, 'ALL_RESPONSES_ELIMINATED');
  assert.equal(fail.responses.length, 1);
  assert.deepEqual(fail.responses[0].pair, ['a1', 'b1']);
  assert.equal(fail.responses[0].eliminatedRound, 1);

  // 每条失败义务的依据都来自严格更早的轮次（自底向上可复算）
  for (const ep of r.eliminatedPairs) {
    for (const t of ep.transitions) {
      if (t.reason === 'ALL_RESPONSES_ELIMINATED') {
        for (const w of t.responses) {
          assert.ok(typeof w.eliminatedRound === 'number');
          assert.ok(w.eliminatedRound < ep.round, `依据轮次应更早: ${JSON.stringify(w)} in round ${ep.round}`);
        }
        // 依据按轮次递减排序
        const rounds = t.responses.map((w) => w.eliminatedRound);
        assert.deepEqual(rounds, [...rounds].sort((x, y) => y - x));
      }
    }
  }
});

// 校验挑战路径：从 origin 连续到 target，每步是真实迁移、上一步落点即下一步起点，
// 静默前缀全部为 tau，最后一步为可观察动作。
function assertContinuousPath(proc, path, origin, action, target) {
  assert.ok(Array.isArray(path) && path.length > 0, '挑战路径必须非空');
  const byId = new Map(proc.transitions.map((e) => [e.id, e]));
  assert.equal(path[0].from, origin, '路径必须从实际挑战状态出发');
  assert.equal(path[path.length - 1].to, target, '路径必须连续到达挑战落点');
  for (let i = 0; i < path.length; i += 1) {
    const step = path[i];
    assert.notEqual(step.id, null, '每一步都必须对应录入的迁移标识');
    const real = byId.get(step.id);
    assert.ok(real, `迁移标识必须真实存在：${step.id}`);
    assert.equal(step.from, real.from);
    assert.equal(step.action, real.action);
    assert.equal(step.to, real.to);
    if (i > 0) assert.equal(step.from, path[i - 1].to, '前后步骤必须衔接');
    if (i < path.length - 1) assert.equal(step.action, TAU, '可观察动作前只能有静默前缀');
  }
  assert.equal(path[path.length - 1].action, action, '最后一步必须是挑战动作');
}

test('汇合场景：初始对第 2 轮淘汰，x 挑战路径从初态连续回放且不引用不连通迁移', () => {
  const { procA, procB } = samples.confluence;
  const r = audit(procA, procB);
  assert.equal(r.ok, true);
  assert.equal(r.equivalent, false, '审计结论仍为不等价');

  const init = r.eliminatedPairs.find((p) => p.pair[0] === 'a0' && p.pair[1] === 'b0');
  assert.ok(init, '初始状态对应被淘汰');
  assert.equal(init.round, 2, '初始对在后续（第 2）轮淘汰');
  assert.equal(init.action, 'x');
  assert.equal(init.challenger, 'A');

  const fail = init.transitions.find((t) => t.source === 'a2');
  assert.equal(fail.reason, 'ALL_RESPONSES_ELIMINATED');
  assert.equal(fail.responses.length, 1);
  assert.deepEqual(fail.responses[0].pair, ['a2', 'b1']);
  assert.equal(fail.responses[0].eliminatedRound, 1, '依据仅引用第 1 轮淘汰结果');

  // 核心回归：挑战路径必须是 a0 --tau/a-tau--> a1 --x/a-x-relay--> a2，
  // 绝不能引用从 a0 不可达的 ad 上标识更靠前的 a-x-direct。
  assertContinuousPath(normalize(procA), fail.challengePath, 'a0', 'x', 'a2');
  assert.deepEqual(fail.challengePath.map((s) => s.id), ['a-tau', 'a-x-relay']);
  assert.ok(!fail.challengePath.some((s) => s.id === 'a-x-direct' || s.from === 'ad'));

  // 首个淘汰状态对的展示路径同样必须从其挑战状态连续到达
  const A = normalize(procA);
  for (const ep of r.eliminatedPairs) {
    for (const t of ep.transitions) {
      const origin = ep.challenger === 'A' ? ep.pair[0] : ep.pair[1];
      const proc = ep.challenger === 'A' ? A : normalize(procB);
      assertContinuousPath(proc, t.challengePath, origin, ep.action, t.source);
      assert.ok(!t.challengePath.some((s) => s.from === 'ad' && ep.pair[0] !== 'ad'),
        '非 ad 的挑战状态不得引用不连通状态 ad 上的迁移');
    }
  }
});

test('挑战路径构造器：可达性约束、汇合选择与稳定排序', () => {
  const proc = normalize({
    states: [{ name: 's' }, { name: 'u' }, { name: 'm1' }, { name: 'm2' }, { name: 'p' }, { name: 'd' }],
    initial: 's',
    transitions: [
      { id: 'tau-long', from: 's', action: 'tau', to: 'm1' },
      { id: 'tau-m1-u', from: 'm1', action: 'tau', to: 'u' },
      { id: 'tau-short', from: 's', action: 'tau', to: 'u' }, // 另一条更短的静默前缀（id 反而更大）
      { id: 'tau-loop', from: 'u', action: 'tau', to: 'u' }, // 静默环绕行步数更多，不应更优
      { id: 'x-via-u', from: 'u', action: 'x', to: 'p' },
      { id: 'a-x-disconnected', from: 'd', action: 'x', to: 'p' }, // 与 s 不连通但 id 最靠前
    ],
  });

  const path = buildChallengePath(proc, 's', 'x', 'p');
  assertContinuousPath(proc, path, 's', 'x', 'p');
  // 多条静默前缀汇合到同一可观察边：取步数最少者（tau-short，1 步）而非
  // id 更小但多 1 步的 tau-long→tau-m1-u；且忽略不连通的 a-x-disconnected。
  assert.deepEqual(path.map((e) => e.id), ['tau-short', 'x-via-u']);

  // 重复构造结果稳定
  assert.deepEqual(buildChallengePath(proc, 's', 'x', 'p').map((e) => e.id), ['tau-short', 'x-via-u']);

  // 0 条静默前缀：s ==tau=> s 为空路径
  assert.deepEqual(buildChallengePath(proc, 's', 'tau', 's'), []);
  // 非零静默路径也按标识稳定
  assert.deepEqual(buildChallengePath(proc, 's', 'tau', 'u').map((e) => e.id), ['tau-short']);
  assert.deepEqual(buildChallengePath(proc, 's', 'tau', 'm1').map((e) => e.id), ['tau-long']);

  // 直接动作（无静默前缀）：一步到位
  const direct = normalize({
    states: [{ name: 'q' }, { name: 'r' }],
    initial: 'q',
    transitions: [{ id: 'qx', from: 'q', action: 'x', to: 'r' }],
  });
  assert.deepEqual(buildChallengePath(direct, 'q', 'x', 'r').map((e) => e.id), ['qx']);

  // 等长静默前缀：按迁移标识序列字典序稳定取最小
  const tied = normalize({
    states: [{ name: 's' }, { name: 'u' }, { name: 'p' }],
    initial: 's',
    transitions: [
      { id: 'z-tau', from: 's', action: 'tau', to: 'u' },
      { id: 'a-tau', from: 's', action: 'tau', to: 'u' },
      { id: 'x1', from: 'u', action: 'x', to: 'p' },
    ],
  });
  assert.deepEqual(buildChallengePath(tied, 's', 'x', 'p').map((e) => e.id), ['a-tau', 'x1']);
});

test('tau 链上的弱转移：静默前缀后承接动作', () => {  const proc = normalize({
    states: [{ name: 's' }, { name: 'u' }, { name: 'p' }, { name: 'v' }],
    initial: 's',
    transitions: [
      { id: '1', from: 's', action: 'tau', to: 'u' },
      { id: '2', from: 'u', action: 'tau', to: 'p' },
      { id: '3', from: 'p', action: 'a', to: 'v' },
    ],
  });
  assert.deepEqual([...weakTargets(proc, 's', 'a')], ['v']);
  assert.deepEqual([...weakTargets(proc, 's', TAU)].sort(), ['p', 's', 'u']);
});

test('静默前缀 + 可观察承接的典型等价：tau 前缀进程与直接动作进程', () => {
  const A = {
    states: [{ name: 's' }, { name: 'u' }, { name: 'p' }],
    initial: 's',
    transitions: [
      { id: '1', from: 's', action: 'tau', to: 'u' },
      { id: '2', from: 'u', action: 'tau', to: 'u' }, // tau 自环
      { id: '3', from: 'u', action: 'a', to: 'p' },
    ],
  };
  const B = {
    states: [{ name: 'q' }, { name: 'r' }],
    initial: 'q',
    transitions: [{ id: '1', from: 'q', action: 'a', to: 'r' }],
  };
  const r = audit(A, B);
  assert.equal(r.equivalent, true);
});

test('输入无效：一次显示所有问题并清除旧结论', () => {
  const bad = {
    states: [{ name: 'x' }, { name: 'x' }, {}, { name: 'bad name' }],
    initial: 'ghost',
    transitions: [
      { id: 't', from: 'x', action: '', to: 'nope' },
      { id: 't', from: 'x', action: 'foo', to: 'x' },
      { id: 'a1', from: 'x', action: 'a', to: 'x' },
      { id: 'a2', from: 'x', action: 'b', to: 'x' },
      { id: 'a3', from: 'x', action: 'c', to: 'x' },
      { id: 'a4', from: 'x', action: 'd', to: 'x' },
      { id: 'a5', from: 'x', action: 'e', to: 'x' },
    ],
  };
  const r = audit(bad, { states: [], initial: '', transitions: [] });
  assert.equal(r.ok, false);
  assert.equal(r.equivalent, null);
  const codes = r.errors.map((e) => e.code);
  for (const code of [
    'STATE_DUPLICATE',
    'STATE_NAME_INVALID',
    'STATE_NAME_MISSING',
    'INITIAL_UNKNOWN',
    'ENDPOINT_UNKNOWN',
    'ACTION_MISSING',
    'TID_DUPLICATE',
    'INITIAL_MISSING',
    'ACTION_LIMIT',
  ]) {
    assert.ok(codes.includes(code), `应报告 ${code}；实际 ${JSON.stringify(codes)}`);
  }
  // 两侧问题都要收集
  assert.ok(r.errors.some((e) => e.side === 'A'));
  assert.ok(r.errors.some((e) => e.side === 'B'));
  // 清除旧结论：无轮次、无淘汰对、无初始对
  assert.equal(r.rounds.length, 0);
  assert.equal(r.eliminatedPairs.length, 0);
  assert.equal(r.firstEliminated, null);
  assert.equal(r.initialPairs.length, 0);
});

test('稳定排序：首个失败动作按动作字典序（tau 最后），轮次内状态对稳定排序', () => {
  const A = {
    states: [{ name: 's' }, { name: 'p' }],
    initial: 's',
    transitions: [
      { id: 'z', from: 's', action: 'z', to: 'p' },
      { id: 'b', from: 's', action: 'b', to: 'p' },
    ],
  };
  const B = {
    states: [{ name: 'q' }, { name: 'r' }],
    initial: 'q',
    transitions: [{ id: 'c', from: 'q', action: 'c', to: 'r' }],
  };
  const r = audit(A, B);
  // 首个淘汰对按状态对字典序为 (p,q)：p 为死态，q 可做 c，首个失败动作为 c（B 挑战）
  assert.deepEqual(r.firstEliminated.pair, ['p', 'q']);
  assert.equal(r.firstEliminated.action, 'c');
  assert.equal(r.firstEliminated.challenger, 'B');
  // (s,q) 的首个失败义务才是动作 b（A 挑战，字典序早于 z）
  const sq = r.eliminatedPairs.find((p) => p.pair[0] === 's' && p.pair[1] === 'q');
  assert.equal(sq.action, 'b');
  assert.equal(sq.challenger, 'A');
  for (const rd of r.rounds) {
    const pairs = rd.eliminated.map((e) => e.pair.join(','));
    assert.deepEqual(pairs, [...pairs].sort());
  }
});

test('同构进程（仅状态重命名）等价', () => {
  const mk = (prefix) => ({
    states: [{ name: `${prefix}0` }, { name: `${prefix}1` }, { name: `${prefix}2` }],
    initial: `${prefix}0`,
    transitions: [
      { id: `${prefix}a`, from: `${prefix}0`, action: 'a', to: `${prefix}1` },
      { id: `${prefix}b`, from: `${prefix}1`, action: 'b', to: `${prefix}2` },
      { id: `${prefix}t`, from: `${prefix}2`, action: 'tau', to: `${prefix}0` },
    ],
  });
  const r = audit(mk('s'), mk('q'));
  assert.equal(r.equivalent, true);
  // 静默环使各状态经 tau 弱可达彼此：行为相同的非初始配对也可在关系中，
  // 关键是两个初始状态对均存活、初始对未被淘汰
  assert.ok(!r.eliminatedPairs.some((p) => p.pair[0] === 's0' && p.pair[1] === 'q0'));
});

test('状态数与可观察动作种类上限', () => {
  const tooMany = {
    states: Array.from({ length: 19 }, (_, i) => ({ name: `s${i}` })),
    initial: 's0',
    transitions: [],
  };
  const r1 = audit(tooMany, { states: [{ name: 'q' }], initial: 'q', transitions: [] });
  assert.ok(r1.errors.some((e) => e.code === 'STATE_LIMIT'));

  const fiveActions = {
    states: [{ name: 's' }],
    initial: 's',
    transitions: ['a', 'b', 'c', 'd', 'e'].map((a) => ({ id: a, from: 's', action: a, to: 's' })),
  };
  const r2 = audit(fiveActions, { states: [{ name: 'q' }], initial: 'q', transitions: [] });
  assert.ok(r2.errors.some((e) => e.code === 'ACTION_LIMIT'));
});

test('18 状态 4 动作的上限边界可正常计算', () => {
  const mk = (prefix) => ({
    states: Array.from({ length: 18 }, (_, i) => ({ name: `${prefix}${i}` })),
    initial: `${prefix}0`,
    transitions: [
      ...['a', 'b', 'c', 'd'].map((act, i) => ({ id: `${prefix}${act}`, from: `${prefix}0`, action: act, to: `${prefix}${i + 1}` })),
      { id: `${prefix}tau`, from: `${prefix}0`, action: 'tau', to: `${prefix}0` },
    ],
  });
  const r = audit(mk('s'), mk('q'));
  assert.equal(r.ok, true);
  assert.equal(r.equivalent, true);
});
