# @1moby/just-auth Publish Preparation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prepare the project for publishing to npm as `@1moby/just-auth` and GitHub, with dual output (raw `.ts` source + compiled `.js`/`.d.ts`).

**Architecture:** Add a `tsconfig.build.json` that emits ESM `.js` + `.d.ts` to `dist/`. Package `exports` uses conditional exports: `types` → `.d.ts`, `import` → `.js`, `default` → `.ts` source. Ship `src/` for Bun/bundler consumers and `dist/` for Node.js/standard consumers.

**Tech Stack:** TypeScript 5, Bun (build/test runner)

---

### Task 1: Create tsconfig.build.json

**Files:**
- Create: `tsconfig.build.json`

**Step 1: Create the build tsconfig**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "allowImportingTsExtensions": false,
    "verbatimModuleSyntax": false,
    "module": "ESNext",
    "moduleResolution": "bundler"
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "exclude": ["node_modules", "tests", "sample-auth", "dist"]
}
```

**Step 2: Verify it compiles**

Run: `bunx tsc -p tsconfig.build.json`
Expected: No errors, `dist/` folder created with `.js`, `.d.ts`, `.d.ts.map`, `.js.map` files

---

### Task 2: Create build script

**Files:**
- Create: `scripts/build.ts`

```ts
import { rmSync } from "fs";

rmSync("./dist", { recursive: true, force: true });

const proc = Bun.spawn(["bunx", "tsc", "-p", "tsconfig.build.json"], {
  stdout: "inherit",
  stderr: "inherit",
});

const exitCode = await proc.exited;
if (exitCode !== 0) {
  process.exit(exitCode);
}

console.log("Build complete — dist/ ready");
```

**Step 1: Run it**

Run: `bun scripts/build.ts`
Expected: "Build complete — dist/ ready"

---

### Task 3: Update package.json

**Files:**
- Modify: `package.json`

Update with:
- name: `@1moby/just-auth`
- exports with conditional fields (types/import/default) for `.`, `./client`, `./server`
- files array
- repository, homepage, bugs, keywords, author, license
- sideEffects: false
- scripts: build, test, prepublishOnly

---

### Task 4: Create LICENSE

**Files:**
- Create: `LICENSE`

Standard MIT license with `1moby` as copyright holder, year 2026.

---

### Task 5: Rewrite README.md in English

**Files:**
- Rename: `README.md` → `README.th.md`
- Create: `README.md` (English)

Key changes:
- Package name → `@1moby/just-auth`
- Remove Arctic/oslo references (already done in code but README still mentions them)
- Update install command: `bun add @1moby/just-auth`
- Update all import paths: `from "@1moby/just-auth"`, `from "@1moby/just-auth/client"`
- Zero dependencies messaging
- Update test count to 123

---

### Task 6: Create .npmignore

**Files:**
- Create: `.npmignore`

Exclude: tests/, sample-auth/, docs/, .claude/, .gitignore, tsconfig.json, tsconfig.build.json, scripts/, *.test.ts, .env*, auth.db, bun.lock

---

### Task 7: Update sample-auth references

**Files:**
- Modify: `sample-auth/pages/dashboard.tsx` — update `bun add` and import paths to `@1moby/just-auth`
- Modify: `sample-auth/pages/login.tsx` — update `react-auth` text references

---

### Task 8: Template wrangler.jsonc

**Files:**
- Modify: `sample-auth/wrangler.jsonc` — replace account_id with placeholder

---

### Task 9: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` — update package name, remove Arctic/oslo references, update project structure

---

### Task 10: Git init + initial commit

Run:
```bash
git init
git add -A
git commit -m "feat: initial release of @1moby/just-auth v0.1.0"
```

---

### Task 11: Publish to npm

Run:
```bash
bun scripts/build.ts
npm publish --access public
```
