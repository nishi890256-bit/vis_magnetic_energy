import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";

const ISO_VALUES = [1, 2, 3, 4, 5, 6];
const $ = id => document.getElementById(id);
const viewer = $("viewer"), drawer = $("drawer"), backdrop = $("backdrop");
const loading = $("loading"), loadingText = $("loading-text"), loadingDetail = $("loading-detail");
const menuButton = $("menu-button");
let renderer, scene, camera, controls, domainOutline, domainBox;
let domainCenter = new THREE.Vector3(), domainDiagonal = 1;
const initialCameraPosition = new THREE.Vector3();
// The camera looks from (+x,+y,+z) toward the center: +y up, +z lower-left, +x lower-right.
const RESET_VIEW_DIRECTION = new THREE.Vector3(1, 1, 1).normalize();
let initialCameraDistance = 1;
const meshes = new Map(), checkboxes = new Map();
const plyLoader = new PLYLoader();
let metadata = null;
let axisCanvas = null;
console.info("Magnetic Energy viewer: y-up-20261003-1613");

function showError(error) {
  console.error(error);
  loading.classList.remove("hidden");
  document.querySelector(".spinner").hidden = true;
  loadingText.textContent = "3Dデータを読み込めませんでした";
  loadingDetail.textContent = error.message || String(error);
  $("retry-load").hidden = false;
}
function progress(title, detail = "") {
  loadingText.textContent = title;
  loadingDetail.textContent = detail;
}
async function fetchJSON(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} を読み込めません（HTTP ${response.status}）。ファイルの配置を確認してください。`);
  try { return await response.json(); }
  catch { throw new Error(`${path} は有効なJSONではありません。`); }
}
function getBounds(raw) {
  const keys = ["xmin", "xmax", "ymin", "ymax", "zmin", "zmax"];
  if (!raw || !keys.every(key => typeof raw[key] === "number" && Number.isFinite(raw[key]))) {
    throw new Error("bounds.json または scene.json の領域情報が不正です。");
  }
  if (raw.xmax <= raw.xmin || raw.ymax <= raw.ymin || raw.zmax <= raw.zmin) {
    throw new Error("領域の最大座標は最小座標より大きい必要があります。");
  }
  return new THREE.Box3(
    new THREE.Vector3(raw.xmin, raw.ymin, raw.zmin),
    new THREE.Vector3(raw.xmax, raw.ymax, raw.zmax)
  );
}
function validateSurface(surface) {
  const rgb = surface.color_rgb;
  if (!Array.isArray(rgb) || rgb.length !== 3 || !rgb.every(c => typeof c === "number" && Number.isFinite(c) && c >= 0 && c <= 1)) {
    throw new Error(`等値面 ${surface.iso_value} の color_rgb が不正です。`);
  }
  if (!Number.isFinite(surface.opacity) || surface.opacity < 0 || surface.opacity > 1) {
    throw new Error(`等値面 ${surface.iso_value} の opacity が不正です。`);
  }
  if (surface.file !== null) {
    if (typeof surface.file !== "string" || !/^meshes\/[a-zA-Z0-9_.-]+\.ply$/.test(surface.file)) {
      throw new Error(`等値面 ${surface.iso_value} のパスは meshes/ファイル名.ply にしてください。`);
    }
  }
  return surface;
}
function validateMetadata(raw) {
  if (!raw || !Array.isArray(raw.surfaces)) throw new Error("scene.json に surfaces がありません。");
  if (!raw.color_map || raw.color_map.preset !== "Rainbow Uniform"
      || !Array.isArray(raw.color_map.range) || raw.color_map.range[0] !== 0 || raw.color_map.range[1] !== 6) {
    throw new Error("scene.json のカラーマップは Rainbow Uniform、範囲は [0, 6] にしてください。");
  }
  const samples = raw.color_map.samples;
  if (!Array.isArray(samples) || samples.length < 2
      || !samples.every((s, i) => Number.isFinite(s.value)
        && (!i || s.value > samples[i-1].value)
        && Array.isArray(s.rgb) && s.rgb.length === 3
        && s.rgb.every(c => typeof c === "number" && Number.isFinite(c) && c >= 0 && c <= 1))
      || samples[0].value > 0 || samples.at(-1).value < 6) {
    throw new Error("scene.json の color_map.samples が不正です。");
  }
  for (const value of ISO_VALUES) {
    const entries = raw.surfaces.filter(s => s.iso_value === value);
    if (entries.length !== 1) throw new Error(`scene.json の等値面 ${value} が不足または重複しています。`);
    validateSurface(entries[0]);
  }
  return raw;
}
function initRenderer() {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(viewer.clientWidth, viewer.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute("aria-label", "3D表示。ドラッグで回転、ホイールで拡大、右ドラッグで移動。");
  viewer.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);
  camera = new THREE.PerspectiveCamera(30, viewer.clientWidth / viewer.clientHeight, .001, 100000);
  camera.up.set(0, 1, 0);
  camera.position.set(1, 1, 1);
  scene.add(new THREE.AmbientLight(0xffffff, .7));
  const key = new THREE.DirectionalLight(0xffffff, .8);
  key.position.set(1, -1, 2);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, .25);
  fill.position.set(-1, 1, .5);
  scene.add(fill);
  configureControls();
  axisCanvas = document.createElement("canvas");
  axisCanvas.id = "axis-indicator";
  axisCanvas.width = 192;
  axisCanvas.height = 192;
  axisCanvas.setAttribute("role", "img");
  axisCanvas.setAttribute("aria-label", "現在のカメラから見たx、y、z軸の向き");
  document.body.appendChild(axisCanvas);
  renderer.domElement.addEventListener("webglcontextlost", event => {
    event.preventDefault();
    showError(new Error("描画用のメモリが不足した可能性があります。ほかのタブを閉じて再読み込みしてください。"));
  });
  window.addEventListener("resize", () => {
    const width = viewer.clientWidth, height = viewer.clientHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  });
  let lastTime = 0;
  renderer.setAnimationLoop(time => {
    if (time - lastTime < 1000 / 40) return;
    controls.update();
    renderer.render(scene, camera);
    drawAxisIndicator();
    lastTime = time;
  });
}
function configureControls(target = domainCenter) {
  if (controls) controls.dispose();
  // OrbitControls caches a rotation derived from camera.up at construction.
  camera.up.set(0, 1, 0);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(target);
  controls.cursor.copy(target);
  controls.enableDamping = true;
  controls.dampingFactor = .08;
  controls.rotateSpeed = .65;
  controls.zoomSpeed = .8;
  controls.panSpeed = .65;
  controls.screenSpacePanning = true;
  controls.touches.ONE = THREE.TOUCH.ROTATE;
  controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
  controls.listenToKeyEvents(renderer.domElement);
}
function drawAxisIndicator() {
  if (!axisCanvas) return;
  const ctx = axisCanvas.getContext("2d");
  ctx.clearRect(0, 0, 192, 192);
  ctx.save();
  ctx.scale(2, 2);
  const inverse = camera.quaternion.clone().invert();
  const axes = [
    { label: "x", direction: new THREE.Vector3(1, 0, 0), color: "#be443b" },
    { label: "y", direction: new THREE.Vector3(0, 1, 0), color: "#23774d" },
    { label: "z", direction: new THREE.Vector3(0, 0, 1), color: "#3568bc" },
  ].map(axis => ({ ...axis, projected: axis.direction.applyQuaternion(inverse) }));
  axes.sort((a, b) => a.projected.z - b.projected.z);
  ctx.lineWidth = 2;
  ctx.font = "600 16px Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const axis of axes) {
    const x = 48 + axis.projected.x * 27;
    const y = 48 - axis.projected.y * 27;
    ctx.strokeStyle = axis.color;
    ctx.beginPath(); ctx.moveTo(48, 48); ctx.lineTo(x, y); ctx.stroke();
    ctx.fillStyle = axis.color;
    ctx.fillText(axis.label, 48 + axis.projected.x * 40, 48 - axis.projected.y * 40);
  }
  ctx.fillStyle = "#657182";
  ctx.beginPath(); ctx.arc(48, 48, 2.5, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
function setDomain(box) {
  domainBox = box;
  box.getCenter(domainCenter);
  const size = box.getSize(new THREE.Vector3());
  domainDiagonal = size.length();
  domainOutline = new THREE.Box3Helper(box, 0x657182);
  scene.add(domainOutline);
  // Use the supplied Mayavi formula without automatic camera repositioning.
  // If available, camera_bounds supplies the all-time global bounds used there.
  const cameraBox = metadata?.camera_bounds ? getBounds(metadata.camera_bounds) : box;
  cameraBox.getCenter(domainCenter);
  const cameraSize = cameraBox.getSize(new THREE.Vector3());
  const domainSize = Math.max(cameraSize.x, cameraSize.y, cameraSize.z);
  const offset = 1.3 * domainSize;
  initialCameraDistance = Math.sqrt(3) * offset;
  initialCameraPosition.copy(domainCenter).addScaledVector(RESET_VIEW_DIRECTION, initialCameraDistance);
  const distance = initialCameraDistance;
  camera.near = domainDiagonal / 1000;
  camera.far = distance + domainDiagonal * 30;
  camera.updateProjectionMatrix();
  controls.minDistance = domainDiagonal * .08;
  controls.maxDistance = Math.max(domainDiagonal * 8, distance * 2);
  controls.cursor.copy(domainCenter);
  controls.maxTargetRadius = domainDiagonal * .5;
  resetView();
  $("domain-toggle").disabled = false;
  $("reset-view").disabled = false;
}
function resetView() {
  if (!camera) return;
  // Restore position, target and up together, including after rotation or pan.
  initialCameraPosition.copy(domainCenter).addScaledVector(RESET_VIEW_DIRECTION, initialCameraDistance);
  camera.up.set(0, 1, 0);
  camera.position.copy(initialCameraPosition);
  camera.lookAt(domainCenter);
  // Recreate controls to clear the previous up axis and residual damping.
  configureControls(domainCenter);
  const distance = initialCameraDistance;
  controls.minDistance = domainDiagonal * .08;
  controls.maxDistance = Math.max(domainDiagonal * 8, distance * 2);
  controls.maxTargetRadius = domainDiagonal * .5;
  controls.update();
  controls.saveState();
  drawAxisIndicator();
}
function materialFor(surface) {
  // ParaView JSON colors use sRGB; Three.js stores material colors in linear RGB.
  const color = new THREE.Color().setRGB(...surface.color_rgb, THREE.SRGBColorSpace);
  const translucent = surface.opacity < 1;
  return new THREE.MeshPhongMaterial({
    color, shininess: 12, specular: 0x111111,
    side: THREE.DoubleSide, transparent: translucent,
    opacity: surface.opacity, depthWrite: !translucent, forceSinglePass: true,
  });
}
function drawColorbar(samples) {
  const canvas = $("colorbar"), ctx = canvas.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, 0);
  for (const sample of samples) {
    if (sample.value < 0 || sample.value > 6) continue;
    const rgb = sample.rgb.map(c => Math.round(c * 255));
    gradient.addColorStop(sample.value / 6, `rgb(${rgb.join(",")})`);
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}
function buildSurfaceControls(surfaces) {
  const container = $("surface-controls");
  container.replaceChildren();
  for (const value of ISO_VALUES) {
    const surface = surfaces.find(s => s.iso_value === value);
    const available = meshes.has(value);
    const row = document.createElement("label");
    row.className = "surface-row" + (available ? "" : " unavailable");
    const choice = document.createElement("span");
    choice.className = "surface-choice";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = available;
    checkbox.disabled = !available;
    checkbox.setAttribute("aria-label", `磁気エネルギー ${value} の等値面を表示`);
    checkbox.addEventListener("change", () => {
      meshes.get(value).visible = checkbox.checked;
      updateStatus();
    });
    checkboxes.set(value, checkbox);
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.backgroundColor = `rgb(${surface.color_rgb.map(c => Math.round(c * 255)).join(",")})`;
    swatch.setAttribute("aria-hidden", "true");
    const number = document.createElement("span");
    number.textContent = value;
    choice.append(checkbox, swatch, number);
    const alpha = document.createElement("span");
    alpha.className = "alpha";
    alpha.textContent = available ? surface.opacity.toFixed(4) : "等値面なし";
    row.append(choice, alpha);
    container.append(row);
  }
  $("show-all").disabled = false;
  $("hide-all").disabled = false;
}
function updateStatus() {
  const visible = [...meshes.values()].filter(mesh => mesh.visible).length;
  const totalTriangles = [...meshes.values()].filter(mesh => mesh.visible).reduce((total, mesh) => {
    return total + (mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.attributes.position.count) / 3;
  }, 0);
  $("load-status").textContent = `${visible} / ${meshes.size} 等値面 · ${Math.round(totalTriangles).toLocaleString()} 三角形`;
}
function setAllVisible(visible) {
  for (const [value, mesh] of meshes) {
    mesh.visible = visible;
    checkboxes.get(value).checked = visible;
  }
  updateStatus();
}
function openMenu() {
  drawer.inert = false;
  drawer.classList.add("open"); backdrop.classList.add("open");
  drawer.setAttribute("aria-hidden", "false"); menuButton.setAttribute("aria-expanded", "true");
  $("close-menu").focus();
}
function closeMenu() {
  drawer.classList.remove("open"); backdrop.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true"); menuButton.setAttribute("aria-expanded", "false");
  menuButton.focus();
  drawer.inert = true;
}
menuButton.addEventListener("click", openMenu);
$("close-menu").addEventListener("click", closeMenu);
backdrop.addEventListener("click", closeMenu);
document.addEventListener("keydown", event => {
  if (!drawer.classList.contains("open")) return;
  if (event.key === "Escape") { closeMenu(); return; }
  if (event.key === "Tab") {
    const focusable = [...drawer.querySelectorAll("button:not(:disabled), input:not(:disabled)")];
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
$("reset-view").addEventListener("click", resetView);
$("show-all").addEventListener("click", () => setAllVisible(true));
$("hide-all").addEventListener("click", () => setAllVisible(false));
$("domain-toggle").addEventListener("change", event => {
  if (domainOutline) domainOutline.visible = event.target.checked;
});

async function main() {
  if (location.protocol === "file:") {
    throw new Error("index.html を直接開かず、webフォルダで python3 -m http.server 8000 を実行して http://localhost:8000/ を開いてください。");
  }
  progress("表示設定を読み込んでいます…", "scene.json");
  metadata = validateMetadata(await fetchJSON("./scene.json"));
  const bounds = metadata.bounds || await fetchJSON("./bounds.json");
  initRenderer();
  setDomain(getBounds(bounds));
  drawColorbar(metadata.color_map.samples);
  const dims = metadata.grid_sampling?.sampled_dimensions;
  $("grid-label").textContent = Array.isArray(dims) && dims.length === 3 ? dims.join(" × ") : "未記録";
  $("snapshot-label").textContent = metadata.input_file?.split("/").pop() || "Snapshot 100";
  let loaded = 0;
  for (const value of ISO_VALUES) {
    const surface = metadata.surfaces.find(s => s.iso_value === value);
    if (surface.file === null) continue;
    progress(`等値面を読み込んでいます…（${loaded + 1} / 6）`, surface.file);
    let geometry;
    try { geometry = await plyLoader.loadAsync("./" + surface.file); }
    catch { throw new Error(`${surface.file} を読み込めません。meshesフォルダのファイル名と配置を確認してください。`); }
    if (!geometry.attributes.position || geometry.attributes.position.count === 0) {
      geometry.dispose();
      throw new Error(`${surface.file} に頂点がありません。`);
    }
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, materialFor(surface));
    mesh.name = `magnetic_energy_iso_${value}`;
    meshes.set(value, mesh);
    scene.add(mesh);
    loaded++;
    // Give the browser a chance to show progress between meshes.
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
  if (!meshes.size) throw new Error("このスナップショットには、しきい値1〜6の等値面がありません。");
  buildSurfaceControls(metadata.surfaces);
  updateStatus();
  loading.classList.add("hidden");

  const context = document.modelContext;
  if (context?.registerTool) {
    const lifecycle = new AbortController();
    const tools = [{
      name: "get_magnetic_energy_view",
      title: "表示中の等値面を確認",
      description: "現在読み込まれている磁気エネルギーの等値面と、その色・透明度・表示状態を返す。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: () => ({ surfaces: [...meshes.entries()].map(([value, mesh]) => ({
        iso_value: value, visible: mesh.visible, opacity: mesh.material.opacity
      })) })
    }, {
      name: "set_magnetic_energy_surfaces",
      title: "表示する等値面を設定",
      description: "指定した値の等値面を表示し、ほかの等値面を非表示にする。",
      inputSchema: { type: "object", properties: {
        visible_values: { type: "array", items: { type: "integer", enum: ISO_VALUES }, uniqueItems: true }
      }, required: ["visible_values"], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: input => {
        if (!input || !Array.isArray(input.visible_values)
            || !input.visible_values.every(value => meshes.has(value))
            || new Set(input.visible_values).size !== input.visible_values.length) {
          throw new Error("読み込まれている等値面の値を、重複のない配列で指定してください。");
        }
        const selected = new Set(input.visible_values);
        for (const [value, mesh] of meshes) {
          mesh.visible = selected.has(value);
          checkboxes.get(value).checked = mesh.visible;
        }
        updateStatus();
        return { visible_values: [...selected] };
      }
    }];
    for (const tool of tools) {
      try { Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(console.warn); }
      catch (error) { console.warn(error); }
    }
    window.addEventListener("pagehide", () => lifecycle.abort(), { once: true });
  }
}
main().catch(showError);
