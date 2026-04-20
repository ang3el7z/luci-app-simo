# Simo Architecture

## Runtime layout

- service root: `/opt/simo`
- settings: `/opt/simo/settings`
- active runtime symlink: `/opt/simo/bin/core`
- kernel selector: `/opt/simo/bin/simo-kernel-manager`
- runtime adapter/runner: `/opt/simo/bin/simo-runtime`
- firewall/routing engine: `/opt/simo/bin/simo-rules`

## Neutral settings model

Key fields in `/opt/simo/settings`:

- `CORE_TYPE` — selected runtime kernel
- `PROXY_MODE` — `tproxy|tun|mixed`
- `TUN_STACK` — `system|gvisor|mixed`
- fixed tproxy listener port: `7894` (aligned for all runtimes)
- interface and auto-detect options

## Config flow

1. LuCI writes neutral settings.
2. `config.yaml` is normalized from settings.
3. `simo-singbox-adapter` generates `config-singbox.json` from the same settings.
4. `simo-runtime` validates and starts the active kernel.
5. `simo-rules` applies firewall and policy routing based on the current mode.

## Design goal

Any runtime switch must preserve one operational model (same modes, same policy routing logic, same fixed tproxy port (7894)) without manual per-kernel rewiring.