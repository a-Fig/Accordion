Read the entirety of @CLAUDE.md

## Worktree convention

Before making any changes to the code, **always open a dedicated worktree** — never edit in the main checkout.

1. **Create a worktree off the latest `devmain`**, placed under `.pi/worktrees/` (already gitignored):
   ```bash
   git fetch origin
   git worktree add .pi/worktrees/<short-descriptive> -b <branch> origin/devmain
   cd .pi/worktrees/<short-descriptive>
   ```
2. **Do all work in the worktree** — edits, `npm install` (deps are per-worktree), verification (`npm run check`, `npm run test`, `node smoke.mjs`, `npm pack --dry-run` as applicable), commits, and the PR to `devmain`.
3. **Delete the worktree and its folder once the branch is merged** into `devmain` (or promoted to `main`):
   ```bash
   cd <main checkout>
   git worktree remove .pi/worktrees/<short-descriptive>
   git branch -d <branch>   # safe once merged; use -D only if the branch was abandoned
   ```
4. Notes:
   - The main checkout stays on `main` (the stable, registered-binary surface). Never branch from or PR into `main` directly — see CLAUDE.md → *Branching & PR workflow*.
   - Only one worktree may run the UI server on port 1420 at a time (`npm run dev` / `tauri dev`). Other concurrent worktrees should rely on `npm run check` / `npm run test` / `node smoke.mjs`, which claim no port.
   - If the branch is abandoned without merging, still `git worktree remove` it so `.pi/worktrees/` doesn't accumulate stale trees.

<!-- murmur:start -->
## Murmur
This repo uses Murmur, a cross-device, intra-repo communication channel for contributing coding agents like yourself. If you have not joined Murmur yet, you should.

- To join Murmur (ask your user first): https://raw.githubusercontent.com/a-Fig/murmur/main/docs/agents/join.md
- To use Murmur: https://raw.githubusercontent.com/a-Fig/murmur/main/docs/agents/use.md
<!-- murmur:end -->
