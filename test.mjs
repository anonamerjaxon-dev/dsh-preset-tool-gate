#!/usr/bin/env node
/**
 * Offline checks for dsh-preset-tool-gate.
 *
 * The plugin only does three things: read the preset an agent runs, look up
 * which gated tools that agent can actually see, and restrict the rest. A stub
 * context exercises all three without a server or a model call.
 *
 *   node test.mjs
 */

import assert from 'node:assert/strict'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname)
const { apply, allowedPresets, deniedFor, gateGroups, gatedTools, name } = await import(path.join(here, 'index.js'))

let passed = 0
const check = (label, fn) => {
  try { fn(); passed++; console.log(`  ok   ${label}`) } catch (error) {
    console.error(`  FAIL ${label}\n       ${error.message}`)
    process.exitCode = 1
  }
}

const CONFIG = {
  deny: ['generate_image', 'edit_image', 'view_canvas'],
  allowPresets: ['creative'],
}

/** A host context that records what the plugin asks of it. */
function makeCtx({ preset, visible = CONFIG.deny, restrictThrows = false, getThrows = false }) {
  const calls = { restrict: [], logs: [] }
  const agentCtx = {
    tools: {
      restrict(filter) {
        if (restrictThrows) throw new Error('unknown global tool')
        calls.restrict.push(filter)
        return () => {}
      },
    },
  }
  const handlers = {}
  const ctx = {
    logger: {
      info: (m) => calls.logs.push(['info', m]),
      warn: (m) => calls.logs.push(['warn', m]),
    },
    on(event, fn) { handlers[event] = fn },
    tools: {
      get(tool) {
        if (getThrows) throw new Error('boom')
        return visible.includes(tool) ? { name: tool } : undefined
      },
    },
    agentPresets: { composedPreset: () => preset },
  }
  return { ctx, agentCtx, calls, handlers }
}

console.log('\napplied to a session')
{
  const { ctx, agentCtx, calls, handlers } = makeCtx({ preset: 'standard' })
  apply(ctx, CONFIG)
  check('it listens for agent/created', () => assert.equal(typeof handlers['agent/created'], 'function'))
  handlers['agent/created']({ agent: { ctx: agentCtx } })
  check('a non-allowlisted preset gets every gate tool denied', () => {
    assert.equal(calls.restrict.length, 1)
    assert.deepEqual(calls.restrict[0].deny, CONFIG.deny)
  })
  check('it says what it did', () => {
    assert.ok(calls.logs.some(([lvl, m]) => lvl === 'info' && m.includes('preset standard')))
  })
}

console.log('\nallowlisted preset')
{
  const { ctx, agentCtx, calls, handlers } = makeCtx({ preset: 'creative' })
  apply(ctx, CONFIG)
  handlers['agent/created']({ agent: { ctx: agentCtx } })
  check('creative keeps the tools untouched', () => assert.equal(calls.restrict.length, 0))
}

console.log('\nedge cases that must not break agent creation')
{
  const { ctx, agentCtx, calls, handlers } = makeCtx({ preset: 'standard', visible: ['generate_image'] })
  apply(ctx, CONFIG)
  handlers['agent/created']({ agent: { ctx: agentCtx } })
  check('only tools the scope can actually see are denied', () => {
    assert.deepEqual(calls.restrict[0].deny, ['generate_image'])
  })
}
{
  const { ctx, agentCtx, calls, handlers } = makeCtx({ preset: 'standard', visible: [] })
  apply(ctx, CONFIG)
  handlers['agent/created']({ agent: { ctx: agentCtx } })
  check('nothing visible means no restriction call at all', () => assert.equal(calls.restrict.length, 0))
}
{
  const { ctx, agentCtx, calls, handlers } = makeCtx({ preset: 'standard', restrictThrows: true })
  apply(ctx, CONFIG)
  check('a throwing restrict is contained', () => {
    assert.doesNotThrow(() => handlers['agent/created']({ agent: { ctx: agentCtx } }))
    assert.ok(calls.logs.some(([lvl]) => lvl === 'warn'))
  })
}
{
  const { ctx, agentCtx, calls, handlers } = makeCtx({ preset: 'standard', getThrows: true })
  apply(ctx, CONFIG)
  check('a throwing tool lookup is contained', () => {
    assert.doesNotThrow(() => handlers['agent/created']({ agent: { ctx: agentCtx } }))
    assert.equal(calls.restrict.length, 0)
  })
}
{
  const { ctx, agentCtx, calls, handlers } = makeCtx({ preset: undefined })
  apply(ctx, CONFIG)
  handlers['agent/created']({ agent: { ctx: agentCtx } })
  check('a session with no preset is gated (fail closed)', () => assert.equal(calls.restrict.length, 1))
}
{
  const { ctx, handlers, calls } = makeCtx({ preset: 'standard' })
  apply(ctx, { deny: [] })
  check('an empty deny list warns instead of pretending to work', () => {
    assert.equal(handlers['agent/created'], undefined)
    assert.ok(calls.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('nothing to gate')))
  })
}

