import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const $ = id => document.getElementById(id);
const host = $('viewer');
const isMobile = matchMedia('(pointer: coarse)').matches;
let renderer, scene, camera, controls, material, volume, outline, metadata;
let busy = false, framePending = false, settleTimer;
let center = new THREE.Vector3(), diagonal = 1, initialDistance = 1;
const renderSize = new THREE.Vector2();

// Data3DTexture contains a scalar, not precolored geometry. Each ray integrates
// color and piecewise-linear opacity front-to-back through the entire volume.
const vertexShader = `
precision highp float;
uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
out vec3 vWorld;
void main() {
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const fragmentShader = `
precision highp float;
precision highp sampler3D;
uniform sampler3D uVolume;
uniform sampler2D uColors;
uniform vec3 uEye;
uniform vec3 uMin;
uniform vec3 uMax;
uniform vec3 uDimensions;
uniform float uValueMax;
uniform float uColorMin;
uniform float uColorMax;
uniform float uOpacityScale;
uniform float uOpacityValues[32];
uniform int uOpacityCount;
uniform float uUnitDistance;
uniform int uSteps;
in vec3 vWorld;
out vec4 outColor;

vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 toSRGB(vec3 c) {
  return mix(12.92 * c, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
             step(vec3(0.0031308), c));
}
float opacityAt(float value) {
  // Equally spaced nodes with midpoint=0.5 and sharpness=0.0, as in ParaView.
  float position = clamp(value / uOpacityScale, 0.0, 1.0) * float(uOpacityCount - 1);
  int left = int(floor(position));
  int right = min(left + 1, uOpacityCount - 1);
  return mix(uOpacityValues[left], uOpacityValues[right], fract(position));
}
void main() {
  vec3 direction = normalize(vWorld - uEye);
  // Avoid division by zero for rays parallel to a box face.
  vec3 safe = mix(vec3(1e-8), vec3(-1e-8), lessThan(direction, vec3(0.0)));
  vec3 d = mix(safe, direction, greaterThan(abs(direction), vec3(1e-8)));
  vec3 t0 = (uMin - uEye) / d;
  vec3 t1 = (uMax - uEye) / d;
  vec3 lo = min(t0, t1), hi = max(t0, t1);
  float entry = max(0.0, max(lo.x, max(lo.y, lo.z)));
  float exitPoint = min(hi.x, min(hi.y, hi.z));
  if (exitPoint <= entry) discard;
  float stepLength = (exitPoint - entry) / float(uSteps);
  vec4 accumulated = vec4(0.0);
  for (int i = 0; i < 256; ++i) {
    if (i >= uSteps) break;
    vec3 p = uEye + direction * (entry + (float(i) + 0.5) * stepLength);
    vec3 uvw = clamp((p - uMin) / (uMax - uMin), 0.0, 1.0);
    // Point-grid endpoints map to the centers of the first/last texture texels.
    uvw = (uvw * (uDimensions - 1.0) + 0.5) / uDimensions;
    float value = texture(uVolume, uvw).r * uValueMax;
    float baseAlpha = opacityAt(value);
    if (baseAlpha > 0.0) {
      float alpha = baseAlpha >= 1.0 ? 1.0 : 1.0 - pow(1.0 - baseAlpha, stepLength / uUnitDistance);
      float normalizedColor = clamp((value - uColorMin) / (uColorMax - uColorMin), 0.0, 1.0);
      // The LUT has 257 samples, including both endpoints.
      float colorUV = (normalizedColor * 256.0 + 0.5) / 257.0;
      vec3 rgb = toLinear(texture(uColors, vec2(colorUV, 0.5)).rgb);
      accumulated.rgb += (1.0 - accumulated.a) * alpha * rgb;
      accumulated.a += (1.0 - accumulated.a) * alpha;
      // Remaining contribution is at most 0.5% once this ray is opaque.
      if (accumulated.a >= 0.995) break;
    }
  }
  if (accumulated.a <= 0.0) discard;
  outColor = vec4(toSRGB(accumulated.rgb / accumulated.a), accumulated.a);
}`;

function showError(error) {
  console.error(error);
  $('message').textContent = error.message || String(error);
  $('retry').hidden = false;
  $('loading').hidden = false;
}
async function getJSON(path) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Cannot load ${path} (HTTP ${response.status}).`);
  return response.json();
}
function validate(data) {
  if (data.format !== 'mhd-volume-v1') throw new Error('This viewer requires volume.json from the volume exporter.');
  if (!Array.isArray(data.bounds) || data.bounds.length !== 6 || !data.bounds.every(Number.isFinite)
    || [0, 2, 4].some(i => data.bounds[i+1] <= data.bounds[i])) throw new Error('Invalid volume bounds.');
  if (!Array.isArray(data.display_range) || data.display_range[0] !== 0 || !(data.display_range[1] > 0)) throw new Error('Invalid scalar range.');
  if (data.encoding?.type !== 'uint8' || data.encoding.order !== 'x-fastest') throw new Error('Unsupported volume encoding.');
  const colorRange = data.color_map?.range;
  if (!Array.isArray(colorRange) || colorRange.length !== 2 || !colorRange.every(Number.isFinite)
    || colorRange[1] <= colorRange[0]) throw new Error('Invalid color range: maximum must exceed minimum.');
  const [colorMin, colorMax] = colorRange;
  const colorTolerance = 1e-8 * Math.max(1, Math.abs(colorMin), Math.abs(colorMax));
  if (data.color_map.preset !== 'Rainbow Uniform'
    || data.color_map.samples?.length !== 257 || !data.color_map.samples.every((s, i) =>
      Number.isFinite(s.value) && Math.abs(s.value - (colorMin + i * (colorMax - colorMin) / 256)) < colorTolerance
      && Array.isArray(s.rgb) && s.rgb.length === 3 && s.rgb.every(c => Number.isFinite(c) && c >= 0 && c <= 1))) throw new Error('Invalid color samples.');
  if (!Number.isFinite(data.opacity?.scale) || data.opacity.scale <= 0
    || !Number.isFinite(data.opacity.unit_distance) || data.opacity.unit_distance <= 0) throw new Error('Invalid opacity settings.');
  const opacityScale = data.opacity.scale;
  const opacityTolerance = 1e-8 * Math.max(1, opacityScale);
  const points = data.opacity.points;
  if (data.opacity.interpolation !== 'linear' || data.opacity.clamping !== true
    || !Array.isArray(points) || points.length < 2 || points.length > 32
    || !points.every((p, i) => Number.isFinite(p.value) && Math.abs(p.value - i * opacityScale / (points.length - 1)) < opacityTolerance
      && Number.isFinite(p.opacity) && p.opacity >= 0 && p.opacity <= 1
      && p.midpoint === 0.5 && p.sharpness === 0)
    || points[0].opacity !== 0 || points.at(-1).opacity !== 1) {
    throw new Error('Linear opacity control points are missing or invalid. Regenerate volume.json using the updated exporter.');
  }
  if (!Array.isArray(data.levels) || data.levels.length !== 1 || data.levels[0].id !== 'standard') {
    throw new Error('This viewer requires a single 128 × 64 × 64 dataset. Regenerate volume.json using the updated exporter.');
  }
  for (const level of data.levels) {
    if (!Array.isArray(level.dimensions) || level.dimensions.length !== 3 || !level.dimensions.every(n => Number.isInteger(n) && n >= 2 && n <= 256)
      || !/^volume\/[a-zA-Z0-9_-]+\.bin$/.test(level.file) || level.gzip_file !== level.file + '.gz') throw new Error('Invalid volume data path or dimensions.');
  }
  return data;
}

