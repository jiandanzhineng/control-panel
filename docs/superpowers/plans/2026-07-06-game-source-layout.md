# Game Source Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep built-in games in `backend/games` while allowing `play-registry/games` to add online-only games, then publish both through one registry.

**Architecture:** The backend serves only the built-in game directory. The play-registry build scans two source roots, validates global IDs, packages every discovered game, and emits one registry. The deploy workflow assembles a temporary `site/` directory from the website shell plus both game roots.

**Tech Stack:** Node.js CommonJS, Node test runner, Jest, GitHub Actions, PowerShell for local verification.

## Global Constraints

- `play-registry` remains the website source directory.
- `site/` is only a CI publish artifact.
- `backend/games/<game-id>/` stores default built-in games.
- `play-registry/games/<game-id>/` stores online-only website games.
- Registry paths remain `games/<game-id>/index.html`.
- Game IDs must be globally unique across both game roots.
- Do not migrate `backend/game`.
- Do not change online game cache install paths.

---

### Task 1: Build Registry Merge Sources

**Files:**
- Modify: `play-registry/scripts/build-registry.js`
- Modify: `play-registry/test/extract.test.js`

**Interfaces:**
- Consumes: game directories containing `index.html` with inline `game-manifest`.
- Produces: `build(options = {})`, where tests may pass `sourceRoots`, `outFile`, and `packagesDir`; normal callers use defaults.

- [x] Add tests proving the build reads both roots, writes `source: builtin|online`, and rejects duplicate IDs.
- [x] Refactor the build script to scan configured source roots.
- [x] Keep registry paths as `games/<folder>/index.html`.
- [x] Keep zip packages rooted at each game directory's `index.html`.
- [x] Run `npm --prefix play-registry test`.

### Task 2: Move Built-In Games

**Files:**
- Move: `play-registry/games/<existing-id>/` to `backend/games/<existing-id>/`
- Create: `play-registry/games/.gitkeep`
- Modify: `play-registry/README.md`

**Interfaces:**
- Consumes: existing six HTML games.
- Produces: built-in games available to backend scans and online registry builds.

- [x] Move the existing game directories into `backend/games`.
- [x] Keep `play-registry/games` available for future online-only games.
- [x] Update README wording and directory tree.
- [x] Run `npm --prefix play-registry run build`.

### Task 3: Backend Built-In Game Verification

**Files:**
- Modify: `backend/tests/gamesSavedRoutes.test.js`
- Inspect: `backend/services/gameService.js`

**Interfaces:**
- Consumes: `GET /api/games`.
- Produces: default games with `source: builtin` and `/games/<id>/index.html`.

- [x] Add a route test that expects a migrated built-in game from `backend/games`.
- [x] Adjust backend implementation only if the test exposes a gap.
- [x] Run `npm --prefix backend test -- --runInBand`.

### Task 4: Workflow Site Assembly

**Files:**
- Modify: `.github/workflows/deploy-play-registry.yml`

**Interfaces:**
- Consumes: `backend/games`, `play-registry`, generated `registry.json`, and `packages`.
- Produces: deployable `site/` containing website shell, merged games, packages, and registry.

- [x] Add `backend/games/**` to workflow trigger paths.
- [x] Keep broad website-shell copy, remove development files, then merge `backend/games`.
- [x] Preserve registry-last OSS upload.
- [x] Ensure Pages artifact path remains `site`.

### Task 5: Final Verification And Review

**Files:**
- All changed files.

**Interfaces:**
- Consumes: repository validation commands.
- Produces: committed implementation.

- [x] Run `npm --prefix backend test -- --runInBand`.
- [x] Run `npm --prefix play-registry run build`.
- [x] Run `npm --prefix play-registry test`.
- [x] Run `npm run build:frontend`.
- [x] Review the diff against `docs/superpowers/specs/2026-07-06-game-source-layout-design.md`.
- [x] Stage only related files and commit.
