# dsh-preset-tool-gate

Hide named **tools** from every DSH preset except the ones you list — without
losing the plugin's **browser UI**.

## Why this exists

DSH keeps two things that look related in separate places:

| | Scope | Consequence |
|---|---|---|
| **Tools** | per *preset* | a preset row mounts the plugin for that session only, so its schemas cost nothing elsewhere |
| **Client UI** | per *profile* | `dsh-client-modules` builds the bundle list from the **host** Loader's entries; a preset row contributes no client module at all |

So a plugin that ships a panel must be mounted at host level — and then its
tools ride on *every* preset, including Standard. Moving it into a preset to
save tokens deletes its panel everywhere. There is no config that says "host
entry for the UI, preset entry for the tools".

`ToolRuntime.restrict({ deny })` closes the gap from the other side: the tools
stay registered (the UI keeps working) but leave the *visible* set for a scope,
and the visible set is what becomes the request. `restrict` refuses a
context-global call — "a context-global restriction would mask every agent" —
so this plugin restricts **per agent**, at `agent/created`, where the preset the
session will run is already known. That event is serial and awaited, so the
restriction lands before the first request of the session.

## Config

One rule per plugin. A flat rule and a named group behave the same; use
`groups:` as soon as two plugins need different allow-lists, because a single
flat `allowPresets` would grant plugin A's tools wherever plugin B's are allowed.

```yaml
- insert:
    - id: preset-tool-gate
      name: 'dsh-preset-tool-gate'
      config:
        groups:
          - name: images
            deny: [generate_image, generate_images, edit_image,
                   canvas_state, view_canvas, find_inspiration]
            allowPresets: [creative]
          - name: instances
            deny: [instance_list, instance_logs, instance_restart,
                   instance_sessions, instance_start, instance_stop]
            allowPresets: [cordis]
      inject:
        - tools
        - agentPresets
```

- a rule with no `allowPresets` is allowed **nowhere**;
- a session with **no preset** is treated as "allowed nowhere" (fails closed);
- a tool name the scope cannot see is skipped, so a renamed or uninstalled
  plugin never throws on agent creation;
- restrictions from all rules are unioned per agent, duplicates removed.

`inject` must be declared on the **row**, not only as a module export: the Loader
reads it from the entry.

## Behaviour

```
$ dsh --profile web --dump-config    # composed config, no server
$ ~/.dsh/bin/dsh-gate-config         # this plugin's effective rules
groups: 2
  images: 6 tool(s) -> creative
  instances: 6 tool(s) -> cordis
```

Takes effect for **new sessions**; an already-running server keeps its
composition until it restarts.

## Tests

```
node test.mjs     # 23 offline checks, no server and no model call
```

They cover the flat and grouped forms, cross-group leakage, duplicate names,
missing `allowPresets`, a throwing `restrict`, a throwing tool lookup, and the
"one visible tool" case.

## Licence

MIT.
