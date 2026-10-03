'use strict';

// 页面内置示例：
//  1. equivalent —— 仅差一个可观察上不可见的 tau 自环（状态重命名），应判定等价
//  2. missing    —— 一侧可观察动作另一侧无法承接，应判定不等价
//  3. cascade    —— 多轮淘汰：初始对在第 2 轮因引用第 1 轮淘汰结果而失败
//  4. confluence —— 汇合路径：A 初态经 tau 中继后 x 到后继；另有与初态不连通的状态
//                   也经 id 排序更靠前的 x 迁移到同一后继。挑战路径必须从实际挑战
//                   状态连续回放（tau 前缀 + 可观察边），不得引用不连通的同动作迁移。

const samples = {
  equivalent: {
    label: 'tau 自环 + 重命名（应等价）',
    procA: {
      states: [{ name: 'S0' }, { name: 'S1' }],
      initial: 'S0',
      transitions: [
        { id: 'a-tau-loop', from: 'S0', action: 'tau', to: 'S0' },
        { id: 'a-x', from: 'S0', action: 'x', to: 'S1' },
      ],
    },
    procB: {
      states: [{ name: 'P0' }, { name: 'P1' }],
      initial: 'P0',
      transitions: [{ id: 'b-x', from: 'P0', action: 'x', to: 'P1' }],
    },
  },
  missing: {
    label: '缺失匹配动作（应不等价）',
    procA: {
      states: [{ name: 'a0' }, { name: 'a1' }],
      initial: 'a0',
      transitions: [{ id: 'ax', from: 'a0', action: 'x', to: 'a1' }],
    },
    procB: {
      states: [{ name: 'b0' }, { name: 'b1' }],
      initial: 'b0',
      transitions: [{ id: 'by', from: 'b0', action: 'y', to: 'b1' }],
    },
  },
  cascade: {
    label: '多轮级联淘汰（初始对第 2 轮失败）',
    procA: {
      states: [{ name: 'a0' }, { name: 'a1' }, { name: 'a2' }],
      initial: 'a0',
      transitions: [
        { id: 'ax', from: 'a0', action: 'x', to: 'a1' },
        { id: 'ay', from: 'a1', action: 'y', to: 'a2' },
      ],
    },
    procB: {
      states: [{ name: 'b0' }, { name: 'b1' }],
      initial: 'b0',
      transitions: [{ id: 'bx', from: 'b0', action: 'x', to: 'b1' }],
    },
  },
  confluence: {
    label: '汇合路径（不连通同动作迁移，初始对第 2 轮失败）',
    procA: {
      states: [{ name: 'a0' }, { name: 'a1' }, { name: 'a2' }, { name: 'ad' }],
      initial: 'a0',
      transitions: [
        { id: 'a-tau', from: 'a0', action: 'tau', to: 'a1' },
        // ad 与初态 a0 不连通，但其 x 迁移标识排序更靠前：展示路径时不得引用它
        { id: 'a-x-direct', from: 'ad', action: 'x', to: 'a2' },
        { id: 'a-x-relay', from: 'a1', action: 'x', to: 'a2' },
      ],
    },
    procB: {
      states: [{ name: 'b0' }, { name: 'b1' }, { name: 'b2' }],
      initial: 'b0',
      transitions: [
        { id: 'b-x', from: 'b0', action: 'x', to: 'b1' },
        // b1 再暴露 A 侧无法承接的 y，使初始对在后续轮次淘汰
        { id: 'b-y', from: 'b1', action: 'y', to: 'b2' },
      ],
    },
  },
};

module.exports = { samples };
