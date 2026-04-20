# Simo Execution Backlog

## Completed

1. Repository package target consolidated to `luci-app-simo`.
2. CI workflow names and build paths aligned to `luci-app-simo`.
3. Runtime facade and kernel manager integrated (`core` symlink model).
4. Base `tun` / `tproxy` / `mixed` mode switching wired through neutral settings.
5. Fixed TPROXY port `7894` aligned in:
   - LuCI settings persistence
   - `config.yaml` mode transformer
   - `simo-singbox-adapter`
   - `simo-rules` nft/iptables paths

## In progress

1. Harden runtime lifecycle checks around mode/core switching.
2. Align user-facing text and docs with the neutral runtime model.

## Next priorities

1. Expand validation around kernel switch rollback paths.
2. Add targeted regression tests for kernel-manager and rule generation.
3. Tighten installer checks for architecture detection and binary integrity.