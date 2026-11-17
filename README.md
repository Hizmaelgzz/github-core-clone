# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Hizmaelgzz/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Hizmaelgzz/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one self-contained Node program (standard library only, no dependencies): git smart HTTP (upload-pack v0/v2 and receive-pack, shallow fetch, thin packs), the REST v3 API (repos, refs, commits, contents, labels, issues, pull requests), a GraphQL API (repository, issues, pull requests, mutations, node ids) and an MCP server (2026-07-28 era). All state lives in memory; objects are stored byte-for-byte with SHA-1 identity, and every operation is deterministic for a given trial seed and time.

## Run it

```sh
node --experimental-strip-types main.ts
```

The program listens on an ephemeral port, registers it with the harness at `MAKEFUN_ENV_URL`, and exits when the trial reports done. `MAKEFUN_SHOP_TOKEN` is the bearer token it accepts; without it, it runs open (dev mode).

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
