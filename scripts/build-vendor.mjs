import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("static/vendor/addons/controls", { recursive: true });
await cp("node_modules/three/build/three.module.js", "static/vendor/three.module.js");
await cp("node_modules/three/build/three.core.js", "static/vendor/three.core.js");
await cp("node_modules/three/examples/jsm/controls/OrbitControls.js", "static/vendor/addons/controls/OrbitControls.js");
const controlsPath = "static/vendor/addons/controls/OrbitControls.js";
const controls = await readFile(controlsPath, "utf8");
await writeFile(controlsPath, controls.replace("from 'three';", "from '../../three.module.js';"));
await build({
  entryPoints: ["src/browser-radio.js"],
  outfile: "static/vendor/browser-radio.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  inject: ["scripts/browser-globals.mjs"],
  alias: {
    os: "os-browserify/browser",
    path: "path-browserify",
    util: "./scripts/util-browser.mjs",
  },
});
console.log("Browser vendor files built in static/vendor");
