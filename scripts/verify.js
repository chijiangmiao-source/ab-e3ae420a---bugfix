#!/usr/bin/env node
'use strict';

// Compose verify 服务入口：
//   1) 构建检查：全部源码/脚本语法检查（node --check）
//   2) 代码测试：node --test
//   3) 接口 / HTTP 冒烟：健康路径、页面、审计接口
//      - 静默环等价规程：审计必须判定等价，关系含两个初始状态对
//      - 缺失匹配动作规程：审计必须判定不等价，且失败依据只引用更早轮次
//      - 汇合场景：初始对第 2 轮淘汰，挑战路径从实际挑战状态连续到达目标，
//        不引用与初态不连通的同动作迁移
//      - 无效输入：一次返回全部问题并清除旧结论
// 完成后退出：全部通过 0，任一失败 1。

const { spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { samples } = require('../src/samples');

const BASE = process.env.WEB_BASE_URL || 'http://127.0.0.1:8080';
const ROOT = path.join(__dirname, '..');

let failures = 0;
function step(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  ✗ ${name}`);
    console.error(String(e && e.stack || e).split('\n').map((l) => `      ${l}`).join('\n'));
  }
}
async function astep(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  ✗ ${name}`);
    console.error(String(e && e.stack || e).split('\n').map((l) => `      ${l}`).join('\n'));
  }
}

function listJs(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? listJs(p) : d.name.endsWith('.js') ? [p] : [];
  });
}

// ---------- 1) 构建检查 ----------
console.log('[1/3] 构建检查（node --check）');
for (const file of [...listJs(path.join(ROOT, 'src')), ...listJs(path.join(ROOT, 'scripts')), ...listJs(path.join(ROOT, 'test'))]) {
  step(`语法检查 ${path.relative(ROOT, file)}`, () => {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || 'node --check 失败');
  });
}

// ---------- 2) 代码测试 ----------
console.log('[2/3] 代码测试（node --test）');
step('node --test 全部通过', () => {
  const r = spawnSync(process.execPath, ['--test'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    const tail = (r.stdout || '').split('\n').slice(-25).join('\n');
    throw new Error(`测试失败（退出码 ${r.status}）:\n${tail}`);
  }
});

// ---------- 3) 接口 / HTTP 冒烟 ----------
console.log(`[3/3] 接口 / HTTP 冒烟（${BASE}）`);

async function waitReady(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.ok) return;
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`服务在 ${timeoutMs}ms 内未就绪：${lastErr && lastErr.message}`);
}