function setRenderQuality() {
  if (!renderer) return;
  const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
  // Never use the phone's 2x/3x device pixel ratio for ray casting.
  const cap = isMobile ? 800 : 1100;
  const scale = Math.min(1, cap / Math.max(width, height)) * (busy ? 0.6 : 1);
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  renderer.getSize(renderSize);
  if (renderSize.x !== w || renderSize.y !== h) renderer.setSize(w, h, false);
  // All devices load the same grid; only ray steps adapt to the device.
  const stationary = isMobile ? 128 : 192;
  if (material) material.uniforms.uSteps.value = busy ? 64 : stationary;
}
function scheduleRender() {
  if (!renderer || framePending) return;
  framePending = true;
  requestAnimationFrame(() => {
    framePending = false;
    if (document.hidden) return;
    setRenderQuality();
    if (material) material.uniforms.uEye.value.copy(camera.position);
    renderer.render(scene, camera);
  });
}
function initScene() {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
  if (!context) throw new Error('WebGL2 is unavailable. Try an up-to-date browser with hardware acceleration enabled.');
  renderer = new THREE.WebGLRenderer({ canvas, context, antialias: false });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 1);
  renderer.toneMapping = THREE.NoToneMapping;
  canvas.setAttribute('aria-label', 'Drag to rotate and pinch to zoom');
  canvas.tabIndex = 0;
  host.appendChild(canvas);
  scene = new THREE.Scene();
  const b = metadata.bounds;
  const min = new THREE.Vector3(b[0], b[2], b[4]), max = new THREE.Vector3(b[1], b[3], b[5]);
  const box = new THREE.Box3(min, max), size = box.getSize(new THREE.Vector3());
  box.getCenter(center); diagonal = size.length();
  initialDistance = Math.sqrt(3) * 1.3 * Math.max(size.x, size.y, size.z);
  camera = new THREE.PerspectiveCamera(30, host.clientWidth / host.clientHeight, diagonal / 1000, initialDistance + diagonal * 30);
  camera.up.set(0, 1, 0);
  camera.position.copy(center).addScaledVector(new THREE.Vector3(1,1,1).normalize(), initialDistance);
  camera.lookAt(center);
  outline = new THREE.Box3Helper(box, 0x657182);
  scene.add(outline);
  const lut = new Uint8Array(257 * 4);
  metadata.color_map.samples.forEach((sample, i) => {
    sample.rgb.forEach((value, c) => { lut[4*i+c] = Math.round(value * 255); });
    lut[4*i+3] = 255;
  });
  const colors = new THREE.DataTexture(lut, 257, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  colors.minFilter = colors.magFilter = THREE.LinearFilter;
  colors.generateMipmaps = false;
  colors.colorSpace = THREE.NoColorSpace;
  colors.needsUpdate = true;
  const opacityValues = new Float32Array(32);
  metadata.opacity.points.forEach((point, i) => { opacityValues[i] = point.opacity; });
  material = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader, fragmentShader,
    transparent: true, side: THREE.BackSide, depthWrite: false, toneMapped: false,
    uniforms: { uVolume: { value: null }, uColors: { value: colors }, uEye: { value: camera.position.clone() },
      uMin: { value: min }, uMax: { value: max }, uDimensions: { value: new THREE.Vector3(2,2,2) },
      uValueMax: { value: metadata.display_range[1] },
      uColorMin: { value: metadata.color_map.range[0] }, uColorMax: { value: metadata.color_map.range[1] },
      uOpacityScale: { value: metadata.opacity.scale },
      uOpacityValues: { value: opacityValues }, uOpacityCount: { value: metadata.opacity.points.length },
      uUnitDistance: { value: metadata.opacity.unit_distance }, uSteps: { value: 128 } }
  });
  volume = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), material);
  volume.position.copy(center); volume.visible = false;
  scene.add(volume);
  resetControls();
  canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); showError(new Error('The graphics context was lost. Close other tabs and reload.')); });
  renderer.debug.onShaderError = () => showError(new Error('This device could not compile the volume shader.'));
  window.addEventListener('resize', () => { camera.aspect = host.clientWidth / Math.max(1, host.clientHeight); camera.updateProjectionMatrix(); scheduleRender(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRender(); });
}
function resetControls() {
  if (controls) controls.dispose();
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(center); controls.cursor.copy(center);
  controls.enableDamping = false; // No perpetual animation loop or idle work.
  controls.rotateSpeed = .65; controls.zoomSpeed = .8; controls.panSpeed = .65;
  controls.minDistance = diagonal * .08;
  controls.maxDistance = Math.max(diagonal * 8, initialDistance * 2);
  controls.maxTargetRadius = diagonal * .5;
  controls.touches.ONE = THREE.TOUCH.ROTATE; controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
  controls.addEventListener('start', () => { clearTimeout(settleTimer); busy = true; scheduleRender(); });
  controls.addEventListener('change', scheduleRender);
  controls.addEventListener('end', () => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { busy = false; scheduleRender(); }, 150);
  });
  controls.update(); controls.saveState();
}
function resetView() {
  if (!camera) return;
  clearTimeout(settleTimer); busy = false;
  camera.up.set(0,1,0);
  camera.position.copy(center).addScaledVector(new THREE.Vector3(1,1,1).normalize(), initialDistance);
  camera.lookAt(center);
  resetControls(); scheduleRender();
}
async function loadBytes(level) {
  const supportsGzip = typeof DecompressionStream === 'function';
  let compressedFile = supportsGzip;
  let response = await fetch(supportsGzip ? level.gzip_file : level.file);
  if (!response.ok && supportsGzip) {
    response = await fetch(level.file);
    compressedFile = false;
  }
  if (!response.ok) throw new Error(`Cannot load volume data (HTTP ${response.status}).`);
  let bytes = new Uint8Array(await response.arrayBuffer());
  // Some hosts transparently decompress Content-Encoding:gzip already.
  const decodedByHTTP = /gzip/i.test(response.headers.get('content-encoding') || '');
  if (compressedFile && !decodedByHTTP && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (!supportsGzip) throw new Error('Compressed data is unsupported in this browser.');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const expected = level.dimensions.reduce((a,b) => a*b, 1);
  if (bytes.length !== expected) throw new Error(`Incorrect volume length: expected ${expected}, received ${bytes.length}.`);
  return bytes;
}
async function loadVolume() {
  const level = metadata.levels[0];
  const maximum = renderer.getContext().getParameter(renderer.getContext().MAX_3D_TEXTURE_SIZE);
  if (Math.max(...level.dimensions) > maximum) throw new Error('This volume exceeds the device texture limit.');
  $('message').textContent = 'Loading volume…'; $('loading').hidden = false;
  const bytes = await loadBytes(level);
  const texture = new THREE.Data3DTexture(bytes, ...level.dimensions);
  texture.format = THREE.RedFormat; texture.type = THREE.UnsignedByteType;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.unpackAlignment = 1; texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace; texture.needsUpdate = true;
  const previous = material.uniforms.uVolume.value;
  material.uniforms.uVolume.value = texture;
  material.uniforms.uDimensions.value.set(...level.dimensions);
  volume.visible = true;
  previous?.dispose(); // Keep only the active data texture in GPU memory.
  $('loading').hidden = true;
  scheduleRender();
}
async function main() {
  if (location.protocol === 'file:') throw new Error('Serve this folder using python3 -m http.server 8000, then open http://localhost:8000/.');
  metadata = validate(await getJSON('./volume.json'));
  initScene();
  await loadVolume();
  $('outline').disabled = $('reset').disabled = false;
  $('outline').addEventListener('change', event => { outline.visible = event.target.checked; scheduleRender(); });
  $('reset').addEventListener('click', resetView);
}
main().catch(showError);
