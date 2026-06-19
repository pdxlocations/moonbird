import { cp, mkdir, readFile, writeFile } from "node:fs/promises";

await mkdir("static/vendor/addons/controls", { recursive: true });
await cp("node_modules/three/build/three.module.js", "static/vendor/three.module.js");
await cp("node_modules/three/build/three.core.js", "static/vendor/three.core.js");
await cp("node_modules/three/examples/jsm/controls/OrbitControls.js", "static/vendor/addons/controls/OrbitControls.js");
const controlsPath = "static/vendor/addons/controls/OrbitControls.js";
const controls = await readFile(controlsPath, "utf8");
await writeFile(controlsPath, controls.replace("from 'three';", "from '../../three.module.js';"));
console.log("Three.js browser files copied to static/vendor");