async function postAudit(body) {
  const res = await fetch(`${BASE}/api/audit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, `审计接口 HTTP 状态应为 200，实际 ${res.status}`);
  return res.json();
}

(async () => {
  await astep('服务健康检查就绪 GET /healthz', async () => {
    await waitReady(BASE);
    const res = await fetch(`${BASE}/healthz`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.status, 'ok');
  });

  await astep('页面 GET / 返回 HTML', async () => {
    const res = await fetch(`${BASE}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    const html = await res.text();
    assert.ok(html.includes('弱互模拟审计'));
  });

  await astep('示例接口 GET /api/samples 包含等价与缺失规程', async () => {
    const res = await fetch(`${BASE}/api/samples`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.ok(j.equivalent && j.missing);
  });

  await astep('静默环等价规程：判定等价且关系含两个初始状态对', async () => {
    const j = await postAudit(samples.equivalent);
    assert.equal(j.ok, true);
    assert.equal(j.equivalent, true, JSON.stringify(j.eliminatedPairs));
    assert.equal(j.initialPairs.length, 2);
    assert.deepEqual(j.initialPairs, [['S0', 'P0'], ['P0', 'S0']]);
    assert.ok(j.initialAlive.every(Boolean));
  });

  await astep('缺失匹配动作规程：判定不等价，首个失败动作为 x', async () => {
    const j = await postAudit(samples.missing);
    assert.equal(j.equivalent, false);
    assert.ok(j.firstEliminated, '应给出首个淘汰状态对');
    assert.equal(j.firstEliminated.action, 'x');
    assert.ok(j.firstEliminated.transitions.some((t) => t.reason === 'NO_MATCHING_ACTION'));
    assert.equal(j.initialAlive[0], false);
  });

  await astep('多轮级联规程：失败义务只引用更早轮次淘汰结果且按轮次递减', async () => {
    const j = await postAudit(samples.cascade);
    assert.equal(j.equivalent, false);
    for (const ep of j.eliminatedPairs) {
      for (const t of ep.transitions) {
        if (t.reason === 'ALL_RESPONSES_ELIMINATED') {
          for (const w of t.responses) {
            assert.ok(Number.isInteger(w.eliminatedRound) && w.eliminatedRound < ep.round);
          }
          const rounds = t.responses.map((w) => w.eliminatedRound);
          assert.deepEqual(rounds, [...rounds].sort((a, b) => b - a), '依据应按轮次递减');
        }
      }
    }
  });

  await astep('汇合场景：初始对第 2 轮淘汰，x 挑战路径连续回放且不引用不连通迁移', async () => {
    const j = await postAudit(samples.confluence);
    assert.equal(j.ok, true);
    assert.equal(j.equivalent, false, '结论必须仍为不等价');

    // 初始状态对的淘汰轮次
    const init = j.eliminatedPairs.find((p) => p.pair[0] === 'a0' && p.pair[1] === 'b0');
    assert.ok(init, '初始状态对应被淘汰');
    assert.equal(init.round, 2, '初始对应在第 2 轮淘汰');
    assert.equal(init.action, 'x');
    assert.equal(init.challenger, 'A');

    const fail = init.transitions.find((t) => t.source === 'a2');
    assert.equal(fail.reason, 'ALL_RESPONSES_ELIMINATED');
    assert.equal(fail.responses.length, 1);
    assert.deepEqual(fail.responses[0].pair, ['a2', 'b1']);
    assert.equal(fail.responses[0].eliminatedRound, 1);

    // 挑战路径必须从实际挑战状态 a0 出发连续到达 a2：a0 --tau/a-tau--> a1 --x/a-x-relay--> a2
    const path = fail.challengePath;
    assert.ok(Array.isArray(path) && path.length === 2, '路径应包含静默前缀与可观察两步');
    assert.equal(path[0].id, 'a-tau');
    assert.equal(path[0].from, 'a0');
    assert.equal(path[0].action, 'tau');
    assert.equal(path[0].to, 'a1');
    assert.equal(path[1].id, 'a-x-relay');
    assert.equal(path[1].from, 'a1');
    assert.equal(path[1].action, 'x');
    assert.equal(path[1].to, 'a2');
    // 绝不引用从 a0 不连通的 ad 上 id 排序更靠前的直接迁移
    assert.ok(!path.some((s) => s.id === 'a-x-direct' || s.from === 'ad'),
      '不得引用不连通状态上的同动作迁移');

    // 首个淘汰状态对的全部展示路径同样连续可达（审查员可据此复算淘汰过程）
    const f = j.firstEliminated;
    for (const t of f.transitions) {
      const p = t.challengePath;
      assert.ok(Array.isArray(p) && p.length > 0);
      const origin = f.challenger === 'A' ? f.pair[0] : f.pair[1];
      assert.equal(p[0].from, origin, '首个淘汰对的路径必须从其挑战状态出发');
      for (let i = 1; i < p.length; i += 1) {
        assert.equal(p[i].from, p[i - 1].to, '路径前后必须连续衔接');
      }
      assert.ok(p.every((s) => s.id), '每一步都必须携带录入的迁移标识');
      const proc = f.challenger === 'A' ? samples.confluence.procA : samples.confluence.procB;
      const ids = new Set(proc.transitions.map((tr) => tr.id));
      assert.ok(p.every((s) => ids.has(s.id)), '路径标识必须真实存在');
    }
  });

  await astep('汇合场景：多轮依据仍按轮次递减，且等价裁决不回归', async () => {
    const j = await postAudit(samples.confluence);
    for (const ep of j.eliminatedPairs) {
      for (const t of ep.transitions) {
        if (t.reason === 'ALL_RESPONSES_ELIMINATED') {
          for (const w of t.responses) {
            assert.ok(Number.isInteger(w.eliminatedRound) && w.eliminatedRound < ep.round);
          }
        }
      }
    }
    // 静默环等价裁决保持不变
    const eq = await postAudit(samples.equivalent);
    assert.equal(eq.equivalent, true);
  });

  await astep('无效输入：一次返回全部问题并清除旧结论', async () => {
    const bad = {
      procA: { states: [{ name: 's' }, { name: 's' }], initial: 'ghost', transitions: [{ id: 't1', from: 's', action: '', to: 'x' }] },
      procB: { states: [], initial: '', transitions: [] },
    };
    const j = await postAudit(bad);
    assert.equal(j.ok, false);
    assert.equal(j.equivalent, null);
    assert.ok(j.errors.length >= 4, () => `应一次报告所有问题，实际 ${j.errors.length}`);
    assert.deepEqual(j.rounds, []);
    assert.deepEqual(j.eliminatedPairs, []);
    assert.equal(j.firstEliminated, null);
  });

  await astep('非 JSON 请求体返回 400', async () => {
    const res = await fetch(`${BASE}/api/audit`, { method: 'POST', body: 'not-json' });
    assert.equal(res.status, 400);
  });

  console.log(failures === 0 ? '\nVERIFY RESULT: PASS' : `\nVERIFY RESULT: FAIL（${failures} 项）`);
  process.exit(failures === 0 ? 0 : 1);
})();
