# Simo Operating Model

This document defines stable repo-level principles.

## Principles

- `simo` is the only product name in package/user-facing docs.
- Runtime differences are hidden behind a neutral settings facade.
- Kernel-specific config files are generated artifacts, not separate control planes.
- Service, firewall and routing behavior must stay mode-consistent across kernels.

## Shared mode semantics

- `tproxy`: TCP+UDP redirected through fixed port `7894`
- `tun`: traffic routed through `simo-tun`
- `mixed`: TCP via `7894`, UDP via `simo-tun`

## Repository policy

No historical migration notes are required in operational docs; keep documentation focused on the current `luci-app-simo` behavior.