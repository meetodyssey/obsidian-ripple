import * as esbuild from "esbuild";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    ...builtins,
  ],
  format: "cjs",
  target: "es2022",
  platform: "node",
  sourcemap: prod ? false : "inline",
  minify: prod,
  treeShaking: true,
  outfile: "main.js",
  logLevel: "info",
});

if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
  console.log("👁 Watching for changes...");
}
