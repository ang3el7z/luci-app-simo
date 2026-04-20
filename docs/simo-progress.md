# Simo Project Progress

## Current state

The branch is prepared as a standalone `luci-app-simo` repository with a unified `simo` package model.

## What is already done

- unified package directory and build workflows (`ipk`/`apk`)
- single service/runtime layout under `/opt/simo`
- kernel abstraction through `/opt/simo/bin/core`
- neutral mode model for `tun` / `tproxy` / `mixed`
- fixed `7894` propagated consistently into runtime config generation and firewall rules

## What remains

1. Finish lifecycle hardening for core switch + mode switch edge cases.
2. Finalize installer/runtime guardrails for failed downloads and partial upgrades.
3. Expand focused regression coverage for kernel manager and rules generation.

## Working rule

All runtime-dependent behavior must be driven from neutral `simo` settings first, then rendered into kernel-specific config formats.