// Builds dist/index.js and dist/index.d.ts from ../ts/src/sdk.ts. Run from ts/ once dependencies are installed:
//   cd ts && npm ci && node ../sdk/build.mjs
import { execFileSync } from "node:child_process";
import { rmSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const ts = join(here, "..", "ts");
const bin = (n) => join(ts, "node_modules", ".bin", n);
rmSync(join(here, "dist"), { recursive: true, force: true });
execFileSync(bin("esbuild"), [join(here, "src/index.ts"), "--bundle", "--format=esm", "--platform=node", "--target=node20", "--external:near-api-js", "--legal-comments=none", "--outfile=" + join(here, "dist/index.js")], { stdio: "inherit" });
try {
  execFileSync(bin("tsc"), [join(ts, "src/sdk.ts"), "--ignoreConfig", "--declaration", "--emitDeclarationOnly", "--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2022", "--lib", "es2022,dom", "--types", "node", "--skipLibCheck", "--outDir", join(here, "dist")], { stdio: "inherit", cwd: ts });
} catch (e) { /* declarations are still written when unrelated type checks complain */ }
if (existsSync(join(here, "dist/sdk.d.ts"))) renameSync(join(here, "dist/sdk.d.ts"), join(here, "dist/index.d.ts"));
if (!existsSync(join(here, "dist/index.d.ts"))) { console.error("type declarations were not produced"); process.exit(1); }
console.log("built sdk/dist");
