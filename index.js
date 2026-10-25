/**
 * dsh-preset-tool-gate — hide named tools from every preset except a few.
 *
 * ── The problem this solves ───────────────────────────────────────────────
 *
 * DSH splits a capability in two places that do not move together:
 *
 *   - TOOLS are per preset. A preset row mounts the plugin for that preset's
 *     sessions only, so its tool schemas cost nothing anywhere else.
 *   - CLIENT UI is per *profile*. `dsh-client-modules` composes the browser
 *     bundle list by scanning the host Loader's entries for packages declaring
 *     `dsh.client`; preset rows live in a separate in-memory tree and are
 *     mounted later, per session, so they contribute no client module at all.
 *
 * A plugin that ships a GUI therefore has to be mounted at host level — which
 * means its tools ride on every preset, including Standard. There is no config
 * that says "host entry for the UI, preset entry for the tools".
 *
 * `ToolRuntime.restrict({ deny })` closes the gap from the other side: the
 * tools stay registered (so the UI keeps working), but they leave the *visible*
 * set for a scope, and the visible set is what becomes the request. `restrict`
 * refuses a context-global call on purpose — "a context-global restriction
 * would mask every agent" — so this plugin restricts per agent, at
 * `agent/created`, where the preset the session will run is already known.
 *
 * ── Ordering ─────────────────────────────────────────────────────────────
 *
 * `agent/created` is a serial, awaited event: listeners run before the Agent
 * loop releases queued input, so the restriction is in place before the first
 * request of the session. `composedPreset` is read from the same registry the
 * GUI picker uses, and a session that switched preset while blank reports the
 * preset it actually runs.
 *
 * A tool named in a rule is skipped when the scope cannot see it — that keeps a
 * renamed or removed tool from throwing on every agent creation, and makes the
 * config safe to leave in place after the owning plugin is uninstalled.
 *
 * ── Groups ───────────────────────────────────────────────────────────────
 *
 * One flat `deny` + `allowPresets` covers a single plugin. As soon as a second
 * plugin needs its own allow-list, a flat rule is wrong: it would grant the
 * first plugin's tools wherever the second's are allowed. `groups` gives each
 * rule its own allow-list, and the rules are unioned per agent:
 *
 *   config:
 *     groups:
 *       - name: images
 *         deny: [generate_image]
 *         allowPresets: [creative]
 *       - name: instances
 *         deny: [instance_start]
 *         allowPresets: [cordis]
 *
 * A rule with no `allowPresets` is allowed nowhere. The flat form still works
 * and behaves exactly as before — it is one unnamed group — so existing configs
 * need no edit.
 */

export const name = 'preset-tool-gate'

/** Presets whose sessions keep the gated tools, when a rule names none. */
const DEFAULT_ALLOW = []

const isName = (n) => typeof n === 'string' && n !== ''

/**
 * Normalise any accepted config shape into `[{ name, deny, allow }]`.
 * Order is preserved: the flat rule first, then `groups` as configured.
 */
export function gateGroups(config = {}) {
  const out = []
  const flat = (config.deny ?? []).filter(isName)
  if (flat.length > 0) {
    out.push({ name: 'default', deny: flat, allow: new Set(config.allowPresets ?? DEFAULT_ALLOW) })
  }
  for (const [i, g] of (config.groups ?? []).entries()) {
    const deny = (g?.deny ?? []).filter(isName)
    if (deny.length === 0) continue
    out.push({
      name: isName(g.name) ? g.name : `group-${i + 1}`,
      deny,
      allow: new Set(g.allowPresets ?? DEFAULT_ALLOW),
    })
  }
  return out
}

/** Every tool name any rule could hide. */
export function gatedTools(config = {}) {
  return [...new Set(gateGroups(config).flatMap((g) => g.deny))]
}

/** Tools hidden for one preset, unioned across rules. */
export function deniedFor(config, preset) {
  const denied = new Set()
  for (const g of gateGroups(config)) {
    // A session with no preset is treated as "allowed nowhere" — the safe
    // direction: an unrecognised composition gets the smaller tool set.
    if (preset !== undefined && g.allow.has(preset)) continue
    for (const n of g.deny) denied.add(n)
  }
  return [...denied]
}

/** The preset ids a flat config leaves the tools visible in (kept for compat). */
export function allowedPresets(config) {
  return new Set(config?.allowPresets ?? DEFAULT_ALLOW)
}

export function apply(ctx, config = {}) {
  const groups = gateGroups(config)
  const log = (level, message) => ctx.logger?.[level]?.(`preset-tool-gate: ${message}`)

  if (groups.length === 0) {
    log('warn', 'no `deny` list (or non-empty `groups`) configured — nothing to gate')
    return
  }

  ctx.on('agent/created', ({ agent }) => {
    // The preset this session actually runs; a preset-free composition reports
    // undefined and is treated as "not allowed", which is the safe direction.
    const preset = ctx.agentPresets?.composedPreset?.(agent.ctx)
    const deny = deniedFor(config, preset)
    if (deny.length === 0) return

    let present
    try {
      present = deny.filter((tool) => ctx.tools.get(tool, agent.ctx) !== undefined)
    } catch (error) {
      log('warn', `could not inspect tools: ${String(error?.message ?? error)}`)
      return
    }
    if (present.length === 0) return

    try {
      agent.ctx.tools.restrict({ deny: present })
    } catch (error) {
      // An unknown name or an unscoped context would throw; neither should ever
      // fail agent creation, which awaits this listener.
      log('warn', `restrict failed (${preset ?? 'no preset'}): ${String(error?.message ?? error)}`)
      return
    }
    log('info', `hid ${present.length} tool(s) from preset ${preset ?? '(none)'}`)
  })
}
