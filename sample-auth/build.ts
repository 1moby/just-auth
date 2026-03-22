import { rmSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

// Clean
rmSync("./dist", { recursive: true, force: true });
mkdirSync("./dist", { recursive: true });

// Resolve react from sample-auth's node_modules to ensure a single copy
const reactPath = resolve(import.meta.dir, "node_modules/react");
const reactDomPath = resolve(import.meta.dir, "node_modules/react-dom");

// Bundle the React app
const result = await Bun.build({
  entrypoints: ["./app.tsx"],
  outdir: "./dist",
  naming: "[dir]/[name]-[hash].[ext]",
  minify: true,
  target: "browser",
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  alias: {
    "react": reactPath,
    "react-dom": reactDomPath,
  },
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

// Find the output JS filename
const jsFile = result.outputs.find(o => o.path.endsWith(".js"));
const jsFilename = jsFile ? jsFile.path.split("/").pop() : "app.js";

// Copy and process HTML
let html = readFileSync("./index.html", "utf-8");
html = html.replace('./app.tsx', `/${jsFilename}`);
writeFileSync("./dist/index.html", html);

// Copy CSS
copyFileSync("./styles.css", "./dist/styles.css");

console.log("Build complete!");
console.log("Output files:");
for (const output of result.outputs) {
  const size = (output.size / 1024).toFixed(1);
  console.log(`  ${output.path.split("/").pop()} (${size} KB)`);
}