console.log('\npure helpers')
check('allowedPresets reads the config', () => {
  assert.deepEqual([...allowedPresets(CONFIG)], ['creative'])
})
check('deniedFor hides for others and keeps for the allowlist', () => {
  assert.deepEqual(deniedFor(CONFIG, 'standard'), CONFIG.deny)
  assert.deepEqual(deniedFor(CONFIG, 'creative'), [])
})
check('the plugin names itself', () => assert.equal(name, 'preset-tool-gate'))

console.log('\ngroups — one allow-list per plugin')
const GROUPED = {
  groups: [
    { name: 'images', deny: ['generate_image', 'view_canvas'], allowPresets: ['creative'] },
    { name: 'instances', deny: ['instance_start', 'instance_stop'], allowPresets: ['cordis'] },
  ],
}
check('each group keeps its own allow-list', () => {
  assert.deepEqual(deniedFor(GROUPED, 'standard').sort(),
    ['generate_image', 'instance_start', 'instance_stop', 'view_canvas'])
  assert.deepEqual(deniedFor(GROUPED, 'creative').sort(), ['instance_start', 'instance_stop'])
  assert.deepEqual(deniedFor(GROUPED, 'cordis').sort(), ['generate_image', 'view_canvas'])
})
check('a group with no allowPresets is allowed nowhere', () => {
  const cfg = { groups: [{ name: 'all-off', deny: ['bash'] }] }
  for (const preset of ['standard', 'creative', 'cordis', undefined]) {
    assert.deepEqual(deniedFor(cfg, preset), ['bash'])
  }
})
check('groups do not leak one plugin into another preset', () => {
  // the bug a flat rule would cause: cordis keeps image tools because instances
  // are allowed there
  assert.ok(!deniedFor(GROUPED, 'creative').includes('generate_image'))
  assert.ok(deniedFor(GROUPED, 'cordis').includes('generate_image'))
})
check('a tool named by two groups is denied once', () => {
  const cfg = {
    groups: [
      { name: 'a', deny: ['x_tool'], allowPresets: ['creative'] },
      { name: 'b', deny: ['x_tool'], allowPresets: [] },
    ],
  }
  assert.deepEqual(deniedFor(cfg, 'standard'), ['x_tool'])
})
check('flat and grouped rules coexist', () => {
  const cfg = { deny: ['flat_tool'], allowPresets: ['creative'], groups: [{ name: 'g', deny: ['g_tool'] }] }
  assert.deepEqual(deniedFor(cfg, 'creative'), ['g_tool'])
  assert.deepEqual(deniedFor(cfg, 'standard').sort(), ['flat_tool', 'g_tool'])
})
check('gateGroups names unnamed groups and skips empty ones', () => {
  const cfg = { groups: [{ deny: ['a'] }, { name: 'skip', deny: [] }] }
  const g = gateGroups(cfg)
  assert.equal(g.length, 1)
  assert.equal(g[0].name, 'group-1')
})
check('gatedTools lists every name once', () => {
  assert.deepEqual(gatedTools(GROUPED).sort(),
    ['generate_image', 'instance_start', 'instance_stop', 'view_canvas'])
})
{
  const { ctx, agentCtx, calls, handlers } = makeCtx({ preset: 'creative', visible: ['generate_image', 'instance_start'] })
  apply(ctx, GROUPED)
  handlers['agent/created']({ agent: { ctx: agentCtx } })
  check('one restrict call carries only the tools this preset keeps out', () => {
    assert.equal(calls.restrict.length, 1)
    assert.deepEqual(calls.restrict[0].deny, ['instance_start'])
  })
}
{
  const { ctx, agentCtx, calls, handlers } = makeCtx({ preset: 'standard', visible: [] })
  apply(ctx, GROUPED)
  check('groups still warn when nothing is configured', () => {
    const empty = makeCtx({ preset: 'standard' })
    apply(empty.ctx, { groups: [] })
    assert.equal(empty.handlers['agent/created'], undefined)
  })
  handlers['agent/created']({ agent: { ctx: agentCtx } })
  check('nothing visible means no restrict call', () => assert.equal(calls.restrict.length, 0))
}

console.log(`\n${passed} checks passed\n`)
process.exit(process.exitCode ?? 0)
