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
