import Matter from 'matter-js';
import { inject, track } from '@vercel/analytics';
import Peer, { type DataConnection, type PeerOptions } from 'peerjs';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import "./style.css";

// Initialize Vercel Analytics with configuration
inject({
  mode: import.meta.env.MODE === 'production' ? 'production' : 'development',
  debug: import.meta.env.MODE !== 'production'
});

type TAnalyticsProps = Record<string, string | number | boolean>;

function trackGameEvent(name: string, props: TAnalyticsProps = {}) {
    try {
        track(name, props);
    } catch {
        // Analytics must never affect gameplay.
    }
}

// --- Physics Setup (Matter.js) ---
const Engine = Matter.Engine;
const Bodies = Matter.Bodies;
const Composite = Matter.Composite;
const Body = Matter.Body;

// Create an engine
const engine = Engine.create();
// Disable global gravity (top-down view)
engine.gravity.y = 0;
engine.gravity.scale = 0;
const clock = new THREE.Clock();

// Increase solver iterations for stability with high speed collisions
engine.positionIterations = 16;
engine.velocityIterations = 16;

// --- Rendering Setup (Three.js) ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

// Orthographic Camera Setup
const aspect = window.innerWidth / window.innerHeight;
const frustumSize = 600; // Controls zoom level (smaller = more zoomed in)
const camera = new THREE.OrthographicCamera(
    frustumSize * aspect / -2,  // left
    frustumSize * aspect / 2,   // right
    frustumSize / 2,            // top
    frustumSize / -2,           // bottom
    0.1,                        // near
    2000                        // far
);
// Position camera for a slanted top-down view
camera.position.set(0, 600, 400);
camera.lookAt(0, 0, 0);
scene.add(camera);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio); // Fix pixelation
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

// --- Orbit Controls ---
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = false;
controls.maxPolarAngle = Math.PI / 2 - 0.1; // Keep floor constraint

const criticalFlashUniforms = {
    uIntensity: { value: 0 },
    uOrigin: { value: new THREE.Vector2(0.5, 0.5) },
    uAspect: { value: window.innerWidth / window.innerHeight }
};

const criticalFlashMaterial = new THREE.ShaderMaterial({
    uniforms: criticalFlashUniforms,
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform float uIntensity;
        uniform vec2 uOrigin;
        uniform float uAspect;
        varying vec2 vUv;

        void main() {
            vec2 p = vec2((vUv.x - uOrigin.x) * uAspect, vUv.y - uOrigin.y);
            float d = length(p);
            float core = pow(smoothstep(0.13, 0.0, d), 0.55) * 1.18;
            float hotEdge = smoothstep(0.2, 0.11, d) * smoothstep(0.045, 0.12, d) * 0.46;
            float halo = pow(smoothstep(1.22, 0.09, d), 2.8) * 0.64;
            float ring = smoothstep(0.43, 0.34, d) * smoothstep(0.27, 0.36, d) * 0.58;
            float outerSnap = smoothstep(0.78, 0.68, d) * smoothstep(0.56, 0.69, d) * 0.2;
            float alpha = clamp((core + halo + ring) * uIntensity, 0.0, 1.0);
            alpha = clamp(alpha + outerSnap * uIntensity, 0.0, 1.0);
            vec3 color = mix(vec3(1.0), vec3(1.0, 0.86, 0.52), smoothstep(0.08, 0.48, d));
            gl_FragColor = vec4(color, alpha);
        }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending
});

const criticalFlashPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), criticalFlashMaterial);
criticalFlashPlane.position.set(0, 0, -10);
criticalFlashPlane.renderOrder = 9999;
criticalFlashPlane.visible = false;
camera.add(criticalFlashPlane);

const criticalFlashState = {
    startedAt: -Infinity,
    duration: 0.17,
    worldPoint: undefined as THREE.Vector3 | undefined
};

const cameraShakeState = {
    startedAt: -Infinity,
    duration: 0.24,
    amplitude: 0,
    seed: 0,
    offset: new THREE.Vector3()
};
const cameraShakeRight = new THREE.Vector3();
const cameraShakeUp = new THREE.Vector3();

function syncCriticalFlashPlaneToCamera() {
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    const viewWidth = (camera.right - camera.left) / camera.zoom;
    const viewHeight = (camera.top - camera.bottom) / camera.zoom;
    const overscan = 1.08;
    criticalFlashUniforms.uAspect.value = viewWidth / viewHeight;
    criticalFlashPlane.scale.set(viewWidth * overscan, viewHeight * overscan, 1);
}

syncCriticalFlashPlaneToCamera();

// --- Launch UI (Slider + Button)
const launchContainer = document.createElement('div');
launchContainer.id = 'launch-container';
document.body.appendChild(launchContainer);


const DEFAULT_LAUNCH_ANGLE = 180;
const TUTORIAL_MIN_AIM_DELTA = 18;
const currentLaunchAngle = { value: DEFAULT_LAUNCH_ANGLE };
let twoPlayerLaunchStep: 'p1' | 'p2' = 'p1';
let twoPlayerLaunchAngles = { p1: DEFAULT_LAUNCH_ANGLE, p2: 0 };
let launchCountdownOverlay: HTMLElement | null = null;
let launchCountdownInterval: number | undefined;
let launchCountdownComplete: (() => void) | null = null;

function getAngleDelta(a: number, b: number) {
    const delta = Math.abs(((a - b + 540) % 360) - 180);
    return delta;
}

// -- Linear Slider --
// -- Pointer Lock Drag Zone --
// -- Pointer Lock Drag Zone (Touch Compatible) --
const dragZone = document.createElement('div');
dragZone.className = 'drag-zone';
dragZone.innerHTML = `
    <svg class="aim-icon aim-icon-left" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M15 5L8 12L15 19" />
    </svg>
    <span class="aim-label">Aim</span>
    <svg class="aim-icon aim-icon-right" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 5L16 12L9 19" />
    </svg>
`;
launchContainer.appendChild(dragZone);

let isAiming = false;
let previousAimX = 0;

dragZone.addEventListener('pointerdown', (e) => {
    isAiming = true;
    previousAimX = e.clientX;
    dragZone.classList.add('active');
    dragZone.setPointerCapture(e.pointerId);

    // Attempt pointer lock only for mouse to allow infinite scrolling feel
    if (e.pointerType === 'mouse') {
        dragZone.requestPointerLock();
    }
});

// Unified pointer move handler
dragZone.addEventListener('pointermove', (e) => {
    if (!isAiming) return;

    // Use movementX if available (mostly mouse with lock), else calculate delta (touch)
    let deltaX = e.movementX;

    // If movementX is unreliable or zero during touch (common), use clientX delta
    // Note: movementX might be 0 on touch, or available in modern browsers. 
    // We check if we are NOT locked, then we MUST use clientX delta.
    if (document.pointerLockElement !== dragZone) {
        deltaX = e.clientX - previousAimX;
        previousAimX = e.clientX;
    }

    // Apply sensitivity
    const sensitivity = 0.5;
    let newAngle = currentLaunchAngle.value + deltaX * sensitivity;

    // Wrap angle 0-360
    if (newAngle >= 360) newAngle -= 360;
    if (newAngle < 0) newAngle += 360;

    currentLaunchAngle.value = newAngle;

    // Update Guide & Visuals
    updateGuide(currentLaunchAngle.value);
});

const endAim = (e: PointerEvent) => {
    if (!isAiming) return;
    isAiming = false;
    dragZone.classList.remove('active');
    dragZone.releasePointerCapture(e.pointerId);
    if (document.exitPointerLock) document.exitPointerLock();
    sendMultiplayerInput({ launchAngle: currentLaunchAngle.value });
    handleTutorialAimComplete();
};

dragZone.addEventListener('pointerup', endAim);
dragZone.addEventListener('pointercancel', endAim);



// Launch Button
const launchBtn = document.createElement('button');
launchBtn.textContent = 'Launch';
launchBtn.className = 'launch-btn';
launchContainer.appendChild(launchBtn);

function syncLaunchSetupUi() {
    if (hasLaunched) return;
    const aimLabel = dragZone.querySelector<HTMLElement>('.aim-label');
    launchBtn.disabled = false;
    if (multiplayer.role !== 'solo') {
        launchBtn.textContent = multiplayer.localReady ? 'Waiting' : 'Ready';
        launchBtn.disabled = multiplayer.localReady;
        if (aimLabel) aimLabel.textContent = 'Aim';
        return;
    }

    const isLocalTwoPlayerSetup = localPlayMode === '2p' && multiplayer.role === 'solo';
    if (isLocalTwoPlayerSetup) {
        launchBtn.textContent = twoPlayerLaunchStep === 'p1' ? 'P1 Ready' : 'P2 Ready';
        if (aimLabel) aimLabel.textContent = twoPlayerLaunchStep === 'p1' ? 'P1 Aim' : 'P2 Aim';
        return;
    }

    launchBtn.textContent = 'Launch';
    if (aimLabel) aimLabel.textContent = 'Aim';
}

function clearLaunchCountdown() {
    launchCountdownOverlay?.remove();
    launchCountdownOverlay = null;
    launchCountdownComplete = null;
    if (launchCountdownInterval !== undefined) {
        window.clearInterval(launchCountdownInterval);
        launchCountdownInterval = undefined;
    }
}


// move the width segment point to make it a chevron
const arrowVertexShader = `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const arrowFragmentShader = `
uniform float uTime;
varying vec2 vUv;

void main() {
    float phase = vUv.x * 6.0 - uTime * 2.0;
    float alpha = fract(phase);
    if (alpha > 0.2) discard;
    gl_FragColor = vec4(vec3(.6), 1);
}
`;

const arrowGeo = new THREE.PlaneGeometry();

const arrowMat = new THREE.ShaderMaterial({
    vertexShader: arrowVertexShader,
    fragmentShader: arrowFragmentShader,
    uniforms: {
        uTime: { value: 0 }
    },
    transparent: true,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending
});


const arrowMesh = new THREE.Mesh(arrowGeo, arrowMat);
scene.add(arrowMesh);

// Helper to update arrow mesh to hug ground


// Replace geometry with custom buffer for easier control
// Replace geometry with custom buffer for easier control
const guideGeo = new THREE.BufferGeometry();
const guideSegs = 20;
// 3 points per step (Left, Center, Right)
const guidePositions = new Float32Array((guideSegs + 1) * 3 * 3);
const guideUvs = new Float32Array((guideSegs + 1) * 3 * 2);
const guideIndices = [];

for (let i = 0; i < guideSegs; i++) {
    // 3 points per row: 0:Left, 1:Center, 2:Right
    const base = 3 * i;
    const next = 3 * (i + 1);

    // Quad 1: Left-Center
    // L, L', C
    guideIndices.push(base, next, base + 1);
    // C, L', C'
    guideIndices.push(base + 1, next, next + 1);

    // Quad 2: Center-Right
    // C, C', R
    guideIndices.push(base + 1, next + 1, base + 2);
    // R, C', R'
    guideIndices.push(base + 2, next + 1, next + 2);
}

guideGeo.setIndex(guideIndices);
guideGeo.setAttribute('position', new THREE.BufferAttribute(guidePositions, 3));
guideGeo.setAttribute('uv', new THREE.BufferAttribute(guideUvs, 2));

const guideMesh = new THREE.Mesh(guideGeo, arrowMat);
guideMesh.frustumCulled = false; // Always render
scene.add(guideMesh);
scene.remove(arrowMesh); // Remove the temp plane one

function updateGuide(angleDeg: number) {
    const guideEntity = localPlayMode === '2p' && !hasLaunched && twoPlayerLaunchStep === 'p2' ? enemy : player;
    if (!guideEntity) return;

    const angleRad = (angleDeg * Math.PI) / 180;
    const dirX = Math.cos(angleRad);
    const dirZ = Math.sin(angleRad);
    const perpX = -dirZ;
    const perpZ = dirX;

    const len = 80;
    const width = 15; // Slightly wider for chevron
    const chevronOffset = 5; // How much the center sticks out

    const posAttr = guideGeo.attributes.position;
    const uvAttr = guideGeo.attributes.uv;

    const startX = guideEntity.mesh.position.x;
    const startZ = guideEntity.mesh.position.z;

    for (let i = 0; i <= guideSegs; i++) {
        const t = i / guideSegs;
        const dist = t * len;

        // Base center point on the line
        const bx = startX + dirX * dist;
        const bz = startZ + dirZ * dist;

        // Center Point (Pushed forward for V-shape)
        // Actually, "V" usually points forward. So center is LEADING.
        // If center is at 'dist + offset', edges are at 'dist'.
        // BUT, visually a chevron usually looks like this: >
        // So center is further along X than edges.
        const cx = bx + dirX * chevronOffset;
        const cz = bz + dirZ * chevronOffset;
        const cy = getArenaHeight(cx, cz) + 2;

        // Left Point (Edges trail behind center)
        const lx = bx + perpX * width * 0.5;
        const lz = bz + perpZ * width * 0.5;
        const ly = getArenaHeight(lx, lz) + 2;

        // Right Point
        const rx = bx - perpX * width * 0.5;
        const rz = bz - perpZ * width * 0.5;
        const ry = getArenaHeight(rx, rz) + 2;

        // Indices: 3*i, 3*i+1, 3*i+2
        posAttr.setXYZ(3 * i, lx, ly, lz);     // Left
        posAttr.setXYZ(3 * i + 1, cx, cy, cz); // Center
        posAttr.setXYZ(3 * i + 2, rx, ry, rz); // Right

        // UVs
        // Center V=0.5, Left V=0, Right V=1
        uvAttr.setXY(3 * i, t, 0);
        uvAttr.setXY(3 * i + 1, t, 0.5);
        uvAttr.setXY(3 * i + 2, t, 1);
    }

    posAttr.needsUpdate = true;
    uvAttr.needsUpdate = true;
}

// --- Game Constants ---
const ARENA_RADIUS = 300;
const BEYBLADE_RADIUS = 30; // Physics radius
const FORCE_CONSTANT = 0.00002;

// Helper function for Bowl Shape
// y = (r / R)^2 * MaxH
const BOWL_MAX_HEIGHT = 50;
function getArenaHeight(x: number, z: number): number {
    const dist = Math.sqrt(x * x + z * z);
    // Clamp to radius
    if (dist > ARENA_RADIUS) return BOWL_MAX_HEIGHT;
    return Math.pow(dist / ARENA_RADIUS, 2) * BOWL_MAX_HEIGHT;
}

// Get normal vector at position for tilt
function getArenaNormal(x: number, z: number): THREE.Vector3 {
    // Derivative of y = k * (x^2 + z^2) where k = MaxH / R^2
    const k = BOWL_MAX_HEIGHT / (ARENA_RADIUS * ARENA_RADIUS);
    const slopeX = 2 * k * x;
    const slopeZ = 2 * k * z;
    // Normal is (-slopeX, 1, -slopeZ)
    return new THREE.Vector3(-slopeX, 1, -slopeZ).normalize();
}

// Physics Walls (Matter.js) - Keep as is
function createCircularWall(x: number, y: number, radius: number, segments: number, thickness: number) {
    const walls: Matter.Body[] = [];
    const angleStep = (Math.PI * 2) / segments;

    for (let i = 0; i < segments; i++) {
        const angle = i * angleStep;
        const cx = x + Math.cos(angle) * radius;
        const cy = y + Math.sin(angle) * radius;

        // Adjust width to cover the arc (slight overlap)
        const wallWidth = 2 * radius * Math.tan(Math.PI / segments) * 1.1;
        const wall = Bodies.rectangle(cx, cy, wallWidth, thickness, {
            isStatic: true,
            angle: angle + Math.PI / 2,
            label: 'Wall'
        });

        walls.push(wall);
    }
    return walls;
}

// Create physics walls centered at 0,0
const walls = createCircularWall(0, 0, ARENA_RADIUS, 32, 20);
Composite.add(engine.world, walls);

// Visual Arena (Three.js)
const arenaGroup = new THREE.Group();
scene.add(arenaGroup);

function createWrappedArenaPlane(radius: number, radialSegments: number, angularSegments: number) {
    const positions: number[] = [];
    const indices: number[] = [];
    const uvs: number[] = [];

    for (let rIndex = 0; rIndex <= radialSegments; rIndex++) {
        const r = (rIndex / radialSegments) * radius;
        for (let aIndex = 0; aIndex <= angularSegments; aIndex++) {
            const angle = (aIndex / angularSegments) * Math.PI * 2;
            const x = Math.cos(angle) * r;
            const z = Math.sin(angle) * r;
            positions.push(x, getArenaHeight(x, z) + 0.35, z);
            uvs.push(0.5 + x / (radius * 2), 0.5 + z / (radius * 2));
        }
    }

    const rowSize = angularSegments + 1;
    for (let rIndex = 0; rIndex < radialSegments; rIndex++) {
        for (let aIndex = 0; aIndex < angularSegments; aIndex++) {
            const a = rIndex * rowSize + aIndex;
            const b = a + 1;
            const c = (rIndex + 1) * rowSize + aIndex;
            const d = c + 1;
            indices.push(a, c, b, b, c, d);
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
}

// Bowl Floor (LatheGeometry)
const profilePoints = [];
const segments = 32;
for (let i = 0; i <= segments; i++) {
    const r = (i / segments) * ARENA_RADIUS;
    const h = Math.pow(i / segments, 2) * BOWL_MAX_HEIGHT;
    profilePoints.push(new THREE.Vector2(r, h));
}
// Extend a bit for the rim
profilePoints.push(new THREE.Vector2(ARENA_RADIUS + 10, BOWL_MAX_HEIGHT + 2));
const floorGeometry = new THREE.LatheGeometry(profilePoints, 128); // Increased segments for smoothness
floorGeometry.computeVertexNormals(); // Ensure smooth normals

const floorMaterial = new THREE.MeshBasicMaterial({
    color: 0x333333,
    side: THREE.DoubleSide
});
const floor = new THREE.Mesh(floorGeometry, floorMaterial);
arenaGroup.add(floor);

const arenaPlaneMaterial = new THREE.MeshBasicMaterial({
    color: 0x222222,
    side: THREE.DoubleSide
});
const arenaPlane = new THREE.Mesh(createWrappedArenaPlane(ARENA_RADIUS - 2, 28, 96), arenaPlaneMaterial);
arenaPlane.renderOrder = 1;
arenaGroup.add(arenaPlane);


// Walls Visual (Ring at top)
const wallGeometry = new THREE.RingGeometry(ARENA_RADIUS + 5, ARENA_RADIUS + 10, 100).translate(0, 0, -2);
const wallMaterial = new THREE.MeshBasicMaterial({ color: 0x333333, side: THREE.DoubleSide });
const wallMesh = new THREE.Mesh(wallGeometry, wallMaterial);
wallMesh.rotation.x = Math.PI / 2;
wallMesh.position.y = BOWL_MAX_HEIGHT;
arenaGroup.add(wallMesh);


type TVortexUniforms = {
    uTime: { value: number };
    uDirection: { value: number };
    uIntensity: { value: number };
    uOpacity: { value: number };
    uExpansion: { value: number };
    uTint: { value: THREE.Color };
};

function createBeyVortexMaterial(tint: number): THREE.ShaderMaterial {
    const uniforms: TVortexUniforms = {
        uTime: { value: 0 },
        uDirection: { value: 1 },
        uIntensity: { value: 0.46 },
        uOpacity: { value: 0.035 },
        uExpansion: { value: 1 },
        uTint: { value: new THREE.Color(tint) }
    };

    return new THREE.ShaderMaterial({
        uniforms,
        vertexShader: `
            uniform float uExpansion;
            varying vec2 vUv;
            varying vec3 vNormal;
            varying vec3 vLocalPosition;

            void main() {
                vUv = uv;
                vNormal = normalize(normalMatrix * normal);
                vec3 transformed = position;
                float currentFlare = mix(1.0, 2.0, uv.y);
                float targetFlare = mix(1.0, 1.0 + uExpansion, uv.y);
                transformed.xz *= targetFlare / currentFlare;
                vLocalPosition = transformed;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
            }
        `,
        fragmentShader: `
            uniform float uTime;
            uniform float uDirection;
            uniform float uIntensity;
            uniform float uOpacity;
            uniform vec3 uTint;
            varying vec2 vUv;
            varying vec3 vNormal;
            varying vec3 vLocalPosition;

            void main() {
                float angle = atan(vLocalPosition.z, vLocalPosition.x);
                float lift = vUv.y;
                float outward = lift - uTime * 0.18;
                float diagonal = sin(angle * 4.0 * uDirection + outward * 18.0);
                float crossWave = sin(angle * -7.0 * uDirection + outward * 28.0 - uTime * 0.22);
                float softNoise = sin(angle * 11.0 * uDirection + outward * 9.0);
                float cloud = smoothstep(-0.42, 0.78, diagonal * 0.62 + crossWave * 0.38);
                float ribbons = smoothstep(0.64, 0.98, abs(sin(angle * 3.0 * uDirection + outward * 13.0)));
                cloud = mix(cloud, smoothstep(-0.25, 0.9, softNoise), 0.18);
                float baseFade = smoothstep(0.0, 0.08, lift);
                float topVanish = pow(1.0 - smoothstep(0.36, 1.0, lift), 1.55);
                float verticalFade = baseFade * topVanish;
                float rim = pow(1.0 - abs(dot(normalize(vNormal), vec3(0.0, 0.0, 1.0))), 1.8);
                float pattern = cloud * 0.16 + ribbons * 0.26 + rim * 0.12;
                float alpha = pattern * verticalFade * uIntensity * uOpacity;
                vec3 color = mix(vec3(1.0), uTint, 0.56 + cloud * 0.24);
                gl_FragColor = vec4(color, alpha);
            }
        `,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending
    });
}

function setBeyVortexColor(mesh: THREE.Object3D, color: number) {
    const uniforms = mesh.userData.vortexUniforms as TVortexUniforms | undefined;
    if (uniforms?.uTint.value instanceof THREE.Color) {
        uniforms.uTint.value.setHex(color);
    }
}

function updateBeyVortex(mesh: THREE.Object3D, time: number, speed = 0, rpm = 0, maxRpm = 1000, direction = 1, tint?: number, opacity = 0.035) {
    const uniforms = mesh.userData.vortexUniforms as TVortexUniforms | undefined;
    if (!uniforms) return;
    if (typeof tint === 'number') {
        uniforms.uTint.value.setHex(tint);
    }
    const rpmRatio = THREE.MathUtils.clamp(rpm / Math.max(1, maxRpm), 0, 1);
    uniforms.uTime.value = time;
    uniforms.uDirection.value = direction;
    const opacityValue = THREE.MathUtils.clamp(opacity, 0.015, 0.5);
    uniforms.uExpansion.value = 0.42 + rpmRatio * 0.58 + opacityValue * 0.7;
    const baseIntensity = THREE.MathUtils.clamp(0.24 + speed * 0.014 + rpmRatio * 0.28, 0.24, 0.78);
    uniforms.uIntensity.value = THREE.MathUtils.clamp(baseIntensity, 0.08, 0.9);
    uniforms.uOpacity.value = opacityValue;

    const vortex = mesh.userData.vortex as THREE.Object3D | undefined;
    if (vortex) {
        const lastTime = typeof mesh.userData.vortexLastTime === 'number' ? mesh.userData.vortexLastTime : time;
        const delta = Math.max(0, Math.min(time - lastTime, 0.05));
        const rpmRadiansPerSecond = (Math.max(0, rpm) / 60) * Math.PI * 2;
        mesh.userData.vortexAngle = (mesh.userData.vortexAngle || 0) + rpmRadiansPerSecond * delta * 0.22 * direction;
        mesh.userData.vortexLastTime = time;

        const parentCancel = mesh.quaternion.clone().invert();
        const ownRotation = new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0),
            mesh.userData.vortexAngle
        );
        vortex.quaternion.copy(parentCancel).multiply(ownRotation);
    }
}





// Helper to create Beyblade 3D Model
function createBeybladeMesh(stats: BeybladeStats): { mesh: THREE.Group, tiltGroup: THREE.Group, spinGroup: THREE.Group } {
    enforceBeyColorContrast(stats);

    const mesh = new THREE.Group();
    const tiltGroup = new THREE.Group();
    const spinGroup = new THREE.Group();

    mesh.add(tiltGroup);
    tiltGroup.add(spinGroup);

    const safeFactor = (value: number | undefined, fallback = 1, min = 0.45, max = 1.8) => {
        return THREE.MathUtils.clamp(value ?? fallback, min, max);
    };

    // Apply global scale
    spinGroup.scale.setScalar(safeFactor(stats.beyScale, 1.0, 0.75, 1.35));

    const pm = stats.partMatcaps || {};
    const wheelTex = getMatcapTexture(getContrastMatcapUrl(pm.wheel));
    const ringTex = getMatcapTexture(getContrastMatcapUrl(pm.ring));
    const boltTex = getMatcapTexture(getContrastMatcapUrl(pm.bolt));
    const trackTex = getMatcapTexture(getContrastMatcapUrl(pm.spinTrack));
    const tipTex = getMatcapTexture(getContrastMatcapUrl(pm.tip));

    // Helper: Fake Smooth Normals
    const makeSmooth = (geo: THREE.BufferGeometry) => {
        geo.deleteAttribute('normal'); // Remove existing normals
        geo = BufferGeometryUtils.mergeVertices(geo, 0.1); // Merge close vertices
        geo.computeVertexNormals(); // Recompute purely based on geometry
        return geo;
    };

    // Helper for Rounded Cylinder using ExtrudeGeometry
    const createRoundedCylinder = (radius: number, height: number, bevelSize: number = 0.5) => {
        const shape = new THREE.Shape();
        shape.absarc(0, 0, radius, 0, Math.PI * 2, false);
        const settings = {
            depth: height - (bevelSize * 2), // Adjust depth so total height includes bevel
            bevelEnabled: true,
            bevelThickness: bevelSize,
            bevelSize: bevelSize,
            bevelSegments: 8, // Doubled for smoothness
            curveSegments: 64 // Doubled for smoothness
        };
        const geo = new THREE.ExtrudeGeometry(shape, settings);
        geo.center(); // Center geometry
        return makeSmooth(geo);
    };

    // 1. Metal Wheel (Base) - Rounded
    const wheelWidthFactor = safeFactor(stats.wheelWidthFactor, 1, 0.82, 1.2);
    const wheelHeightFactor = safeFactor(stats.wheelHeightFactor, 1, 0.55, 1.65);
    const wheelRadius = BEYBLADE_RADIUS * wheelWidthFactor;
    const wheelHeight = 5 * wheelHeightFactor;
    const wheelGeo = createRoundedCylinder(wheelRadius, wheelHeight, 0.8);
    const wheelMat = new THREE.MeshMatcapMaterial({
        color: stats.wheelColor || 0x888888,
        matcap: wheelTex
    });
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.position.y = 5;
    wheel.rotation.x = Math.PI / 2; // Extrude creates on XY plane
    spinGroup.add(wheel);

    const vortexMat = createBeyVortexMaterial(stats.trailColor || stats.boltColor || 0xffffff);
    const vortex = new THREE.Mesh(
        new THREE.CylinderGeometry(wheelRadius * 2.0, wheelRadius, 5, 96, 16, true),
        vortexMat
    );
    vortex.name = 'bey-air-vortex';
    vortex.position.y = 7;
    vortex.scale.setScalar(stats.beyScale || 1.0);
    vortex.renderOrder = 4;
    vortex.frustumCulled = false;
    mesh.add(vortex);
    mesh.userData.vortex = vortex;
    mesh.userData.vortexUniforms = vortexMat.uniforms;

    // 2. Clear Wheel / Energy Ring - Rounded
    const ringRadius = wheelRadius * safeFactor(stats.ringRadiusFactor, 0.75, 0.48, 1.02);
    const ringWidthFactor = safeFactor(stats.ringWidthFactor, 1, 0.52, 1.55);
    const ringHeightFactor = safeFactor(stats.ringHeightFactor, 1, 0.48, 1.65);
    const ringDepth = 3 * ringHeightFactor;
    const ringHoleFactor = THREE.MathUtils.clamp(0.7 - (ringWidthFactor - 1) * 0.18, 0.42, 0.82);
    const ringShape = new THREE.Shape();
    ringShape.absarc(0, 0, ringRadius, 0, Math.PI * 2, false);

    // Create hole for ring
    const holePath = new THREE.Path();
    holePath.absarc(0, 0, ringRadius * ringHoleFactor, 0, Math.PI * 2, true);
    ringShape.holes.push(holePath);

    let ringGeo: THREE.BufferGeometry = new THREE.ExtrudeGeometry(ringShape, {
        depth: ringDepth,
        bevelEnabled: true,
        bevelThickness: Math.min(0.65, ringDepth * 0.28),
        bevelSize: Math.min(0.65, ringDepth * 0.28),
        bevelSegments: 4,
        curveSegments: Math.max(8, Math.round(stats.ringSides || 32))
    });
    ringGeo.center();
    ringGeo = makeSmooth(ringGeo);

    const ringMat = new THREE.MeshMatcapMaterial({
        color: stats.ringColor || 0x0088ff,
        matcap: ringTex
    });

    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.y = 8; // Stacked
    ring.rotation.x = Math.PI / 2;
    spinGroup.add(ring);

    // 3. Face Bolt - Hexagon with Bevel
    const boltShape = new THREE.Shape();
    const sides = stats.boltSides || 6;
    const boltWidthFactor = safeFactor(stats.boltWidthFactor, 1, 0.58, 1.55);
    const boltHeightFactor = safeFactor(stats.boltHeightFactor, 1, 0.5, 1.8);
    const boltRadius = 10 * boltWidthFactor;
    const boltDepth = 4 * boltHeightFactor;

    // Draw polygon
    for (let i = 0; i < sides; i++) {
        const theta = (i / sides) * Math.PI * 2;
        const x = Math.cos(theta) * boltRadius;
        const y = Math.sin(theta) * boltRadius;
        if (i === 0) boltShape.moveTo(x, y);
        else boltShape.lineTo(x, y);
    }
    boltShape.closePath();

    let boltGeo: THREE.BufferGeometry = new THREE.ExtrudeGeometry(boltShape, {
        depth: boltDepth,
        bevelEnabled: true,
        bevelThickness: 1,
        bevelSize: 1,
        bevelSegments: 2
    });
    boltGeo.translate(0, 0, -boltDepth / 2);
    boltGeo = makeSmooth(boltGeo);

    const boltMat = new THREE.MeshMatcapMaterial({
        color: stats.boltColor || 0x00ccff,
        matcap: boltTex
    });
    const bolt = new THREE.Mesh(boltGeo, boltMat);
    bolt.position.y = 12; // Top
    bolt.rotation.x = Math.PI / 2;
    spinGroup.add(bolt);

    // 4. Spin Track
    const stSize = safeFactor(stats.spinTrackSize, 1.0, 0.55, 1.5);
    const stHeight = 10 * safeFactor(stats.spinTrackHeightFactor, 1, 0.55, 1.7);
    // Use simple cylinder for stem but rounded for base?
    // Let's stick to Cylinder for the stem part as it's intricate
    let spinTrackGeo: THREE.BufferGeometry = new THREE.CylinderGeometry(BEYBLADE_RADIUS * .3 * stSize, BEYBLADE_RADIUS * .2 * stSize, stHeight, 32);
    spinTrackGeo = makeSmooth(spinTrackGeo);
    const spinTrackMat = new THREE.MeshMatcapMaterial({
        color: stats.spinTrackColor || 0x777777,
        matcap: trackTex
    });
    const spinTrack = new THREE.Mesh(spinTrackGeo, spinTrackMat);
    spinTrack.position.y = -1;
    spinGroup.add(spinTrack);

    // 5. Tip (Driver) - Rounded Tip
    const tSize = safeFactor(stats.tipSize, 1.0, 0.55, 1.5);
    const tipHeight = safeFactor(stats.tipHeightFactor, 1, 0.55, 1.8);
    // Lathe for a smooth tip shape
    const tipPoints = [];
    tipPoints.push(new THREE.Vector2(0, 0)); // Bottom contact point (sharp)
    tipPoints.push(new THREE.Vector2(2 * tSize, 1 * tipHeight));
    tipPoints.push(new THREE.Vector2(5 * tSize, 8 * tipHeight)); // Top wide base
    let tipGeo: THREE.BufferGeometry = new THREE.LatheGeometry(tipPoints, 32); // Smoother tip
    tipGeo = makeSmooth(tipGeo);

    const tipMat = new THREE.MeshMatcapMaterial({
        color: stats.tipColor || 0x888888,
        matcap: tipTex
    });
    const tip = new THREE.Mesh(tipGeo, tipMat);
    tip.position.y = -13;
    spinGroup.add(tip);

    return { mesh, tiltGroup, spinGroup };
}

// Trail System
class TrailSystem {
    mesh: THREE.Mesh;
    positions: number[] = [];
    maxPoints = 50;
    geometry: THREE.BufferGeometry;
    width = 8;

    constructor(color: number, scene: THREE.Scene) {
        this.geometry = new THREE.BufferGeometry();
        const posArray = new Float32Array(this.maxPoints * 2 * 3);
        const alphaArray = new Float32Array(this.maxPoints * 2);
        const indices: number[] = [];

        for (let i = 0; i < this.maxPoints - 1; i++) {
            const a = i * 2;
            const b = a + 1;
            const c = a + 2;
            const d = a + 3;
            indices.push(a, c, b, b, c, d);
        }

        this.geometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
        this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphaArray, 1));
        this.geometry.setIndex(indices);

        const material = new THREE.ShaderMaterial({
            uniforms: {
                uColor: { value: new THREE.Color(color) }
            },
            vertexShader: `
                attribute float aAlpha;
                varying float vAlpha;

                void main() {
                    vAlpha = aAlpha;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform vec3 uColor;
                varying float vAlpha;

                void main() {
                    gl_FragColor = vec4(uColor, vAlpha * 0.62);
                }
            `,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide
        });

        this.mesh = new THREE.Mesh(this.geometry, material);
        this.mesh.frustumCulled = false;
        scene.add(this.mesh);
    }

    setColor(color: number) {
        const material = this.mesh.material as THREE.ShaderMaterial;
        const colorUniform = material.uniforms.uColor;
        if (colorUniform?.value instanceof THREE.Color) {
            colorUniform.value.setHex(color);
        }
    }

    update(x: number, y: number, z: number) {
        this.positions.push(x, y, z);
        if (this.positions.length > this.maxPoints * 3) {
            this.positions.splice(0, 3);
        }

        const positionAttribute = this.geometry.attributes.position as THREE.BufferAttribute;
        const alphaAttribute = this.geometry.attributes.aAlpha as THREE.BufferAttribute;
        const count = this.positions.length / 3;

        for (let i = 0; i < this.maxPoints; i++) {
            const sourceIndex = Math.min(i, Math.max(count - 1, 0));
            const currentX = this.positions[sourceIndex * 3] ?? x;
            const currentY = this.positions[sourceIndex * 3 + 1] ?? y;
            const currentZ = this.positions[sourceIndex * 3 + 2] ?? z;
            const prevIndex = Math.max(sourceIndex - 1, 0);
            const nextIndex = Math.min(sourceIndex + 1, Math.max(count - 1, 0));
            const prevX = this.positions[prevIndex * 3] ?? currentX;
            const prevZ = this.positions[prevIndex * 3 + 2] ?? currentZ;
            const nextX = this.positions[nextIndex * 3] ?? currentX;
            const nextZ = this.positions[nextIndex * 3 + 2] ?? currentZ;
            const dx = nextX - prevX;
            const dz = nextZ - prevZ;
            const length = Math.max(Math.hypot(dx, dz), 0.001);
            const perpX = -dz / length;
            const perpZ = dx / length;
            const t = count > 1 && i < count ? i / (count - 1) : 0;
            const fade = i < count ? Math.pow(t, 1.35) : 0;
            const halfWidth = this.width * (0.18 + fade * 0.82) * 0.5;
            const vertexIndex = i * 2;

            positionAttribute.setXYZ(vertexIndex, currentX + perpX * halfWidth, currentY, currentZ + perpZ * halfWidth);
            positionAttribute.setXYZ(vertexIndex + 1, currentX - perpX * halfWidth, currentY, currentZ - perpZ * halfWidth);
            alphaAttribute.setX(vertexIndex, fade);
            alphaAttribute.setX(vertexIndex + 1, fade);
        }

        positionAttribute.needsUpdate = true;
        alphaAttribute.needsUpdate = true;
    }

    clear() {
        this.positions = [];
        const positionAttribute = this.geometry.attributes.position as THREE.BufferAttribute;
        const alphaAttribute = this.geometry.attributes.aAlpha as THREE.BufferAttribute;
        for (let i = 0; i < this.maxPoints * 2; i++) {
            positionAttribute.setXYZ(i, 0, 0, 0);
            alphaAttribute.setX(i, 0);
        }
        positionAttribute.needsUpdate = true;
        alphaAttribute.needsUpdate = true;
    }
}
// --- Game Logic ---
interface BeybladeStats {
    maxRpm: number;
    atk: number;
    def: number;
    wt: number;
    sta: number;
    spd: number;
    spl: number;
    partMatcaps?: {
        wheel?: string;
        ring?: string;
        bolt?: string;
        spinTrack?: string;
        tip?: string;
    };
    trailColor: number; // New separate trail color
    crtAtk: number; // Critical Damage Value (Guaranteed above threshold)
    crt?: number; // Critical Chance (from pool branch compatibility)
    frictionAir: number;
    restitution: number;
    friction: number;

    densityBase: number;
    radius: number;
    height: number;
    // Arena Forces
    dishForce: number;  // Multiplier for radial force toward center
    curlForce: number;  // Multiplier for tangential clockwise force
    // Visual Stats
    beyScale: number;
    wheelWidthFactor: number;
    wheelHeightFactor: number;
    wheelColor: number;
    ringColor: number;
    ringSides: number;
    ringRadiusFactor: number;
    ringWidthFactor: number;
    ringHeightFactor: number;
    boltColor: number;
    boltSides: number;
    boltWidthFactor: number;
    boltHeightFactor: number;
    spinTrackColor: number;
    spinTrackSize: number;
    spinTrackHeightFactor: number;
    tipColor: number;
    tipSize: number;
    tipHeightFactor: number;
    dragFactor: number;
}

type TMatcapPart = keyof NonNullable<BeybladeStats['partMatcaps']>;
const MATCAP_PART_KEYS: TMatcapPart[] = ['wheel', 'ring', 'bolt', 'spinTrack', 'tip'];

type TLooseBeyPart = {
    object: THREE.Object3D;
    velocity: THREE.Vector3;
    rotationVelocity: THREE.Vector3;
};

interface GameEntity {
    body: Matter.Body;
    mesh: THREE.Object3D;
    tiltGroup: THREE.Group;
    spinGroup: THREE.Group;
    trail: TrailSystem;
    stats?: BeybladeStats;
    currentRpm?: number;
    // Death State
    isDead?: boolean;
    driftVelocity?: THREE.Vector3;
    driftRotation?: THREE.Vector3;
    criticalKo?: boolean;
    looseParts?: TLooseBeyPart[];
}
const entities: GameEntity[] = [];

// Physics Constants
// Physics Constants
const FRICTION_LOW = 0.02;
const FRICTION_HIGH = 0.035; // Controlled grip while diving

const CRIT_SPEED_THRESHOLD = 20;
const BARRIER_DAMAGE = 20; // Self-damage when hitting walls
const DIVE_BOOST_FORCE = 0.00012;

type TCriticalOwner = 'player' | 'enemy';
const criticalStreaks: Record<TCriticalOwner, number> = {
    player: 0,
    enemy: 0
};

type TMatchCounterSide = {
    criticalHits: number;
    wallDings: number;
};

type TMatchCounters = {
    player: TMatchCounterSide;
    enemy: TMatchCounterSide;
};

type TCriticalHitReport = {
    crit: number;
    def: number;
    dmg: number;
    rpmLost: number;
    streak?: number;
};

type TWallHitReport = {
    dmg: number;
    rpmLost: number;
};

const matchCounters: TMatchCounters = {
    player: { criticalHits: 0, wallDings: 0 },
    enemy: { criticalHits: 0, wallDings: 0 }
};

function resetMatchCounters() {
    matchCounters.player.criticalHits = 0;
    matchCounters.player.wallDings = 0;
    matchCounters.enemy.criticalHits = 0;
    matchCounters.enemy.wallDings = 0;
    resetCriticalStreak();
}

function getMatchCounterSide(entity: GameEntity): TMatchCounterSide | null {
    if (entity === player) return matchCounters.player;
    if (entity === enemy) return matchCounters.enemy;
    return null;
}

function getCriticalOwner(entity: GameEntity): TCriticalOwner | null {
    if (entity === player) return 'player';
    if (entity === enemy) return 'enemy';
    return null;
}

function syncCriticalStreakHud() {
    const targets: Array<{ owner: TCriticalOwner; buttonId: string }> = [
        { owner: 'player', buttonId: 'p1-btn' },
        { owner: 'enemy', buttonId: 'cpu-btn' }
    ];

    targets.forEach(({ owner, buttonId }) => {
        const button = document.getElementById(buttonId);
        if (!button) return;
        const active = criticalStreaks[owner] > 0;
        button.classList.toggle('crit-streak-active', active);
        if (active) button.setAttribute('data-crit-streak', `x${criticalStreaks[owner]}`);
        else button.removeAttribute('data-crit-streak');
    });
}

function resetCriticalStreak(owner?: TCriticalOwner | null) {
    if (owner) {
        criticalStreaks[owner] = 0;
        syncCriticalStreakHud();
        return;
    }

    criticalStreaks.player = 0;
    criticalStreaks.enemy = 0;
    syncCriticalStreakHud();
}

function registerCriticalStreak(entity: GameEntity) {
    const owner = getCriticalOwner(entity);
    if (!owner) return 1;

    criticalStreaks[owner] += 1;
    syncCriticalStreakHud();
    return criticalStreaks[owner];
}

function getCriticalStreak(entity: GameEntity) {
    const owner = getCriticalOwner(entity);
    return owner ? criticalStreaks[owner] : 0;
}

function updateCriticalStreakForHit(entity: GameEntity, isCritical: boolean) {
    if (isCritical) return registerCriticalStreak(entity);
    resetCriticalStreak(getCriticalOwner(entity));
    return 0;
}

function getCriticalDamageMultiplier(stats: BeybladeStats) {
    return THREE.MathUtils.clamp(stats.crtAtk / Math.max(1, stats.atk), 1.05, 3);
}

function applyCriticalStreakDamage(baseDamage: number, attacker: GameEntity, streak: number) {
    if (!attacker.stats) return baseDamage;
    return baseDamage * Math.pow(getCriticalDamageMultiplier(attacker.stats), streak);
}



const DISH_LOW = 1.5;
const DISH_HIGH = 6;

const CURL_LOW = 1;
const CURL_HIGH = 90;

// Patterns
interface PhysicsPattern {
    name: string;
    dish: number;
    curl: number;
    drag: number;
}

const PATTERNS: PhysicsPattern[] = [
    { name: 'ORBIT', dish: DISH_LOW, curl: CURL_HIGH, drag: FRICTION_LOW },
    { name: 'DIVE', dish: DISH_HIGH, curl: CURL_LOW, drag: FRICTION_HIGH },
];

let currentPatternIndex = 0;
let cpuPatternIndex = 0;
let localDiveIntent = 0;
let cpuDiveIntent = 0;
let cpuLastWallHitAt = -Infinity;
let cpuHardAiLastReason = 'idle';

type TGameSpeedId = 'tutorial' | 'normal' | 'insane';

const GAME_SPEEDS: Record<TGameSpeedId, { label: string, multiplier: number, copy: string }> = {
    tutorial: { label: 'Tutorial', multiplier: 0.25, copy: 'Slow lesson pace' },
    normal: { label: 'Normal', multiplier: 0.5, copy: 'Standard match speed' },
    insane: { label: 'Insane', multiplier: 0.75, copy: 'Maximum impact speed' }
};

function isGameSpeedId(value: string | null): value is TGameSpeedId {
    return value === 'tutorial' || value === 'normal' || value === 'insane';
}

function normalizeGameSpeedId(value: string | null): TGameSpeedId {
    if (isGameSpeedId(value)) return value;
    if (value === 'speed2') return 'insane';
    return 'normal';
}

const savedGameSpeed = localStorage.getItem('bblade_game_speed') || 'normal';
const savedMasterVolume = Number(localStorage.getItem('bblade_master_volume'));
let currentGameSpeed: TGameSpeedId = normalizeGameSpeedId(savedGameSpeed);
let masterVolume = Number.isFinite(savedMasterVolume) ? THREE.MathUtils.clamp(savedMasterVolume, 0, 1) : 0.72;
let flashesEnabled = localStorage.getItem('bblade_flashes_enabled') !== 'false';
let cameraShakeEnabled = localStorage.getItem('bblade_camera_shake_enabled') !== 'false';
let cpuNextDiveSwitchAt = 0;
let finishSlowMoUntil = 0;
let pendingKoBlankTimeout: number | null = null;
let pendingWinnerTimeout: number | null = null;
let activeKoBlankOverlay: HTMLElement | null = null;
const KO_FINISH_DURATION_SECONDS = 3;
const KO_WINNER_BLANK_SECONDS = 2;
const KO_FINISH_DRIFT_SCALE = 0.08;
const KO_FINISH_ROTATION_SCALE = 0.18;

declare global {
    interface Window {
        BBLADE_ICE_SERVERS?: RTCIceServer[];
        BBLADE_RTC_CONFIG?: RTCConfiguration;
        BBLADE_PEERJS_OPTIONS?: Record<string, unknown>;
        GLOBAL_ICE_SERVERS?: RTCIceServer[];
        __ICE_SERVERS__?: RTCIceServer[];
    }
}

type TMultiplayerRole = 'solo' | 'host' | 'guest';
type TMultiplayerStatus = 'Offline' | 'Hosting' | 'Joining' | 'Connected' | 'Disconnected' | 'Error';
type TLocalPlayMode = '1p-easy' | '1p-hard' | '2p';
type TDiveAction = 'dive_on' | 'dive_off';
type TScheduledDiveEvent = {
    id: string;
    side: 'player' | 'enemy';
    action: TDiveAction;
    applyAt: number;
};
type TBodyStateSnapshot = {
    x: number;
    y: number;
    vx: number;
    vy: number;
    angle: number;
    angularVelocity: number;
    rpm: number;
};
type TMultiplayerMessage =
    | { type: 'hello'; stats: BeybladeStats; name: string }
    | { type: 'stats'; stats: BeybladeStats }
    | { type: 'speed'; speed: TGameSpeedId }
    | { type: 'ready'; launchAngle: number; stats: BeybladeStats }
    | { type: 'dive'; id: string; action: TDiveAction; applyAt: number }
    | { type: 'state'; matchTime: number; player: TBodyStateSnapshot; enemy: TBodyStateSnapshot }
    | { type: 'input'; launchAngle?: number; launch?: boolean; pattern?: number; stats?: BeybladeStats }
    | { type: 'reset' };

const MULTIPLAYER_INPUT_DELAY_SECONDS = 0.2;
const MULTIPLAYER_STATE_SYNC_INTERVAL_SECONDS = 0.1;
const MULTIPLAYER_STATE_SYNC_CHANCE = 0.5;

const multiplayer = {
    role: 'solo' as TMultiplayerRole,
    status: 'Offline' as TMultiplayerStatus,
    peer: null as Peer | null,
    conn: null as DataConnection | null,
    peerId: '',
    joinLink: '',
    localReady: false,
    remoteReady: false,
    localLaunchAngle: DEFAULT_LAUNCH_ANGLE,
    remoteLaunchAngle: DEFAULT_LAUNCH_ANGLE,
    remoteLaunchRequested: false,
    matchTime: 0,
    nextStateSyncAt: MULTIPLAYER_STATE_SYNC_INTERVAL_SECONDS,
    diveEventSeq: 0,
    diveQueue: [] as TScheduledDiveEvent[],
    processedDiveEventIds: new Set<string>(),
    analyticsConnectedTracked: false
};
let localPlayMode: TLocalPlayMode = '1p-easy';

// --- Matcap Resources ---
const ALLOWED_MATCAP_URLS = [
    'https://raw.githubusercontent.com/nidorx/matcaps/master/128/28292A_D3DAE5_A3ACB8_818183-128px.png',
    'https://raw.githubusercontent.com/nidorx/matcaps/master/128/2A2A2A_B3B3B3_6D6D6D_848C8C-128px.png',
    'https://raw.githubusercontent.com/nidorx/matcaps/master/128/3F4441_D1D7D6_888F87_A2ADA1-128px.png',
    'https://raw.githubusercontent.com/nidorx/matcaps/master/128/394641_B1A67E_75BEBE_7D7256-128px.png',
    'https://raw.githubusercontent.com/nidorx/matcaps/master/128/313131_BBBBBB_878787_A3A4A4-128px.png',
    'https://raw.githubusercontent.com/nidorx/matcaps/master/128/353535_CFCFCF_828282_A4A4A4-128px.png'
] as const;
const ALLOWED_MATCAP_SET = new Set<string>(ALLOWED_MATCAP_URLS);
const MATCAP_LIBRARY: { name: string, file: string, category: string, thumb: string }[] = ALLOWED_MATCAP_URLS.map((url, index) => ({
    name: decodeURIComponent(url.split('/').pop() || `matcap-${index + 1}`),
    file: url,
    category: `Matcap ${index + 1}`,
    thumb: url
}));
const defaultMatcapUrl = ALLOWED_MATCAP_URLS[0];
const textureCache: Record<string, THREE.Texture> = {};
const matcapPreviewImageCache: HTMLImageElement[] = [];
const textureLoader = new THREE.TextureLoader();

function getContrastMatcapUrl(url: string | undefined): string | undefined {
    if (!url) return url;
    return ALLOWED_MATCAP_SET.has(url) ? url : defaultMatcapUrl;
}

function getMatcapTexture(url: string | undefined): THREE.Texture {
    const safeUrl = getContrastMatcapUrl(url) || defaultMatcapUrl;
    if (!textureCache[safeUrl]) {
        textureCache[safeUrl] = textureLoader.load(safeUrl);
    }
    return textureCache[safeUrl];
}

function preloadMatcapTextures() {
    ALLOWED_MATCAP_URLS.forEach((url) => getMatcapTexture(url));
}

function preloadMatcapPreviews() {
    MATCAP_LIBRARY.forEach((matcap) => {
        const image = new Image();
        image.decoding = 'async';
        image.loading = 'eager';
        image.src = matcap.thumb;
        matcapPreviewImageCache.push(image);
    });
}

preloadMatcapTextures();
preloadMatcapPreviews();



// Stats Presets
type TPalette = {
    name: string;
    colors: [number, number, number, number, number];
};

type TBeyPreset = {
    name: string;
    style: string;
    stats: Partial<BeybladeStats>;
};

type TRawBeyPreset = {
    name: string;
    style: string;
    stats: Record<string, unknown>;
};

const PRESET_MATCAP_SETS: Array<Required<BeybladeStats>['partMatcaps']> = [
    {
        wheel: ALLOWED_MATCAP_URLS[0],
        ring: ALLOWED_MATCAP_URLS[1],
        bolt: ALLOWED_MATCAP_URLS[2],
        spinTrack: ALLOWED_MATCAP_URLS[3],
        tip: ALLOWED_MATCAP_URLS[4]
    },
    {
        wheel: ALLOWED_MATCAP_URLS[5],
        ring: ALLOWED_MATCAP_URLS[4],
        bolt: ALLOWED_MATCAP_URLS[0],
        spinTrack: ALLOWED_MATCAP_URLS[1],
        tip: ALLOWED_MATCAP_URLS[2]
    },
    {
        wheel: ALLOWED_MATCAP_URLS[3],
        ring: ALLOWED_MATCAP_URLS[2],
        bolt: ALLOWED_MATCAP_URLS[5],
        spinTrack: ALLOWED_MATCAP_URLS[4],
        tip: ALLOWED_MATCAP_URLS[1]
    }
];

const CURATED_PALETTES: TPalette[] = [
    { name: 'Prize Cabinet', colors: [0xfff12b, 0x05d9ff, 0xff2bd6, 0x10131f, 0xffffff] },
    { name: 'Vapor Chrome', colors: [0x79ffe1, 0x6d5dfc, 0xff7ac8, 0x1b1f3a, 0xf3f7ff] },
    { name: 'Solar Punch', colors: [0xffb000, 0xff4d00, 0x2ff3e0, 0x111111, 0xfff7d6] },
    { name: 'Circuit Jade', colors: [0x39ff88, 0x00b8ff, 0xfff12b, 0x0b1020, 0xeafff4] },
    { name: 'Candy Steel', colors: [0xf72585, 0x4cc9f0, 0xb5179e, 0x161a2d, 0xf8f9fb] }
];

const BEY_PRESET_CONFIGS_JSON = `[
  {"name":"Jackpot Volt","style":"crit sprinter","stats":{"atk":13,"def":4,"sta":1.1,"spd":72,"wt":0.9,"crtAtk":30,"beyScale":0.96,"wheelColor":"#222222","ringColor":"#ff243e","boltColor":"#ffd21a","spinTrackColor":"#2ec7ff","tipColor":"#fff8ed","ringRadiusFactor":0.78,"ringSides":48,"boltSides":6}},
  {"name":"Storm Pegasus","style":"wide attack","stats":{"atk":12,"def":5,"sta":1.0,"spd":74,"wt":0.94,"crtAtk":29,"beyScale":0.98,"wheelColor":"#12315a","ringColor":"#2ec7ff","boltColor":"#fff8ed","spinTrackColor":"#ff243e","tipColor":"#ffd21a","ringRadiusFactor":0.82,"ringSides":64,"boltSides":5}},
  {"name":"Inferno Bull","style":"heavy burst","stats":{"atk":11,"def":8,"sta":1.3,"spd":56,"wt":1.34,"crtAtk":27,"beyScale":1.08,"wheelColor":"#222222","ringColor":"#ff7a12","boltColor":"#ff243e","spinTrackColor":"#ffd21a","tipColor":"#fff8ed","ringRadiusFactor":0.86,"ringSides":32,"boltSides":8}},
  {"name":"Aqua Leone","style":"guard counter","stats":{"atk":8,"def":9,"sta":1.5,"spd":58,"wt":1.22,"crtAtk":22,"beyScale":1.04,"wheelColor":"#0b1722","ringColor":"#2ec7ff","boltColor":"#a736ff","spinTrackColor":"#fff8ed","tipColor":"#ffd21a","ringRadiusFactor":0.8,"ringSides":40,"boltSides":6}},
  {"name":"Solar Wyvern","style":"stamina arc","stats":{"atk":9,"def":6,"sta":1.8,"spd":61,"wt":1.05,"crtAtk":24,"beyScale":1.0,"wheelColor":"#222222","ringColor":"#ffd21a","boltColor":"#ff7a12","spinTrackColor":"#fff8ed","tipColor":"#ff243e","ringRadiusFactor":0.74,"ringSides":48,"boltSides":6}},
  {"name":"Violet Lynx","style":"orbit control","stats":{"atk":10,"def":6,"sta":1.2,"spd":68,"wt":1.0,"crtAtk":26,"beyScale":0.99,"wheelColor":"#222222","ringColor":"#a736ff","boltColor":"#2ec7ff","spinTrackColor":"#ff243e","tipColor":"#fff8ed","ringRadiusFactor":0.72,"ringSides":64,"boltSides":5}},
  {"name":"Crimson Eagle","style":"air dash","stats":{"atk":13,"def":5,"sta":0.95,"spd":76,"wt":0.92,"crtAtk":31,"beyScale":0.95,"wheelColor":"#222222","ringColor":"#ff243e","boltColor":"#fff8ed","spinTrackColor":"#ff7a12","tipColor":"#2ec7ff","ringRadiusFactor":0.76,"ringSides":56,"boltSides":6}},
  {"name":"Chrome Kraken","style":"dense defense","stats":{"atk":8,"def":10,"sta":1.45,"spd":50,"wt":1.42,"crtAtk":21,"beyScale":1.09,"wheelColor":"#d7dde5","ringColor":"#1d2730","boltColor":"#2ec7ff","spinTrackColor":"#ff7a12","tipColor":"#ffd21a","ringRadiusFactor":0.88,"ringSides":32,"boltSides":8}},
  {"name":"Nova Fox","style":"balanced burst","stats":{"atk":11,"def":6,"sta":1.25,"spd":65,"wt":1.05,"crtAtk":27,"beyScale":1.0,"wheelColor":"#222222","ringColor":"#ff7a12","boltColor":"#ffd21a","spinTrackColor":"#2ec7ff","tipColor":"#fff8ed","ringRadiusFactor":0.8,"ringSides":48,"boltSides":6}},
  {"name":"Thunder Roc","style":"impact tank","stats":{"atk":12,"def":8,"sta":1.15,"spd":54,"wt":1.32,"crtAtk":30,"beyScale":1.07,"wheelColor":"#222222","ringColor":"#ffd21a","boltColor":"#ff243e","spinTrackColor":"#a736ff","tipColor":"#fff8ed","ringRadiusFactor":0.84,"ringSides":40,"boltSides":8}},
  {"name":"Blizzard Hare","style":"light drift","stats":{"atk":9,"def":5,"sta":1.55,"spd":73,"wt":0.86,"crtAtk":23,"beyScale":0.94,"wheelColor":"#eef8ff","ringColor":"#2ec7ff","boltColor":"#a736ff","spinTrackColor":"#fff8ed","tipColor":"#ff243e","ringRadiusFactor":0.7,"ringSides":64,"boltSides":5}},
  {"name":"Magma Serpent","style":"wall bite","stats":{"atk":12,"def":7,"sta":1.05,"spd":62,"wt":1.16,"crtAtk":29,"beyScale":1.02,"wheelColor":"#222222","ringColor":"#ff243e","boltColor":"#ff7a12","spinTrackColor":"#ffd21a","tipColor":"#fff8ed","ringRadiusFactor":0.82,"ringSides":36,"boltSides":6}},
  {"name":"Comet Panda","style":"stamina guard","stats":{"atk":7,"def":8,"sta":1.9,"spd":52,"wt":1.18,"crtAtk":20,"beyScale":1.05,"wheelColor":"#fff8ed","ringColor":"#222222","boltColor":"#ffd21a","spinTrackColor":"#2ec7ff","tipColor":"#ff243e","ringRadiusFactor":0.76,"ringSides":48,"boltSides":8}},
  {"name":"Azure Dragon","style":"fast curve","stats":{"atk":11,"def":5,"sta":1.2,"spd":75,"wt":0.96,"crtAtk":28,"beyScale":0.98,"wheelColor":"#07121f","ringColor":"#2ec7ff","boltColor":"#ffd21a","spinTrackColor":"#a736ff","tipColor":"#fff8ed","ringRadiusFactor":0.74,"ringSides":56,"boltSides":5}},
  {"name":"Ember Tiger","style":"crit brawler","stats":{"atk":14,"def":4,"sta":0.9,"spd":69,"wt":1.02,"crtAtk":33,"beyScale":1.0,"wheelColor":"#222222","ringColor":"#ff7a12","boltColor":"#ff243e","spinTrackColor":"#fff8ed","tipColor":"#ffd21a","ringRadiusFactor":0.78,"ringSides":44,"boltSides":6}},
  {"name":"Ghost Mantis","style":"precision edge","stats":{"atk":10,"def":6,"sta":1.35,"spd":70,"wt":0.98,"crtAtk":25,"beyScale":0.97,"wheelColor":"#fff8ed","ringColor":"#a736ff","boltColor":"#2ec7ff","spinTrackColor":"#222222","tipColor":"#ffd21a","ringRadiusFactor":0.68,"ringSides":64,"boltSides":5}},
  {"name":"Iron Rhino","style":"slow crusher","stats":{"atk":10,"def":11,"sta":1.25,"spd":46,"wt":1.5,"crtAtk":26,"beyScale":1.1,"wheelColor":"#2b2f35","ringColor":"#ff243e","boltColor":"#ffd21a","spinTrackColor":"#fff8ed","tipColor":"#2ec7ff","ringRadiusFactor":0.9,"ringSides":32,"boltSides":8}},
  {"name":"Pulse Phoenix","style":"comeback spin","stats":{"atk":11,"def":7,"sta":1.45,"spd":64,"wt":1.08,"crtAtk":28,"beyScale":1.03,"wheelColor":"#222222","ringColor":"#ff243e","boltColor":"#ffd21a","spinTrackColor":"#ff7a12","tipColor":"#2ec7ff","ringRadiusFactor":0.8,"ringSides":48,"boltSides":6}}
]`;

const COLOR_STAT_KEYS = new Set(['wheelColor', 'ringColor', 'boltColor', 'spinTrackColor', 'tipColor', 'trailColor']);
const BEY_COLOR_KEYS: Array<keyof Pick<BeybladeStats, 'wheelColor' | 'ringColor' | 'boltColor' | 'spinTrackColor' | 'tipColor' | 'trailColor'>> = [
    'wheelColor',
    'ringColor',
    'boltColor',
    'spinTrackColor',
    'tipColor',
    'trailColor'
];
const MIN_BEY_LUMA = 135;

function getColorLuma(color: number) {
    const r = (color >> 16) & 255;
    const g = (color >> 8) & 255;
    const b = color & 255;
    return (r * 0.299) + (g * 0.587) + (b * 0.114);
}

function clampBeyColor(color: number) {
    const normalized = Math.max(0, Math.min(0xffffff, Math.round(color || 0)));
    const luma = getColorLuma(normalized);
    if (luma >= MIN_BEY_LUMA) return normalized;

    const r = (normalized >> 16) & 255;
    const g = (normalized >> 8) & 255;
    const b = normalized & 255;
    const mix = Math.min(1, (MIN_BEY_LUMA - luma) / Math.max(1, 255 - luma));

    return ((Math.round(r + (255 - r) * mix) << 16) |
        (Math.round(g + (255 - g) * mix) << 8) |
        Math.round(b + (255 - b) * mix));
}

function enforceBeyColorContrast(stats: Partial<BeybladeStats>) {
    BEY_COLOR_KEYS.forEach((key) => {
        const value = stats[key];
        if (typeof value === 'number') {
            (stats as any)[key] = clampBeyColor(value);
        }
    });
}

function normalizePresetConfig(config: TRawBeyPreset, index: number): TBeyPreset {
    const stats: Record<string, unknown> = {};
    Object.entries(config.stats).forEach(([key, value]) => {
        stats[key] = COLOR_STAT_KEYS.has(key) && typeof value === 'string'
            ? parseInt(value.replace('#', ''), 16)
            : value;
    });
    stats.partMatcaps = PRESET_MATCAP_SETS[index % PRESET_MATCAP_SETS.length];
    enforceBeyColorContrast(stats as Partial<BeybladeStats>);
    return {
        name: config.name,
        style: config.style,
        stats: stats as Partial<BeybladeStats>
    };
}

const BEY_PRESETS = (JSON.parse(BEY_PRESET_CONFIGS_JSON) as TRawBeyPreset[]).map(normalizePresetConfig);

function applyPaletteToStats(stats: BeybladeStats, palette: TPalette) {
    const [primary, secondary, accent, shadow, light] = palette.colors;
    stats.wheelColor = shadow;
    stats.ringColor = primary;
    stats.boltColor = accent;
    stats.spinTrackColor = secondary;
    stats.tipColor = light;
    stats.trailColor = accent;
    enforceBeyColorContrast(stats);
}

function randomFromRange(min: number, max: number) {
    return min + Math.random() * (max - min);
}

function numberToHex(value: number) {
    return value.toString(16).padStart(6, '0');
}

function hslToHex(h: number, s: number, l: number) {
    const saturation = s / 100;
    const lightness = l / 100;
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const x = chroma * (1 - Math.abs((h / 60) % 2 - 1));
    const m = lightness - chroma / 2;
    let r = 0;
    let g = 0;
    let b = 0;

    if (h < 60) [r, g, b] = [chroma, x, 0];
    else if (h < 120) [r, g, b] = [x, chroma, 0];
    else if (h < 180) [r, g, b] = [0, chroma, x];
    else if (h < 240) [r, g, b] = [0, x, chroma];
    else if (h < 300) [r, g, b] = [x, 0, chroma];
    else [r, g, b] = [chroma, 0, x];

    return ((Math.round((r + m) * 255) << 16) |
        (Math.round((g + m) * 255) << 8) |
        Math.round((b + m) * 255));
}

function createFastSwatchPalette(): TPalette {
    const harmonySeeds = [
        { name: 'Solar clash', hue: 6 },
        { name: 'Volt comet', hue: 42 },
        { name: 'Aqua flare', hue: 190 },
        { name: 'Magenta burn', hue: 316 },
        { name: 'Ruby storm', hue: 350 }
    ];
    const seed = harmonySeeds[Math.floor(Math.random() * harmonySeeds.length)];
    const baseHue = (seed.hue + Math.floor(randomFromRange(-10, 11)) + 360) % 360;

    return {
        name: seed.name,
        colors: [
            hslToHex(baseHue, 92, 54),
            hslToHex((baseHue + 32) % 360, 90, 46),
            hslToHex((baseHue + 178) % 360, 86, 58),
            hslToHex((baseHue + 246) % 360, 62, 17),
            hslToHex((baseHue + 54) % 360, 84, 90)
        ]
    };
}

function buildRandomBeyStats(baseStats: BeybladeStats): BeybladeStats {
    const nextStats = JSON.parse(JSON.stringify(baseStats)) as BeybladeStats;
    const palette = Math.random() < 0.35
        ? CURATED_PALETTES[Math.floor(Math.random() * CURATED_PALETTES.length)]
        : createFastSwatchPalette();

    applyPaletteToStats(nextStats, palette);
    nextStats.atk = Math.round(randomFromRange(8, 14));
    nextStats.def = Math.round(randomFromRange(4, 9));
    nextStats.sta = Number(randomFromRange(0.8, 1.6).toFixed(1));
    nextStats.spd = Math.round(randomFromRange(52, 76));
    nextStats.wt = Number(randomFromRange(0.85, 1.35).toFixed(2));
    nextStats.crtAtk = Math.round(nextStats.atk * randomFromRange(2.0, 2.7));
    nextStats.beyScale = Number(randomFromRange(0.9, 1.14).toFixed(2));
    nextStats.wheelWidthFactor = Number(randomFromRange(0.88, 1.16).toFixed(2));
    nextStats.wheelHeightFactor = Number(randomFromRange(0.62, 1.52).toFixed(2));
    nextStats.ringRadiusFactor = Number(randomFromRange(0.58, 0.96).toFixed(2));
    nextStats.ringWidthFactor = Number(randomFromRange(0.58, 1.42).toFixed(2));
    nextStats.ringHeightFactor = Number(randomFromRange(0.58, 1.5).toFixed(2));
    nextStats.ringSides = [10, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64][Math.floor(Math.random() * 11)];
    nextStats.boltWidthFactor = Number(randomFromRange(0.68, 1.38).toFixed(2));
    nextStats.boltHeightFactor = Number(randomFromRange(0.62, 1.58).toFixed(2));
    nextStats.boltSides = [3, 4, 5, 6, 7, 8, 10, 12][Math.floor(Math.random() * 8)];
    nextStats.spinTrackSize = Number(randomFromRange(0.66, 1.34).toFixed(2));
    nextStats.spinTrackHeightFactor = Number(randomFromRange(0.66, 1.54).toFixed(2));
    nextStats.tipSize = Number(randomFromRange(0.68, 1.34).toFixed(2));
    nextStats.tipHeightFactor = Number(randomFromRange(0.64, 1.58).toFixed(2));
    enforceBeyColorContrast(nextStats);

    return nextStats;
}

const PLAYER_STATS: BeybladeStats = {
    maxRpm: 1000,
    atk: 10,
    def: 5,
    wt: 1.0,
    sta: 1,
    spd: 60,
    spl: 0,
    crtAtk: 20, // 2x Atk explicitly
    frictionAir: 0.02, // FRICTION_LOW
    restitution: 0.1,
    friction: 0.2,
    densityBase: 0.05,
    radius: 30, // Standard size
    height: 10,
    // Visuals (Blue Theme from Pool)
    beyScale: 1.0,
    wheelWidthFactor: 1.0,
    wheelHeightFactor: 1.0,
    wheelColor: 0x888888,
    ringColor: 0x0088ff, // Blue
    ringSides: 32,
    ringRadiusFactor: 0.75,
    ringWidthFactor: 1.0,
    ringHeightFactor: 1.0,
    boltColor: 0x00ccff, // Cyan
    boltSides: 6,
    boltWidthFactor: 1.0,
    boltHeightFactor: 1.0,
    spinTrackColor: 0x777777,
    spinTrackSize: 1.0,
    spinTrackHeightFactor: 1.0,
    tipColor: 0x888888,
    tipSize: 1.0,
    tipHeightFactor: 1.0,
    trailColor: 0x00ccff,
    // Arena Forces
    dishForce: 2, // DISH_LOW
    curlForce: 1, // CURL_LOW
    dragFactor: 0.000
};

const ENEMY_STATS: BeybladeStats = {
    maxRpm: 1000,
    atk: 10,
    def: 5,
    wt: 1.0,
    sta: 1,
    spd: 60,
    spl: 0,
    crtAtk: 20, // 2x Atk
    crt: 0.2, // Pool branch crit chance
    frictionAir: 0.02, // FRICTION_LOW
    restitution: 0.1,
    friction: 0.2,
    densityBase: 0.05,
    radius: 30, // Standard size
    height: 10,
    // Visuals (Orange Theme from Pool)
    beyScale: 1.0,
    wheelWidthFactor: 1.0,
    wheelHeightFactor: 1.0,
    wheelColor: 0x888888,
    ringColor: 0xff6600, // Orange
    ringSides: 32,
    ringRadiusFactor: 0.75,
    ringWidthFactor: 1.0,
    ringHeightFactor: 1.0,
    boltColor: 0xffaa00, // Gold
    boltSides: 6,
    boltWidthFactor: 1.0,
    boltHeightFactor: 1.0,
    spinTrackColor: 0x777777,
    spinTrackSize: 1.0,
    spinTrackHeightFactor: 1.0,
    tipColor: 0x888888,
    tipSize: 1.0,
    tipHeightFactor: 1.0,
    trailColor: 0xffaa00,
    // Arena Forces
    dishForce: 2, // DISH_LOW
    curlForce: 1, // CURL_LOW
    dragFactor: 0.000
};

// Defaults for Reset
const DEFAULT_PLAYER_STATS = JSON.parse(JSON.stringify(PLAYER_STATS));
const DEFAULT_ENEMY_STATS = JSON.parse(JSON.stringify(ENEMY_STATS));

function syncTrailWithBolt(stats: BeybladeStats) {
    stats.trailColor = stats.boltColor;
}

function sanitizePartMatcaps(stats: BeybladeStats) {
    if (!stats.partMatcaps) return;

    const sanitized: NonNullable<BeybladeStats['partMatcaps']> = {};
    MATCAP_PART_KEYS.forEach((key) => {
        const url = stats.partMatcaps?.[key];
        if (!url) return;
        sanitized[key] = ALLOWED_MATCAP_SET.has(url) ? url : defaultMatcapUrl;
    });
    stats.partMatcaps = sanitized;
}

function savePresets() {
    syncTrailWithBolt(PLAYER_STATS);
    syncTrailWithBolt(ENEMY_STATS);
    sanitizePartMatcaps(PLAYER_STATS);
    sanitizePartMatcaps(ENEMY_STATS);
    enforceBeyColorContrast(PLAYER_STATS);
    enforceBeyColorContrast(ENEMY_STATS);
    localStorage.setItem('bblade_player_stats', JSON.stringify(PLAYER_STATS));
    localStorage.setItem('bblade_enemy_stats', JSON.stringify(ENEMY_STATS));
}

function loadPresets() {
    const pData = localStorage.getItem('bblade_player_stats');
    if (pData) {
        // Merge with default to ensure new fields are present
        const parsed = JSON.parse(pData);
        Object.assign(PLAYER_STATS, { ...DEFAULT_PLAYER_STATS, ...parsed });
        if (!parsed.trailColor || parsed.trailColor === 0x00ffff) syncTrailWithBolt(PLAYER_STATS);
        sanitizePartMatcaps(PLAYER_STATS);
        enforceBeyColorContrast(PLAYER_STATS);
    }
    const eData = localStorage.getItem('bblade_enemy_stats');
    if (eData) {
        const parsed = JSON.parse(eData);
        Object.assign(ENEMY_STATS, { ...DEFAULT_ENEMY_STATS, ...parsed });
        if (!parsed.trailColor || parsed.trailColor === 0x00ffff) syncTrailWithBolt(ENEMY_STATS);
        sanitizePartMatcaps(ENEMY_STATS);
        enforceBeyColorContrast(ENEMY_STATS);
    }
}

// Load Immediately
loadPresets();

const VISUAL_FIELDS = [
    { key: 'beyScale', label: 'SCALE', hint: 'Size', type: 'number', step: 0.1 },
    { key: 'wheelWidthFactor', label: 'BASE WIDTH', hint: 'Wheel span', type: 'number', step: 0.05 },
    { key: 'wheelHeightFactor', label: 'BASE HEIGHT', hint: 'Wheel stack', type: 'number', step: 0.05 },
    { key: 'wheelColor', label: 'WHEEL', hint: 'Hex', type: 'color' },
    { key: 'ringColor', label: 'RING', hint: 'Hex', type: 'color' },
    { key: 'ringRadiusFactor', label: 'RING RADIUS', hint: 'Size factor', type: 'number', step: 0.05 },
    { key: 'ringWidthFactor', label: 'RING WIDTH', hint: 'Band width', type: 'number', step: 0.05 },
    { key: 'ringHeightFactor', label: 'RING HEIGHT', hint: 'Band height', type: 'number', step: 0.05 },
    { key: 'ringSides', label: 'RING SIDES', hint: 'Shape sides', type: 'number', step: 1 },
    { key: 'boltColor', label: 'BOLT', hint: 'Hex', type: 'color' },
    { key: 'boltSides', label: 'BOLT SIDES', hint: 'Hex/Circle', type: 'number', step: 1 },
    { key: 'boltWidthFactor', label: 'BOLT WIDTH', hint: 'Cap width', type: 'number', step: 0.05 },
    { key: 'boltHeightFactor', label: 'BOLT HEIGHT', hint: 'Cap height', type: 'number', step: 0.05 },
    { key: 'spinTrackColor', label: 'TRACK', hint: 'Hex', type: 'color' },
    { key: 'spinTrackSize', label: 'ST SIZE', hint: 'Track depth', type: 'number', step: 0.1 },
    { key: 'spinTrackHeightFactor', label: 'TRACK HEIGHT', hint: 'Stem height', type: 'number', step: 0.05 },
    { key: 'tipColor', label: 'TIP', hint: 'Hex', type: 'color' },
    { key: 'tipSize', label: 'TIP SIZE', hint: 'Radius', type: 'number', step: 0.1 },
    { key: 'tipHeightFactor', label: 'TIP HEIGHT', hint: 'Driver height', type: 'number', step: 0.05 },
];

const COMBAT_FIELDS = [
    { key: 'atk', label: 'ATTACK', hint: 'Damage', type: 'number', step: 1 },
    { key: 'def', label: 'DEFENSE', hint: 'Resistance', type: 'number', step: 1 },
    { key: 'sta', label: 'STAMINA', hint: 'Endurance', type: 'number', step: 1 },
    { key: 'spd', label: 'SPEED', hint: 'Velocity', type: 'number', step: 1 },
    { key: 'wt', label: 'WEIGHT', hint: 'Mass', type: 'number', step: 0.1 },
    { key: 'crtAtk', label: 'CRIT ATK', hint: 'Crit Dmg', type: 'number', step: 1 },
];

function createBeyblade(x: number, y: number, stats: BeybladeStats): GameEntity {
    const density = stats.densityBase * stats.wt;

    const body = Bodies.circle(x, y, BEYBLADE_RADIUS, {
        restitution: stats.restitution,
        friction: stats.friction,
        frictionAir: stats.frictionAir,
        density: density,
        label: 'Beyblade'
    });

    // Visuals
    const { mesh, tiltGroup, spinGroup } = createBeybladeMesh(stats);
    scene.add(mesh); // Add to scene

    // Trail
    const trail = new TrailSystem(stats.trailColor, scene);

    // Initial Spawn
    Composite.add(engine.world, body);

    const entity: GameEntity = {
        body,
        mesh,
        tiltGroup,
        spinGroup,
        trail,
        stats,
        currentRpm: 0
    };
    entities.push(entity);

    return entity;
}

// Create Player and Enemy
const player = createBeyblade(0, 100, PLAYER_STATS);
const enemy = createBeyblade(0, -100, ENEMY_STATS);

// Initial Guide Update
updateGuide(currentLaunchAngle.value);

// Trigger once logic moved to setup


// --- Interaction State ---
let isDragging = false;
let hasLaunched = false;
let gameOver = false;
let tutorialModeActive = false;
let tutorialPauseActive = false;
let tutorialSlowMoActive = false;
let tutorialPhase: 'idle' | 'aim' | 'launch' | 'waitingDiveMoment' | 'dive' | 'gainSpeed' | 'speedModal' | 'waitingCrit' | 'waitingSecondCrit' | 'finishModal' | 'complete' = 'idle';
let tutorialNextPromptAt = 0;
let tutorialPromptEl: HTMLElement | null = null;
let tutorialWarningEl: HTMLElement | null = null;
let tutorialWarningTimeout: number | undefined;
let tutorialLastWallWarningAt = -Infinity;
let tutorialInitialAimAngle = DEFAULT_LAUNCH_ANGLE;
let tutorialCompletionTracked = false;
let tutorialHighlightEl: HTMLElement | null = null;
let tutorialLayerEl: HTMLElement | null = null;

// Stats snapshots at match start (for "Keep Power-Ups" reset)
let matchStartPlayerStats: BeybladeStats | null = null;
let matchStartEnemyStats: BeybladeStats | null = null;

// Drag line visual (Three.js Line)
const dragLineGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0)]);
const dragLineMaterial = new THREE.LineBasicMaterial({ color: 0xffffff });
const dragLine = new THREE.Line(dragLineGeometry, dragLineMaterial);
dragLine.frustumCulled = false;
dragLine.visible = false;
scene.add(dragLine);

// --- UI Overlay (HTML - Keep mostly same) ---
const uiContainer = document.createElement('div');
uiContainer.style.position = 'absolute';
uiContainer.style.top = '0';
uiContainer.style.left = '0';
uiContainer.style.width = '100%';
uiContainer.style.height = '100%';
uiContainer.style.pointerEvents = 'none'; // Let clicks pass through to canvas
uiContainer.style.zIndex = '10';
document.body.appendChild(uiContainer);

// Consolidated Top Bar HUD
const hudTopBar = document.createElement('div');
hudTopBar.id = 'hud-top-bar';
hudTopBar.innerHTML = `
    <div class="hud-group">
        <button class="rpm-label" id="p1-btn" title="Customize player">P1</button>
        <div class="rpm-meter-wrap" data-crit-owner="player">
            <meter id="player-meter" min="0" max="1000" low="200" high="800" optimum="1000" value="0" aria-label="P1 RPM"></meter>
            <span id="player-rpm" class="rpm-text">0</span>
        </div>
    </div>
    <div class="hud-divider">VS</div>
    <div class="hud-group">
        <div class="rpm-meter-wrap" data-crit-owner="enemy">
            <meter id="enemy-meter" min="0" max="1000" low="200" high="800" optimum="1000" value="0" aria-label="CPU1 RPM" style="transform: scaleX(-1);"></meter>
            <span id="enemy-rpm" class="rpm-text">0</span>
        </div>
        <button class="rpm-label" id="cpu-btn" title="Customize CPU1">CPU1</button>
    </div>
`;
uiContainer.appendChild(hudTopBar);

const topMenuBtn = document.createElement('button');
topMenuBtn.className = 'top-menu-btn';
topMenuBtn.title = 'Menu';
topMenuBtn.setAttribute('aria-label', 'Menu');
topMenuBtn.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
    <span>Menu</span>
`;
uiContainer.appendChild(topMenuBtn);

// Floating Action HUD (Pool + Reset buttons)
const actionHud = document.createElement('div');
actionHud.id = 'action-hud';
actionHud.className = 'action-hud';

const resetHint = document.createElement('button');
resetHint.className = 'action-hud-btn';
resetHint.innerText = 'RESET';
resetHint.onclick = () => requestMatchReset();
resetHint.style.display = 'none';
actionHud.appendChild(resetHint);

uiContainer.appendChild(actionHud);




// --- Cycle Button ---
const cycleBtnContainer = document.createElement('div');
cycleBtnContainer.className = 'cycle-container';
cycleBtnContainer.style.display = 'none'; // Hidden initially
uiContainer.appendChild(cycleBtnContainer);

const cpuCycleBtnContainer = document.createElement('div');
cpuCycleBtnContainer.className = 'cycle-container cpu-cycle-container';
cpuCycleBtnContainer.style.display = 'none';
uiContainer.appendChild(cpuCycleBtnContainer);

function updatePhysicsFromPattern() {
    if (!player || !player.body || !player.stats) return;

    // Standard Pattern Logic
    const p = PATTERNS[currentPatternIndex];
    player.stats.dishForce = p.dish;
    player.stats.curlForce = p.curl;
    player.body.frictionAir = p.drag;
    player.stats.frictionAir = p.drag;
}

function updateCpuPhysicsFromPattern() {
    if (!enemy || !enemy.body || !enemy.stats) return;

    const p = PATTERNS[cpuPatternIndex];
    enemy.stats.dishForce = p.dish;
    enemy.stats.curlForce = p.curl;
    enemy.body.frictionAir = p.drag;
    enemy.stats.frictionAir = p.drag;
}

function isHardCpuMode() {
    return multiplayer.role === 'solo' && localPlayMode === '1p-hard';
}

function scheduleNextCpuDiveSwitch(now: number, delay?: number) {
    if (typeof delay === 'number') {
        cpuNextDiveSwitchAt = now + delay;
        return;
    }

    cpuNextDiveSwitchAt = now + (isHardCpuMode()
        ? randomFromRange(0.12, 0.32)
        : randomFromRange(0.85, 2.2));
}

function setCpuPattern(pattern: number) {
    cpuDiveIntent = pattern;
    cpuPatternIndex = pattern;
    if (pattern === 1) cpuCycleBtn.classList.add('active');
    else cpuCycleBtn.classList.remove('active');
    updateCpuPhysicsFromPattern();
}

function isOnlineMatch() {
    return multiplayer.role !== 'solo' && localPlayMode !== '2p';
}

function updateCpuDive(now: number) {
    if (multiplayer.role !== 'solo') return;
    if (localPlayMode === '2p') return;
    if (!hasLaunched || gameOver) return;
    if (now < cpuNextDiveSwitchAt) return;

    if (isHardCpuMode()) {
        const decision = getHardCpuDiveDecision(now);
        if (decision.reason !== cpuHardAiLastReason || decision.pattern !== cpuPatternIndex) {
            cpuHardAiLastReason = decision.reason;
        }
        setCpuPattern(decision.pattern);
        scheduleNextCpuDiveSwitch(now, decision.nextDelay);
        return;
    }

    const playerIsDiving = currentPatternIndex === 1;
    const diveChance = playerIsDiving ? 0.62 : 0.38;
    setCpuPattern(Math.random() < diveChance ? 1 : 0);
    scheduleNextCpuDiveSwitch(now);
}

function getClosingSpeed(attacker: GameEntity, target: GameEntity) {
    const toTargetX = target.body.position.x - attacker.body.position.x;
    const toTargetY = target.body.position.y - attacker.body.position.y;
    const distance = Math.max(1, Math.hypot(toTargetX, toTargetY));
    const dirX = toTargetX / distance;
    const dirY = toTargetY / distance;
    const relativeVelocityX = attacker.body.velocity.x - target.body.velocity.x;
    const relativeVelocityY = attacker.body.velocity.y - target.body.velocity.y;
    return relativeVelocityX * dirX + relativeVelocityY * dirY;
}

function getHardCpuDiveDecision(now: number): { pattern: number; reason: string; nextDelay: number } {
    const playerDistance = Math.hypot(player.body.position.x, player.body.position.y);
    const enemyDistance = Math.hypot(enemy.body.position.x, enemy.body.position.y);
    const playerSpeed = player.body.speed;
    const enemySpeed = enemy.body.speed;
    const distanceBetweenBeys = Math.hypot(
        player.body.position.x - enemy.body.position.x,
        player.body.position.y - enemy.body.position.y
    );
    const playerClosingSpeed = getClosingSpeed(player, enemy);

    const wallDanger = enemyDistance > ARENA_RADIUS * 0.82 || now - cpuLastWallHitAt < 1.1;
    if (wallDanger) {
        return { pattern: 1, reason: 'wall_escape', nextDelay: 0.14 };
    }

    const criticalIncoming = playerSpeed > CRIT_SPEED_THRESHOLD * 0.88
        && playerSpeed > enemySpeed + 2
        && distanceBetweenBeys < ARENA_RADIUS * 0.95
        && playerClosingSpeed > 2.2;
    if (criticalIncoming) {
        return { pattern: 1, reason: 'dodge_critical', nextDelay: 0.12 };
    }

    const cpuWide = enemyDistance > ARENA_RADIUS * 0.58;
    const playerCentered = playerDistance < ARENA_RADIUS * 0.34;
    if (cpuWide && playerCentered) {
        return { pattern: 1, reason: 'center_attack', nextDelay: 0.18 };
    }

    const cpuRecoveredCenter = enemyDistance < ARENA_RADIUS * 0.25 && cpuPatternIndex === 1;
    if (cpuRecoveredCenter) {
        return { pattern: 0, reason: 'recover_orbit', nextDelay: 0.28 };
    }

    const pressureChance = playerSpeed < CRIT_SPEED_THRESHOLD * 0.62 && enemyDistance > playerDistance + 48 ? 0.32 : 0.12;
    return {
        pattern: Math.random() < pressureChance ? 1 : 0,
        reason: 'idle_pressure',
        nextDelay: randomFromRange(0.42, 0.72)
    };
}

function applyPlayerDivePattern(pattern: number) {
    currentPatternIndex = pattern;
    if (pattern === 1) cycleBtn.classList.add('active');
    else cycleBtn.classList.remove('active');
    updatePhysicsFromPattern();
    if (pattern === 1) handleTutorialDivePressed();
}

// Dive Logic
const setPattern = (e: Event | null, pattern: number) => {
    if (e) e.preventDefault(); // Prevent ghost clicks
    if (localDiveIntent === pattern && (isOnlineMatch() || currentPatternIndex === pattern)) return;
    localDiveIntent = pattern;
    if (isOnlineMatch() && hasLaunched && !gameOver) {
        queueLocalDiveEvent(pattern);
        return;
    }
    applyPlayerDivePattern(pattern);
};

// Input for Dive Mode
window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyA') {
        setPattern(null, 1);
    }
    if (e.code === 'KeyL' && localPlayMode === '2p' && cpuDiveIntent !== 1) {
        setCpuPattern(1);
    }
});

window.addEventListener('keyup', (e) => {
    if (e.code === 'KeyA') {
        setPattern(null, 0);
    }
    if (e.code === 'KeyL' && localPlayMode === '2p') {
        setCpuPattern(0);
    }
});

const cycleBtn = document.createElement('button');
cycleBtn.className = 'pattern-btn';
cycleBtn.type = 'button';
cycleBtn.tabIndex = -1;
currentPatternIndex = 0;
cycleBtn.innerHTML = `
    <span class="value">P1 Dive</span>
`;

const cpuCycleBtn = document.createElement('button');
cpuCycleBtn.className = 'pattern-btn cpu-pattern-btn';
cpuCycleBtn.type = 'button';
cpuCycleBtn.tabIndex = -1;
cpuCycleBtn.innerHTML = `
    <span class="value">P2 Dive</span>
`;

function bindGameDiveButton(button: HTMLButtonElement, onPattern: (event: PointerEvent, pattern: number) => void) {
    const press = (event: PointerEvent) => {
        if (!event.isPrimary) return;
        event.preventDefault();
        button.blur();
        if (!button.hasPointerCapture(event.pointerId)) {
            button.setPointerCapture(event.pointerId);
        }
        onPattern(event, 1);
    };
    const release = (event: PointerEvent) => {
        if (!event.isPrimary) return;
        event.preventDefault();
        if (button.hasPointerCapture(event.pointerId)) {
            button.releasePointerCapture(event.pointerId);
        }
        onPattern(event, 0);
    };

    button.addEventListener('pointerdown', press, { passive: false });
    button.addEventListener('pointerup', release, { passive: false });
    button.addEventListener('pointercancel', release, { passive: false });
    button.addEventListener('pointerleave', release, { passive: false });
    button.addEventListener('contextmenu', (event) => event.preventDefault());
}

bindGameDiveButton(cycleBtn, (event, pattern) => setPattern(event, pattern));
bindGameDiveButton(cpuCycleBtn, (_event, pattern) => setCpuPattern(pattern));

cycleBtnContainer.appendChild(cycleBtn);
cpuCycleBtnContainer.appendChild(cpuCycleBtn);

// Init Physics
updatePhysicsFromPattern();
updateCpuPhysicsFromPattern();

const playerRpmEl = document.getElementById('player-rpm')!;
const enemyRpmEl = document.getElementById('enemy-rpm')!;
const playerMeterEl = document.getElementById('player-meter') as HTMLMeterElement;
const enemyMeterEl = document.getElementById('enemy-meter') as HTMLMeterElement;




// --- Spark System ---
const Events = Matter.Events;

interface Spark {
    mesh: THREE.Mesh;
    velocity: THREE.Vector3;
    life: number;
}
const sparks: Spark[] = [];
const sparkGeo = new THREE.BoxGeometry(3, 3, 3); // Bigger sparks

function createSpark(x: number, y: number, color: number, speedVal: number) {
    const material = new THREE.MeshBasicMaterial({
        color: color,
        transparent: true
    });
    const mesh = new THREE.Mesh(sparkGeo, material);

    mesh.position.set(x, getArenaHeight(x, y) + 5, y);

    scene.add(mesh);

    const angle = Math.random() * Math.PI * 2;

    const velocity = new THREE.Vector3(
        Math.cos(angle) * speedVal,
        Math.random() * speedVal, // jump up
        Math.sin(angle) * speedVal
    );

    sparks.push({ mesh, velocity, life: 1.0 });
}

// --- Audio System ---
const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
const audioMasterGain = audioCtx.createGain();
audioMasterGain.gain.value = masterVolume;
audioMasterGain.connect(audioCtx.destination);
let audioUnlocked = audioCtx.state === 'running';

async function unlockAudio() {
    if (audioUnlocked) return;
    try {
        if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
        }
        const source = audioCtx.createBufferSource();
        const gain = audioCtx.createGain();
        source.buffer = audioCtx.createBuffer(1, 1, audioCtx.sampleRate);
        gain.gain.value = 0.0001;
        source.connect(gain);
        gain.connect(audioMasterGain);
        source.start(0);
        source.stop(audioCtx.currentTime + 0.01);
        audioUnlocked = audioCtx.state === 'running';
    } catch {
        audioUnlocked = false;
    }
}

['pointerdown', 'touchend', 'click'].forEach((eventName) => {
    window.addEventListener(eventName, unlockAudio, { passive: true });
});

function setMasterVolume(value: number) {
    masterVolume = THREE.MathUtils.clamp(value, 0, 1);
    localStorage.setItem('bblade_master_volume', masterVolume.toFixed(2));
    audioMasterGain.gain.setTargetAtTime(masterVolume, audioCtx.currentTime, 0.04);
}

function setFlashesEnabled(value: boolean) {
    flashesEnabled = value;
    localStorage.setItem('bblade_flashes_enabled', String(value));
    trackGameEvent('flash_setting_changed', { enabled: value });
    if (!value) trackGameEvent('flashes_disabled');
    if (!flashesEnabled) {
        criticalFlashUniforms.uIntensity.value = 0;
        criticalFlashPlane.visible = false;
    }
}

function setCameraShakeEnabled(value: boolean) {
    cameraShakeEnabled = value;
    localStorage.setItem('bblade_camera_shake_enabled', String(value));
    if (!cameraShakeEnabled) {
        clearCameraShakeOffset();
        cameraShakeState.startedAt = -Infinity;
    }
}

function syncGameSpeedControls() {
    const lockedByHost = multiplayer.role === 'guest';
    document.querySelectorAll<HTMLInputElement>('input[name="menu-speed"]').forEach((input) => {
        const isActive = input.value === currentGameSpeed;
        input.checked = isActive;
        input.disabled = lockedByHost;
        const option = input.closest('.menu-speed-option');
        option?.classList.toggle('active', isActive);
        option?.classList.toggle('locked', lockedByHost);
    });
}

function setGameSpeed(value: TGameSpeedId, broadcast = true) {
    currentGameSpeed = value;
    localStorage.setItem('bblade_game_speed', value);
    syncGameSpeedControls();
    if (broadcast) sendHostGameSpeed();
}

// Create a noise buffer once
const bufferSize = audioCtx.sampleRate * 0.1; // 0.1 seconds
const noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
const data = noiseBuffer.getChannelData(0);
for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
}

const windBufferSize = audioCtx.sampleRate * 2;
const windNoiseBuffer = audioCtx.createBuffer(1, windBufferSize, audioCtx.sampleRate);
const windData = windNoiseBuffer.getChannelData(0);
for (let i = 0; i < windBufferSize; i++) {
    windData[i] = Math.random() * 2 - 1;
}

type TBeyNoiseLayer = {
    source: AudioBufferSourceNode;
    filter: BiquadFilterNode;
    lowShelf: BiquadFilterNode;
    gain: GainNode;
    pan: AudioNode;
    panParam: AudioParam | null;
};

let playerNoiseLayer: TBeyNoiseLayer | null = null;
let enemyNoiseLayer: TBeyNoiseLayer | null = null;

function createBeyNoiseLayer(panValue: number): TBeyNoiseLayer {
    const source = audioCtx.createBufferSource();
    const filter = audioCtx.createBiquadFilter();
    const lowShelf = audioCtx.createBiquadFilter();
    const gain = audioCtx.createGain();
    const pan = typeof audioCtx.createStereoPanner === 'function'
        ? audioCtx.createStereoPanner()
        : audioCtx.createGain();
    const panParam = 'pan' in pan && pan.pan instanceof AudioParam ? pan.pan : null;

    source.buffer = windNoiseBuffer;
    source.loop = true;
    source.playbackRate.value = 0.62;
    filter.type = 'lowpass';
    filter.frequency.value = 540;
    filter.Q.value = 0.95;
    lowShelf.type = 'lowshelf';
    lowShelf.frequency.value = 180;
    lowShelf.gain.value = 5;
    gain.gain.value = 0;
    if (panParam) panParam.value = panValue;

    source.connect(filter);
    filter.connect(lowShelf);
    lowShelf.connect(gain);
    gain.connect(pan);
    pan.connect(audioMasterGain);
    source.start();

    return { source, filter, lowShelf, gain, pan, panParam };
}

function ensureBeyNoiseLayers() {
    if (!playerNoiseLayer) playerNoiseLayer = createBeyNoiseLayer(-0.28);
    if (!enemyNoiseLayer) enemyNoiseLayer = createBeyNoiseLayer(0.28);
}

function updateBeyNoiseLayer(layer: TBeyNoiseLayer | null, entity: GameEntity, panValue: number) {
    if (!layer) return;

    const speed = hasLaunched && !entity.isDead ? entity.body.speed : 0;
    const speedRatio = THREE.MathUtils.clamp(speed / 18, 0, 1);
    const now = audioCtx.currentTime;
    const targetGain = (0.02 + speedRatio * 0.03) * 1.5;
    const targetFrequency = 520 + speedRatio * 720;
    const targetPlaybackRate = 0.62 + speedRatio * 0.18;

    layer.gain.gain.cancelScheduledValues(now);
    layer.filter.frequency.cancelScheduledValues(now);
    layer.filter.Q.cancelScheduledValues(now);
    layer.source.playbackRate.cancelScheduledValues(now);
    layer.panParam?.cancelScheduledValues(now);

    layer.gain.gain.linearRampToValueAtTime(hasLaunched && !gameOver && !entity.isDead ? targetGain : 0, now + 0.22);
    layer.filter.frequency.linearRampToValueAtTime(targetFrequency, now + 0.22);
    layer.filter.Q.linearRampToValueAtTime(0.78 + speedRatio * 0.42, now + 0.22);
    layer.source.playbackRate.linearRampToValueAtTime(targetPlaybackRate, now + 0.22);
    layer.panParam?.linearRampToValueAtTime(panValue, now + 0.22);
}

function updateBeyNoiseLayers() {
    updateBeyNoiseLayer(playerNoiseLayer, player, -0.28);
    updateBeyNoiseLayer(enemyNoiseLayer, enemy, 0.28);
}

function createReverbImpulse(seconds: number, decay: number) {
    const length = Math.floor(audioCtx.sampleRate * seconds);
    const impulse = audioCtx.createBuffer(2, length, audioCtx.sampleRate);

    for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
        const channelData = impulse.getChannelData(channel);
        for (let i = 0; i < length; i++) {
            const progress = i / length;
            channelData[i] = (Math.random() * 2 - 1) * Math.pow(1 - progress, decay);
        }
    }

    return impulse;
}

const criticalReverbImpulse = createReverbImpulse(1.45, 2.4);

function getCollisionWorldPoint(pair: Matter.Pair) {
    const supports = pair.collision.supports;
    if (!supports.length) return undefined;

    const point = supports.reduce(
        (acc, support) => {
            acc.x += support.x;
            acc.y += support.y;
            return acc;
        },
        { x: 0, y: 0 }
    );
    const x = point.x / supports.length;
    const z = point.y / supports.length;

    return new THREE.Vector3(x, getArenaHeight(x, z) + 18, z);
}

function updateCriticalFlashOrigin() {
    const worldPoint = criticalFlashState.worldPoint;
    if (worldPoint) {
        const projected = worldPoint.clone().project(camera);
        if (Number.isFinite(projected.x) && Number.isFinite(projected.y)) {
            criticalFlashUniforms.uOrigin.value.set(
                THREE.MathUtils.clamp((projected.x + 1) * 0.5, 0, 1),
                THREE.MathUtils.clamp((projected.y + 1) * 0.5, 0, 1)
            );
        }
    } else {
        criticalFlashUniforms.uOrigin.value.set(0.5, 0.5);
    }
}

function clearCameraShakeOffset() {
    if (cameraShakeState.offset.lengthSq() === 0) return;
    camera.position.sub(cameraShakeState.offset);
    cameraShakeState.offset.set(0, 0, 0);
    camera.updateMatrixWorld(true);
}

function triggerCameraShake(worldPoint?: THREE.Vector3) {
    if (!cameraShakeEnabled) return;

    let screenBias = 1;
    if (worldPoint) {
        const projected = worldPoint.clone().project(camera);
        if (Number.isFinite(projected.x) && Number.isFinite(projected.y)) {
            screenBias = THREE.MathUtils.clamp(1.16 - Math.hypot(projected.x, projected.y) * 0.12, 0.9, 1.16);
        }
    }

    cameraShakeState.startedAt = clock.getElapsedTime();
    cameraShakeState.duration = 0.22;
    cameraShakeState.amplitude = 9.5 * screenBias;
    cameraShakeState.seed = Math.random() * Math.PI * 2;
}

function updateCameraShake() {
    clearCameraShakeOffset();
    if (!cameraShakeEnabled) return;

    const elapsed = clock.getElapsedTime() - cameraShakeState.startedAt;
    if (elapsed < 0 || elapsed > cameraShakeState.duration) return;

    const progress = THREE.MathUtils.clamp(elapsed / cameraShakeState.duration, 0, 1);
    const fade = Math.pow(1 - progress, 2.35);
    const hitSnap = elapsed < 0.035 ? 1.18 : 1;
    const phase = cameraShakeState.seed;
    const x = (
        Math.sin(elapsed * 86 + phase) * 0.68 +
        Math.sin(elapsed * 157 + phase * 1.7) * 0.32
    ) * cameraShakeState.amplitude * fade * hitSnap;
    const y = (
        Math.cos(elapsed * 94 + phase * 0.6) * 0.62 +
        Math.sin(elapsed * 173 + phase * 2.1) * 0.38
    ) * cameraShakeState.amplitude * fade * hitSnap;

    cameraShakeRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    cameraShakeUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    cameraShakeState.offset
        .copy(cameraShakeRight)
        .multiplyScalar(x)
        .addScaledVector(cameraShakeUp, y);
    camera.position.add(cameraShakeState.offset);
    camera.updateMatrixWorld(true);
}

function triggerCriticalFeedback(worldPoint?: THREE.Vector3) {
    triggerCameraShake(worldPoint);
    if (!flashesEnabled) return;

    criticalFlashState.worldPoint = worldPoint?.clone();
    camera.updateMatrixWorld(true);
    updateCriticalFlashOrigin();
    criticalFlashState.startedAt = clock.getElapsedTime();
    criticalFlashUniforms.uIntensity.value = 1.22;
    criticalFlashPlane.visible = true;
}

function updateCriticalFlash() {
    if (!criticalFlashPlane.visible) return;

    updateCriticalFlashOrigin();
    const elapsed = clock.getElapsedTime() - criticalFlashState.startedAt;
    if (elapsed < 0.018) {
        criticalFlashUniforms.uIntensity.value = 1.22;
        return;
    }

    const progress = THREE.MathUtils.clamp((elapsed - 0.018) / criticalFlashState.duration, 0, 1);
    const fade = Math.pow(1 - progress, 3.2);
    criticalFlashUniforms.uIntensity.value = fade * 1.22;
    criticalFlashPlane.visible = fade > 0.01;
}

function playCollisionSound(intensity: number, baseFrequency: number, isCritical = false) {
    unlockAudio();

    const t = audioCtx.currentTime;
    const masterGain = audioCtx.createGain();
    masterGain.connect(audioMasterGain);
    masterGain.gain.setValueAtTime(intensity * 0.5, t);

    if (isCritical) {
        const convolver = audioCtx.createConvolver();
        const reverbTone = audioCtx.createBiquadFilter();
        const reverbGain = audioCtx.createGain();
        const slapDelay = audioCtx.createDelay(0.25);
        const feedback = audioCtx.createGain();
        const wetGain = audioCtx.createGain();
        const tone = audioCtx.createBiquadFilter();

        convolver.buffer = criticalReverbImpulse;
        reverbTone.type = 'lowpass';
        reverbTone.frequency.setValueAtTime(3600, t);
        reverbGain.gain.setValueAtTime(0.72, t);

        slapDelay.delayTime.setValueAtTime(0.088, t);
        feedback.gain.setValueAtTime(0.62, t);
        wetGain.gain.setValueAtTime(0.64, t);
        tone.type = 'lowpass';
        tone.frequency.setValueAtTime(3400, t);

        masterGain.connect(convolver);
        convolver.connect(reverbTone);
        reverbTone.connect(reverbGain);
        reverbGain.connect(audioMasterGain);
        masterGain.connect(slapDelay);
        slapDelay.connect(feedback);
        feedback.connect(slapDelay);
        slapDelay.connect(tone);
        tone.connect(wetGain);
        wetGain.connect(audioMasterGain);
    }

    // 1. Impact "Thud"
    const noise = audioCtx.createBufferSource();
    noise.buffer = noiseBuffer;
    const noiseFilter = audioCtx.createBiquadFilter();
    noiseFilter.type = 'highpass';
    noiseFilter.frequency.value = isCritical ? 900 : 100;
    const noiseGain = audioCtx.createGain();

    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(masterGain);

    noiseGain.gain.setValueAtTime(isCritical ? 0.95 : 0.7, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.025, t + (isCritical ? 0.045 : 0.1));
    noise.start(t);
    noise.stop(t + (isCritical ? 0.055 : 0.1));

    // 2. Heavy Metal Clang
    const scale = isCritical ? [1, 1.25, 1.5, 2] : [1, 3 / 2, 5 / 4, 7 / 4, 2];
    const pick = Math.floor(Math.random() * scale.length);
    const baseFreq = (baseFrequency * scale[pick]) / 1.5;
    const ratios = isCritical ? [1, 2.15, 3.05, 4.6] : [1, 1.5, 2.0, 2.5];

    ratios.forEach((ratio, index) => {
        const osc = audioCtx.createOscillator();
        const oscGain = audioCtx.createGain();

        osc.type = isCritical ? 'square' : index % 2 == 0 ? 'square' : 'triangle';
        osc.frequency.setValueAtTime(baseFreq * ratio, t);

        osc.connect(oscGain);
        oscGain.connect(masterGain);

        oscGain.gain.setValueAtTime(0.0, t);
        oscGain.gain.linearRampToValueAtTime((isCritical ? 0.42 : 0.6) / (index + 0.8), t + 0.002);

        const decayDuration = isCritical
            ? 0.065 + (Math.random() * 0.035) + (1.0 / (index + 1)) * 0.055
            : 0.3 + (Math.random() * 0.2) + (1.0 / (index + 1)) * 0.5;
        oscGain.gain.exponentialRampToValueAtTime(0.001, t + decayDuration);

        osc.start(t);
        osc.stop(t + decayDuration + 0.1);
    });
}

Events.on(engine, 'collisionStart', (event) => {
    event.pairs.forEach((pair) => {
        const entityA = entities.find(e => e.body === pair.bodyA);
        const entityB = entities.find(e => e.body === pair.bodyB);

        // Stats-Based Combat
        if (entityA && entityB && entityA.stats && entityB.stats) {

            // A hits B
            const speedA = entityA.body.speed;
            const isCritA = speedA > CRIT_SPEED_THRESHOLD;
            const speedB = entityB.body.speed;
            const isCritB = speedB > CRIT_SPEED_THRESHOLD;

            const rawDmgA = isCritA ? entityA.stats.crtAtk : entityA.stats.atk;
            const baseFinalDmgA = Math.max(0, rawDmgA - entityB.stats.def);
            const critStreakA = updateCriticalStreakForHit(entityA, isCritA);
            const finalDmgA = isCritA ? applyCriticalStreakDamage(baseFinalDmgA, entityA, critStreakA) : baseFinalDmgA;
            let rpmLostByB = 0;

            if (entityB.currentRpm !== undefined) {
                const rpmBefore = entityB.currentRpm;
                entityB.currentRpm = Math.max(0, entityB.currentRpm - finalDmgA);
                rpmLostByB = rpmBefore - entityB.currentRpm;
                if (isCritA && rpmBefore > 0 && entityB.currentRpm <= 0 && finalDmgA > 0) {
                    entityB.criticalKo = true;
                }
            }

            // B hits A
            const rawDmgB = isCritB ? entityB.stats.crtAtk : entityB.stats.atk;
            const baseFinalDmgB = Math.max(0, rawDmgB - entityA.stats.def);
            const critStreakB = updateCriticalStreakForHit(entityB, isCritB);
            const finalDmgB = isCritB ? applyCriticalStreakDamage(baseFinalDmgB, entityB, critStreakB) : baseFinalDmgB;
            let rpmLostByA = 0;

            if (entityA.currentRpm !== undefined) {
                const rpmBefore = entityA.currentRpm;
                entityA.currentRpm = Math.max(0, entityA.currentRpm - finalDmgB);
                rpmLostByA = rpmBefore - entityA.currentRpm;
                if (isCritB && rpmBefore > 0 && entityA.currentRpm <= 0 && finalDmgB > 0) {
                    entityA.criticalKo = true;
                }
            }


            // Sparks & Sound
            const isHighSpeed = isCritA || isCritB;
            if (isCritA) getMatchCounterSide(entityA)!.criticalHits += 1;
            if (isCritB) getMatchCounterSide(entityB)!.criticalHits += 1;
            const count = isHighSpeed ? 24 : 3;
            const speed = isHighSpeed ? 9 : 2;
            const criticalFlashPoint = getCollisionWorldPoint(pair);

            if (pair.collision.supports.length > 0) {
                const { x, y } = pair.collision.supports[0];
                for (let i = 0; i < count; i++) {
                    if (isCritA)
                        createSpark(x, y, entityA.stats.trailColor, speed);
                    if (isCritB)
                        createSpark(x, y, entityB.stats.trailColor, speed);
                    if (!isCritA && !isCritB)
                        createSpark(x, y, 0xaaaaaa, speed);
                }
                if (isHighSpeed) {
                    for (let i = 0; i < 10; i++) {
                        createSpark(x, y, 0xffffff, speed + 3);
                    }
                }
            }
            if (isHighSpeed) {
                triggerCriticalFeedback(criticalFlashPoint);
                if (isCritA) notifyTutorialCriticalHit(entityA, {
                    crit: entityA.stats.crtAtk,
                    def: entityB.stats.def,
                    dmg: finalDmgA,
                    rpmLost: rpmLostByB,
                    streak: critStreakA
                });
                if (isCritB) notifyTutorialCriticalHit(entityB, {
                    crit: entityB.stats.crtAtk,
                    def: entityA.stats.def,
                    dmg: finalDmgB,
                    rpmLost: rpmLostByA,
                    streak: critStreakB
                });
                playCollisionSound(0.34, 675, true);
            } else {
                playCollisionSound(0.2, 200); // Normal Pitch
            }
        } else {
            // Fallback / Wall hits
            // If one is a Beyblade and the other is not (Environment), apply Barrier Damage
            if (entityA && !entityB) {
                resetCriticalStreak(getCriticalOwner(entityA));
                // A hit a wall
                let rpmLost = 0;
                if (entityA.currentRpm !== undefined) {
                    const rpmBefore = entityA.currentRpm;
                    entityA.currentRpm = Math.max(0, entityA.currentRpm - BARRIER_DAMAGE);
                    rpmLost = rpmBefore - entityA.currentRpm;
                }
                getMatchCounterSide(entityA)!.wallDings += 1;
                if (entityA === enemy && isHardCpuMode()) {
                    cpuLastWallHitAt = clock.getElapsedTime();
                    cpuNextDiveSwitchAt = Math.min(cpuNextDiveSwitchAt, cpuLastWallHitAt);
                }
                notifyTutorialWallHit(entityA, { dmg: BARRIER_DAMAGE, rpmLost });
            } else if (entityB && !entityA) {
                resetCriticalStreak(getCriticalOwner(entityB));
                // B hit a wall
                let rpmLost = 0;
                if (entityB.currentRpm !== undefined) {
                    const rpmBefore = entityB.currentRpm;
                    entityB.currentRpm = Math.max(0, entityB.currentRpm - BARRIER_DAMAGE);
                    rpmLost = rpmBefore - entityB.currentRpm;
                }
                getMatchCounterSide(entityB)!.wallDings += 1;
                if (entityB === enemy && isHardCpuMode()) {
                    cpuLastWallHitAt = clock.getElapsedTime();
                    cpuNextDiveSwitchAt = Math.min(cpuNextDiveSwitchAt, cpuLastWallHitAt);
                }
                notifyTutorialWallHit(entityB, { dmg: BARRIER_DAMAGE, rpmLost });
            }

            if (pair.collision.supports.length > 0) {
                const { x, y } = pair.collision.supports[0];
                for (let i = 0; i < 5; i++) {
                    createSpark(x, y, 0xaaaaaa, 2);
                }
            }
            playCollisionSound(0.5, 100 * 1.67);
        }

    });
});


// --- Game Loop ---
type TNavigatorWithDeviceMemory = Navigator & { deviceMemory?: number };

function shouldUseReducedPhysicsWork() {
    const nav = navigator as TNavigatorWithDeviceMemory;
    const cores = nav.hardwareConcurrency || 4;
    const memory = nav.deviceMemory;
    const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    const compactScreen = Math.min(window.innerWidth, window.innerHeight) < 820;
    return cores <= 4 || (memory !== undefined && memory <= 4) || (coarsePointer && compactScreen);
}

const REDUCED_PHYSICS_WORK = shouldUseReducedPhysicsWork();

function getPhysicsSubsteps(speedMultiplier: number) {
    if (speedMultiplier <= 0.35) return REDUCED_PHYSICS_WORK ? 2 : 3;
    if (speedMultiplier >= 1.75) return REDUCED_PHYSICS_WORK ? 3 : 4;
    return REDUCED_PHYSICS_WORK ? 3 : 4;
}

function scatterBeyParts(entity: GameEntity) {
    if (entity.looseParts?.length) return;

    entity.mesh.updateMatrixWorld(true);
    const partObjects = [...entity.spinGroup.children];
    const origin = entity.mesh.position.clone();
    const baseVelocity = entity.driftVelocity?.clone() || new THREE.Vector3();
    const looseParts: TLooseBeyPart[] = [];
    const vortex = entity.mesh.userData.vortex as THREE.Object3D | undefined;
    if (vortex) vortex.visible = false;

    partObjects.forEach((part, index) => {
        part.updateMatrixWorld(true);
        scene.attach(part);

        const fromCenter = part.position.clone().sub(origin);
        if (fromCenter.lengthSq() < 0.01) {
            const angle = (index / Math.max(1, partObjects.length)) * Math.PI * 2;
            fromCenter.set(Math.cos(angle), 0.28, Math.sin(angle));
        }
        fromCenter.normalize();

        const tangent = new THREE.Vector3(-fromCenter.z, 0.18 + Math.random() * 0.22, fromCenter.x).normalize();
        const spread = 2.4 + Math.random() * 2.6 + index * 0.28;
        const velocity = baseVelocity.clone().multiplyScalar(0.16)
            .addScaledVector(fromCenter, spread)
            .addScaledVector(tangent, 1.1 + Math.random() * 1.4);
        velocity.y = Math.max(0.85, velocity.y + 0.6 + Math.random() * 1.6);

        looseParts.push({
            object: part,
            velocity,
            rotationVelocity: new THREE.Vector3(
                randomFromRange(-0.18, 0.18),
                randomFromRange(-0.24, 0.24),
                randomFromRange(-0.18, 0.18)
            )
        });
    });

    entity.looseParts = looseParts;
}

function updateLooseBeyParts(entity: GameEntity, scale: number) {
    entity.looseParts?.forEach((part) => {
        part.object.position.addScaledVector(part.velocity, scale);
        part.object.rotation.x += part.rotationVelocity.x * scale;
        part.object.rotation.y += part.rotationVelocity.y * scale;
        part.object.rotation.z += part.rotationVelocity.z * scale;
        part.velocity.y -= 0.035 * scale;
    });
}

function clearLooseBeyParts(entity: GameEntity) {
    entity.looseParts?.forEach((part) => {
        part.object.parent?.remove(part.object);
    });
    entity.looseParts = undefined;
    entity.criticalKo = false;
}

let frameCounter = 0;


function animate() {
    requestAnimationFrame(animate);

    // Physics Update
    const simulationPaused = tutorialPauseActive;
    const finishSlowMoActive = clock.getElapsedTime() < finishSlowMoUntil;
    const speedMultiplier = GAME_SPEEDS[currentGameSpeed].multiplier
        * (tutorialSlowMoActive ? 0.28 : 1)
        * (finishSlowMoActive ? 0.18 : 1);
    const physicsSubsteps = simulationPaused ? 0 : getPhysicsSubsteps(speedMultiplier);
    const subStepDelta = physicsSubsteps > 0 ? ((1000 / 60) * speedMultiplier) / physicsSubsteps : 0;
    if (!simulationPaused) updateCpuDive(clock.getElapsedTime());
    for (let i = 0; i < physicsSubsteps && !simulationPaused; i++) {
        processScheduledDiveEvents();
        Engine.update(engine, subStepDelta);

        if (hasLaunched) {
            entities.forEach(entity => {
                if (entity.isDead) return; // Skip physics forces for dead entities

                // Beyblade-Specific Forces (Dish + Curl)
                if (entity.stats) {
                    const px = entity.body.position.x;
                    const py = entity.body.position.y;
                    const dist = Math.sqrt(px * px + py * py);

                    // --- Speed Threshold Visuals (Ground Sparks) ---
                    const speed = entity.body.speed;
                    if (speed > CRIT_SPEED_THRESHOLD) {
                        // Throttled spawn (random chance per frame)
                        if (Math.random() < 0.3) {
                            // Spark at contact point (approximate ground contact)
                            // We can use current position, maybe slightly offset opposite to velocity
                            createSpark(px, py, entity.stats.trailColor, 2);
                        }
                    }

                    // Normalized radial direction (toward center)
                    const safeDist = Math.max(dist, 1);
                    const radialX = -px / safeDist;
                    const radialY = -py / safeDist;


                    // Tangent direction (perpendicular, clockwise)
                    // Rotate radial 90° clockwise: (x, y) -> (y, -x)
                    const tangentX = radialY;
                    const tangentY = -radialX;

                    if (entity.currentRpm === undefined) return;
                    // const life = entity.currentRpm / entity.stats.maxRpm;
                    // Calculate force magnitudes
                    const dishMagnitude = FORCE_CONSTANT * entity.body.mass * safeDist * entity.stats.dishForce;
                    const curlMagnitude = FORCE_CONSTANT * entity.body.mass * (1 - safeDist / ARENA_RADIUS) * entity.stats.curlForce;

                    // Apply combined force
                    Body.applyForce(entity.body, entity.body.position, {
                        x: radialX * dishMagnitude + tangentX * curlMagnitude,
                        y: radialY * dishMagnitude + tangentY * curlMagnitude
                    });

                    const isDiving = (entity === player && currentPatternIndex === 1) || (entity === enemy && cpuPatternIndex === 1);
                    if (isDiving && speed > 0.1) {
                        Body.applyForce(entity.body, entity.body.position, {
                            x: (entity.body.velocity.x / speed) * DIVE_BOOST_FORCE * entity.body.mass,
                            y: (entity.body.velocity.y / speed) * DIVE_BOOST_FORCE * entity.body.mass
                        });
                    }
                }
            });
        }
        if (hasLaunched && multiplayer.role !== 'solo') {
            multiplayer.matchTime += subStepDelta / 1000;
        }
    }
    if (!simulationPaused) maybeSendMatterWorldStateSample();

    // Update Visuals
    entities.forEach(entity => {

        // --- Death Logic Check ---

        if (!entity.isDead && entity.currentRpm !== undefined && hasLaunched) {
            const pos = entity.mesh.position;
            // Ring Out Check
            const dist = Math.sqrt(pos.x * pos.x + pos.z * pos.z);
            const RING_OUT_RADIUS = 350; // Arena is 300

            if (entity.currentRpm <= 0 || dist > RING_OUT_RADIUS) {
                // Trigger Death
                entity.isDead = true;
                entity.currentRpm = 0;

                // Capture last velocity before removing body
                const vx = entity.body.velocity.x;
                const vz = entity.body.velocity.y; // Matter Y is Three Z

                // Calculate Vertical Velocity based on Slope (Tangent)
                // H = k * r^2
                // k = MAX_H / R^2
                // vy = dH/dt = dH/dx * vx + dH/dz * vz
                const k = BOWL_MAX_HEIGHT / (ARENA_RADIUS * ARENA_RADIUS);
                const vy = (2 * k * pos.x * vx) + (2 * k * pos.z * vz);

                const speed = Math.sqrt(vx * vx + vz * vz);

                let driftV = new THREE.Vector3(vx, vy, vz);

                if (speed < 0.5) {
                    // If it died standing still (Stamina 0), give it a gentle float
                    driftV = new THREE.Vector3(
                        (Math.random() - 0.5) * 0.5,
                        0.5, // Slow float up
                        (Math.random() - 0.5) * 0.5
                    );
                } else {
                    // Conserve momentum.
                    // Scale slightly to make the "breakaway" feel impactful
                    driftV.multiplyScalar(1.2);
                    driftV.y += 0.5; // Slight lift to simulate "loss of gravity/grip"
                }

                // Ensure it flies UP (Positive Y)
                if (driftV.y < 0) {
                    driftV.y = -driftV.y;
                }
                // Minimum lift to clear the floor
                driftV.y = Math.max(driftV.y, 0.5);
                driftV.clampLength(0.3, 8);

                entity.driftVelocity = driftV;

                entity.driftRotation = new THREE.Vector3(
                    randomFromRange(-0.012, 0.012),
                    randomFromRange(-0.018, 0.018),
                    randomFromRange(-0.012, 0.012)
                );
                if (entity.criticalKo && entity.currentRpm <= 0) {
                    scatterBeyParts(entity);
                }

                // Remove from Physics World
                Composite.remove(engine.world, entity.body);

                // Win Condition Check
                if (!gameOver) {
                    gameOver = true;
                    if (entity === player) {
                        triggerWinningShot(entity, `${getOpponentLabel()} WINS`, enemy.stats?.trailColor || ENEMY_STATS.trailColor);
                    } else if (entity === enemy) {
                        triggerWinningShot(entity, 'P1 WINS', player.stats?.trailColor || PLAYER_STATS.trailColor);
                    }
                }
            }
        }

        // --- Visual Update ---
        if (entity.isDead) {
            // Asteroid Mode
            if (entity.driftVelocity && entity.driftRotation) {
                const koFinishActive = clock.getElapsedTime() < finishSlowMoUntil;
                const driftScale = koFinishActive ? KO_FINISH_DRIFT_SCALE : 1;
                const rotationScale = koFinishActive ? KO_FINISH_ROTATION_SCALE : 1;
                if (entity.looseParts?.length) {
                    updateLooseBeyParts(entity, driftScale);
                } else {
                    entity.mesh.position.addScaledVector(entity.driftVelocity, driftScale);
                    entity.mesh.rotation.x += entity.driftRotation.x * rotationScale;
                    entity.mesh.rotation.y += entity.driftRotation.y * rotationScale;
                    entity.mesh.rotation.z += entity.driftRotation.z * rotationScale;
                }

                // Slight fade? Or just fly away.
            }
            return; // Skip normal sync
        }

        // Sync position: Matter (x, y) -> Three (x, z).
        const x = entity.body.position.x;
        const z = entity.body.position.y;

        // Get height from bowl shape
        const y = getArenaHeight(x, z) + 10;
        entity.mesh.position.set(x, y, z);

        // Align to surface normal
        const normal = getArenaNormal(x, z);
        const up = new THREE.Vector3(0, 1, 0);
        const quaternion = new THREE.Quaternion().setFromUnitVectors(up, normal);
        entity.mesh.quaternion.copy(quaternion); // Set base orientation to surface

        // Spin
        entity.spinGroup.rotation.y = -entity.body.angle;

        // Additional Tilt logic (Wobble based on velocity)
        const vel = entity.body.velocity;
        const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
        const isCriticalMode = speed > CRIT_SPEED_THRESHOLD;
        const streakOpacityStep = Math.min(getCriticalStreak(entity), 5) * 0.1;
        const vortexOpacity = Math.max(isCriticalMode ? 0.1 : 0.035, streakOpacityStep);
        updateBeyVortex(
            entity.mesh,
            clock.getElapsedTime(),
            speed,
            entity.currentRpm || 0,
            entity.stats?.maxRpm || 1000,
            entity === player ? 1 : -1,
            entity.stats?.trailColor,
            vortexOpacity
        );
        const maxTilt = 0.5;
        const tiltAmount = Math.min((speed / 20) * maxTilt, maxTilt);

        // Tilt direction should be perpendicular to movement or just "wobbly"
        if (speed > 0.1) {
            const angle = Math.atan2(vel.y, vel.x);
            // Tilt axis is perpendicular to angle. Apply to tiltGroup.
            entity.tiltGroup.rotation.x = Math.sin(angle) * tiltAmount;
            entity.tiltGroup.rotation.z = -Math.cos(angle) * tiltAmount;
        }

        if (speed < 1.0) {
            entity.tiltGroup.rotation.x *= 0.95;
            entity.tiltGroup.rotation.z *= 0.95;
        }

        // Update Trail - Lift slightly above surface
        entity.trail.update(x, y + 2, z);

        // --- RPG Stats Logic ---
        if (entity.stats && entity.currentRpm !== undefined) {
            // Stamina Decay
            // Lose STA per second
            const decay = entity.stats.sta * (subStepDelta / 1000) * physicsSubsteps;
            if (entity.currentRpm > 0) {
                entity.currentRpm = Math.max(0, entity.currentRpm - decay);
            }

            // Force Physics to match RPM Health
            // RPM to Angular Velocity (rad/s) approx factor
            // 100 RPM ~= 1 rad/s (simplified for game feel)
            const targetAngularVelocity = entity.currentRpm / 100;

            // Direction varies? For now assume positive/counter-clockwise.
            // If it was spinning, keep sign. If 0, no spin.
            const sign = Math.sign(entity.body.angularVelocity) || 1;

            Body.setAngularVelocity(entity.body, targetAngularVelocity * sign);
        }
    });

    // Update Sparks
    for (let i = sparks.length - 1; i >= 0; i--) {
        const spark = sparks[i];
        spark.mesh.position.add(spark.velocity);
        spark.velocity.y -= 0.1; // Gravity

        // Bowl bounce check
        const groundHeight = getArenaHeight(spark.mesh.position.x, spark.mesh.position.z);
        if (spark.mesh.position.y < groundHeight) {
            spark.velocity.y *= -0.5;
            spark.mesh.position.y = groundHeight;
            spark.velocity.x *= 0.8;
            spark.velocity.z *= 0.8;
        }

        spark.life -= 0.02;
        (spark.mesh.material as THREE.MeshBasicMaterial).opacity = spark.life;

        if (spark.life <= 0) {
            scene.remove(spark.mesh);
            sparks.splice(i, 1);
        }
    }

    // Update Drag Line
    if (isDragging) {
        // Sync Start point with player position (in case player moves while dragging)
        const positions = dragLine.geometry.attributes.position.array as Float32Array;
        positions[0] = player.body.position.x;
        positions[1] = getArenaHeight(player.body.position.x, player.body.position.y) + 5;
        positions[2] = player.body.position.y;
        dragLine.geometry.attributes.position.needsUpdate = true;
    }

    // UI Updates
    frameCounter++;
    if (frameCounter % 10 === 0) {
        // Use Stats RPM as source of truth, fallback to physics if undefined (e.g. pre-launch)
        // If dead, force 0.
        const playerRpm = player.isDead ? 0 : Math.round(player.currentRpm || 0);
        const enemyRpm = enemy.isDead ? 0 : Math.round(enemy.currentRpm || 0);

        if (playerRpmEl && playerRpmEl.innerText !== playerRpm.toString()) {
            playerRpmEl.innerText = playerRpm.toString();
        }
        if (enemyRpmEl && enemyRpmEl.innerText !== enemyRpm.toString()) {
            enemyRpmEl.innerText = enemyRpm.toString();
        }

        if (playerMeterEl && playerMeterEl.value !== playerRpm) {
            playerMeterEl.value = playerRpm;
        }
        if (enemyMeterEl && enemyMeterEl.value !== enemyRpm) {
            enemyMeterEl.value = enemyRpm;
        }
        playerMeterEl.title = `P1 RPM ${playerRpm}`;
        enemyMeterEl.title = `${getOpponentLabel()} RPM ${enemyRpm}`;

    }

    // Update controls
    clearCameraShakeOffset();
    controls.update();
    updateCameraShake();
    syncCriticalFlashPlaneToCamera();
    updateBeyNoiseLayers();
    updateTutorialFlow(clock.getElapsedTime());

    if (!hasLaunched && !launchCountdownOverlay) {
        const angle = currentLaunchAngle.value;
        updateGuide(angle);
        guideMesh.visible = true;
        arrowMat.uniforms.uTime.value = clock.getElapsedTime();
    } else {
        guideMesh.visible = false;
        if (hasLaunched) launchContainer.style.display = 'none';
    }

    updateCriticalFlash();
    renderer.render(scene, camera);


}
// --- Visual Forge Helpers ---

function createInput(id: string, label: string, value: any, hint: string, type: string, step: number | string, onChange: (val: any) => void) {
    const div = document.createElement('div');
    div.className = 'stat-item';
    div.title = `${label}: ${hint}`;

    // Handle color values (hex num to #hex str)
    let displayValue = value;
    if (type === 'color') {
        const safeVal = value ?? 0; // Fallback to black if undefined
        displayValue = '#' + safeVal.toString(16).padStart(6, '0');
    }

    div.innerHTML = `
        <label class="stat-label" for="${id}">${label}</label>
        <input class="stat-input" type="${type}" ${type === 'number' ? `step="${step}"` : ''} id="${id}" value="${displayValue}" aria-label="${label}" title="${label}">
        <span class="stat-hint">${hint}</span>
    `;

    const input = div.querySelector('input')!;
    input.addEventListener('input', (e) => {
        let val: any = (e.target as HTMLInputElement).value;
        if (type === 'number') val = parseFloat(val);
        if (type === 'color') val = parseInt(val.replace('#', ''), 16);
        onChange(val);
    });

    return div;
}

// Preview Scene Helper
// WebGL Renderer Pool (max 3 contexts to prevent exhaustion)
const rendererPool: THREE.WebGLRenderer[] = [];
const MAX_RENDERERS = 3;
let totalCreatedRenderers = 0;

function getOrCreateRenderer(): THREE.WebGLRenderer {
    // Try to reuse an existing renderer
    if (rendererPool.length > 0) {
        return rendererPool.pop()!;
    }

    // Create new renderer if under limit
    if (totalCreatedRenderers < MAX_RENDERERS) {
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        totalCreatedRenderers++;
        // console.log(`Created new renderer. Total: ${totalCreatedRenderers}`);
        return renderer;
    }

    // Fallback: create without adding to pool (shouldn't happen)
    console.warn('Renderer pool exhausted, creating temporary renderer');
    return new THREE.WebGLRenderer({ antialias: true, alpha: true });
}

function returnRenderer(renderer: THREE.WebGLRenderer) {
    // Clear the renderer's DOM parent
    if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
    }

    // Return to pool if under limit
    if (rendererPool.length < MAX_RENDERERS) {
        rendererPool.push(renderer);
    } else {
        // Dispose if pool is full
        renderer.dispose();
    }
}

let previewRenderer: THREE.WebGLRenderer | null = null;
let previewScene: THREE.Scene | null = null;
let previewCamera: THREE.PerspectiveCamera | null = null;
let previewControls: OrbitControls | null = null;
let previewBeyblade: { mesh: THREE.Group, tiltGroup: THREE.Group, spinGroup: THREE.Group } | null = null;
let previewResizeObserver: ResizeObserver | null = null;

function updatePreview(stats: BeybladeStats) {
    if (!previewScene) return;
    if (previewBeyblade) {
        previewScene.remove(previewBeyblade.mesh);
    }
    previewBeyblade = createBeybladeMesh(stats);
    previewScene.add(previewBeyblade.mesh);
    fitPreviewCameraToBey();
}

function fitPreviewCameraToBey() {
    if (!previewCamera || !previewBeyblade) return;

    const box = new THREE.Box3().setFromObject(previewBeyblade.mesh);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxSize = Math.max(size.x, size.y, size.z, 1);
    const fitDistance = (maxSize / (2 * Math.tan(THREE.MathUtils.degToRad(previewCamera.fov) / 2))) * 1.45;

    previewCamera.position.set(center.x, center.y + maxSize * 0.62, center.z + fitDistance);
    previewCamera.near = Math.max(0.1, fitDistance / 100);
    previewCamera.far = fitDistance * 100;
    previewCamera.lookAt(center);
    previewCamera.updateProjectionMatrix();

    if (previewControls) {
        previewControls.target.copy(center);
        previewControls.update();
    }
}

// --- Stat Changer UI ---
function getCustomizationTargetId(targetName: string) {
    return targetName.toLowerCase() === 'player' ? 'player' : 'opponent';
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function openStatEditor(targetStats: BeybladeStats, targetName: string) {
    try {
        const isPlayerTarget = targetStats === PLAYER_STATS;
        const customizationTarget = getCustomizationTargetId(targetName);
        trackGameEvent('bey_customization_opened', {
            target: customizationTarget,
            mode: multiplayer.role !== 'solo' ? 'online' : localPlayMode
        });

        // Create a working copy of stats so we don't apply immediately
        let tempStats = JSON.parse(JSON.stringify(targetStats)) as BeybladeStats;


        const dialog = document.createElement('dialog');
        dialog.className = 'stat-editor-dialog';

        const container = document.createElement('div');
        container.className = 'dialog-container';
        dialog.appendChild(container);

        const header = document.createElement('div');
        header.className = 'modal-header';
        header.innerHTML = `<span class="modal-title">Customise ${targetName}</span>`;

        const closeBtn = document.createElement('button');
        closeBtn.className = 'modal-close';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.innerHTML = `
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 6L18 18M18 6L6 18" />
            </svg>
        `;
        closeBtn.onclick = () => dialog.close();
        header.appendChild(closeBtn);
        container.appendChild(header);

        const layout = document.createElement('div');
        layout.className = 'customizer-layout';
        container.appendChild(layout);

        const previewColumn = document.createElement('div');
        previewColumn.className = 'preview-column';
        layout.appendChild(previewColumn);

        const previewContainer = document.createElement('div');
        previewContainer.className = 'preview-float';
        previewColumn.appendChild(previewContainer);

        const customizeBtn = document.createElement('button');
        customizeBtn.type = 'button';
        customizeBtn.className = 'preview-customize-btn';
        customizeBtn.title = 'Customize visual parameters';
        customizeBtn.setAttribute('aria-label', 'Customize visual parameters');
        customizeBtn.innerHTML = `
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
                <circle cx="16" cy="7" r="2" />
                <circle cx="8" cy="17" r="2" />
            </svg>
        `;
        previewContainer.appendChild(customizeBtn);

        const statMeterPanel = document.createElement('div');
        statMeterPanel.className = 'stat-meter-panel';
        previewColumn.appendChild(statMeterPanel);

        const randomizeBtn = document.createElement('button');
        randomizeBtn.className = 'icon-action-btn randomize-btn';
        randomizeBtn.type = 'button';
        randomizeBtn.title = 'Random build';
        randomizeBtn.setAttribute('aria-label', 'Random build');
        randomizeBtn.innerHTML = `
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M16 3h5v5M4 20l17-17M21 16v5h-5M15 15l6 6M4 4l5 5" />
            </svg>
            <span>Random</span>
        `;

        const detachedVisualControls = document.createElement('div');

        type TStatMeterConfig = {
            key: keyof BeybladeStats;
            label: string;
            max: number;
            step: number;
            format: (value: number) => string;
        };

        const STAT_METER_CONFIGS: TStatMeterConfig[] = [
            { key: 'atk', label: 'ATK', max: 14, step: 1, format: (value) => Math.round(value).toString() },
            { key: 'def', label: 'DEF', max: 11, step: 1, format: (value) => Math.round(value).toString() },
            { key: 'sta', label: 'STA', max: 2, step: 0.1, format: (value) => value.toFixed(1) },
            { key: 'spd', label: 'SPD', max: 80, step: 1, format: (value) => Math.round(value).toString() },
            { key: 'wt', label: 'WGT', max: 1.6, step: 0.01, format: (value) => value.toFixed(2) },
            { key: 'crtAtk', label: 'CRT', max: 35, step: 1, format: (value) => Math.round(value).toString() }
        ];

        let customizationDirty = false;
        let closeHandled = false;

        function markCustomizationDirty() {
            customizationDirty = true;
        }

        STAT_METER_CONFIGS.forEach((field) => {
            const row = document.createElement('div');
            row.className = 'stat-meter-row';
            row.dataset.statKey = field.key;
            row.innerHTML = `
                <span class="stat-meter-label">${field.label}</span>
                <span class="stat-meter-track">
                    <span class="stat-meter-fill"></span>
                    <input class="stat-meter-range" type="range" min="0" max="${field.max}" step="${field.step}" value="0" aria-label="${field.label}">
                </span>
                <span class="stat-meter-value">0</span>
            `;
            const range = row.querySelector<HTMLInputElement>('.stat-meter-range');
            range?.addEventListener('input', (event) => {
                const value = Number((event.target as HTMLInputElement).value);
                (tempStats as any)[field.key] = value;
                markCustomizationDirty();
                refreshStatMeters();
            });
            statMeterPanel.appendChild(row);
        });

        function refreshStatMeters() {
            STAT_METER_CONFIGS.forEach((field) => {
                const row = statMeterPanel.querySelector<HTMLElement>(`[data-stat-key="${field.key}"]`);
                if (!row) return;
                const rawValue = Number((tempStats as any)[field.key] ?? 0);
                const meter = row.querySelector<HTMLElement>('.stat-meter-track');
                const fill = row.querySelector<HTMLElement>('.stat-meter-fill');
                const valueEl = row.querySelector<HTMLElement>('.stat-meter-value');
                const range = row.querySelector<HTMLInputElement>('.stat-meter-range');
                const clampedValue = Math.min(rawValue, field.max);
                if (meter) meter.style.setProperty('--meter-fill', `${(clampedValue / field.max) * 100}%`);
                if (fill) {
                    fill.style.width = `${(clampedValue / field.max) * 100}%`;
                    fill.style.height = '100%';
                }
                if (range && range.value !== String(clampedValue)) range.value = String(clampedValue);
                if (valueEl) valueEl.textContent = field.format(rawValue);
            });
        }

        function refreshEditorValues() {
            [...VISUAL_FIELDS, ...COMBAT_FIELDS].forEach(field => {
                const visualInput = detachedVisualControls.querySelector<HTMLInputElement>(`#v-${field.key}`);
                if (visualInput) {
                    const value = (tempStats as any)[field.key];
                    visualInput.value = field.type === 'color' ? `#${numberToHex(value ?? 0)}` : String(value);
                }
            });
            refreshStatMeters();
        }

        refreshStatMeters();

        function commitCustomization() {
            const previousStatsKey = stableStringify(targetStats);
            syncTrailWithBolt(tempStats);
            sanitizePartMatcaps(tempStats);
            enforceBeyColorContrast(tempStats);
            const changed = customizationDirty || previousStatsKey !== stableStringify(tempStats);

            trackGameEvent('bey_customization_applied', {
                target: customizationTarget,
                mode: multiplayer.role !== 'solo' ? 'online' : localPlayMode,
                changed
            });

            if (!changed) return false;

            trackGameEvent('bey_customized_new', { target: customizationTarget });
            if (customizationTarget === 'player') trackGameEvent('player_bey_customized_new');

            Object.assign(targetStats, tempStats);

            if (isPlayerTarget) matchStartPlayerStats = JSON.parse(JSON.stringify(targetStats));
            else matchStartEnemyStats = JSON.parse(JSON.stringify(targetStats));

            savePresets();
            if (isPlayerTarget) sendLocalBeyEdit();
            return true;
        }

        randomizeBtn.onclick = async () => {
            trackGameEvent('bey_customization_randomized', { target: customizationTarget });
            randomizeBtn.title = 'Random build';
            randomizeBtn.disabled = true;
            const preset = BEY_PRESETS[Math.floor(Math.random() * BEY_PRESETS.length)];
            const seededStats = {
                ...JSON.parse(JSON.stringify(targetStats)),
                ...JSON.parse(JSON.stringify(preset.stats))
            } as BeybladeStats;
            tempStats = buildRandomBeyStats(seededStats);
            syncTrailWithBolt(tempStats);
            markCustomizationDirty();
            refreshEditorValues();
            updatePreview(tempStats);
            renderMatcapGrid();
            randomizeBtn.title = 'Random build';
            randomizeBtn.disabled = false;
        };

        // Setup Preview Scene
        requestAnimationFrame(() => {
            const width = Math.max(previewContainer.clientWidth, 1);
            const height = Math.max(previewContainer.clientHeight, 1);

            previewRenderer = getOrCreateRenderer();
            previewRenderer.setSize(width, height);
            previewRenderer.setClearColor(0x808080, 1);
            previewContainer.appendChild(previewRenderer.domElement);

            previewScene = new THREE.Scene();
            previewScene.background = new THREE.Color(0x808080);
            previewCamera = new THREE.PerspectiveCamera(45, width / height, 1, 1000);
            previewCamera.position.set(0, 44, 72);
            previewCamera.lookAt(0, 5, 0);

            previewControls = new OrbitControls(previewCamera, previewRenderer.domElement);
            previewControls.enableDamping = false;

            const resizePreview = () => {
                if (!previewRenderer || !previewCamera) return;
                const nextWidth = Math.max(previewContainer.clientWidth, 1);
                const nextHeight = Math.max(previewContainer.clientHeight, 1);
                previewRenderer.setSize(nextWidth, nextHeight);
                previewCamera.aspect = nextWidth / nextHeight;
                previewCamera.updateProjectionMatrix();
                fitPreviewCameraToBey();
            };
            previewResizeObserver = new ResizeObserver(resizePreview);
            previewResizeObserver.observe(previewContainer);

            const ambient = new THREE.AmbientLight(0xffffff, 1.7);
            previewScene.add(ambient);
            const dir = new THREE.DirectionalLight(0xffffff, 2.2);
            dir.position.set(10, 50, 20);
            previewScene.add(dir);

            updatePreview(tempStats);

            function animatePreview() {
                if (!previewRenderer) return;
                requestAnimationFrame(animatePreview);

                if (previewBeyblade) {
                    updateBeyVortex(previewBeyblade.mesh, clock.getElapsedTime(), 10, tempStats.maxRpm * 0.72, tempStats.maxRpm, 1, tempStats.trailColor);
                    previewBeyblade.mesh.rotation.y += 0.018;
                    previewBeyblade.spinGroup.rotation.y += 0.04;
                }
                if (previewControls) previewControls.update();
                previewRenderer.render(previewScene!, previewCamera!);
            }
            animatePreview();
        });

        const matcapSection = document.createElement('div');
        matcapSection.className = 'stat-section material-section';
        matcapSection.innerHTML = '<div class="section-title">Parts</div>';
        detachedVisualControls.appendChild(matcapSection);

        const parts: Array<{ id: TMatcapPart, label: string, colorKey: keyof BeybladeStats, shapeKeys: Array<keyof BeybladeStats> }> = [
            { id: 'wheel', label: 'Base', colorKey: 'wheelColor', shapeKeys: ['beyScale', 'wheelWidthFactor', 'wheelHeightFactor'] },
            { id: 'ring', label: 'Ring', colorKey: 'ringColor', shapeKeys: ['ringRadiusFactor', 'ringWidthFactor', 'ringHeightFactor', 'ringSides'] },
            { id: 'bolt', label: 'Bolt', colorKey: 'boltColor', shapeKeys: ['boltWidthFactor', 'boltHeightFactor', 'boltSides'] },
            { id: 'spinTrack', label: 'Track', colorKey: 'spinTrackColor', shapeKeys: ['spinTrackSize', 'spinTrackHeightFactor'] },
            { id: 'tip', label: 'Tip', colorKey: 'tipColor', shapeKeys: ['tipSize', 'tipHeightFactor'] }
        ];
        const visualFieldByKey = new Map(VISUAL_FIELDS.map(field => [field.key, field]));

        const materialList = document.createElement('div');
        materialList.className = 'part-material-list';
        matcapSection.appendChild(materialList);

        parts.forEach((part) => {
            const partCard = document.createElement('div');
            partCard.className = 'part-material-card';
            partCard.dataset.part = part.id;
            partCard.innerHTML = `<div class="part-material-title">${part.label}</div>`;

            const colorControl = createInput(
                `v-${part.colorKey}`,
                `${part.label} color`,
                (tempStats as any)[part.colorKey],
                'Color',
                'color',
                1,
                (val) => {
                    (tempStats as any)[part.colorKey] = clampBeyColor(val);
                    if (part.colorKey === 'boltColor') syncTrailWithBolt(tempStats);
                    enforceBeyColorContrast(tempStats);
                    markCustomizationDirty();
                    refreshEditorValues();
                    updatePreview(tempStats);
                }
            );
            colorControl.classList.add('part-color-control');
            partCard.appendChild(colorControl);

            const shapeGrid = document.createElement('div');
            shapeGrid.className = 'part-shape-grid';
            part.shapeKeys.forEach((key) => {
                const field = visualFieldByKey.get(key as string);
                if (!field) return;

                const shapeControl = createInput(
                    `v-${field.key}`,
                    field.label,
                    (tempStats as any)[field.key],
                    field.hint,
                    field.type,
                    field.step || 1,
                    (val) => {
                        (tempStats as any)[field.key] = val;
                        markCustomizationDirty();
                        updatePreview(tempStats);
                    }
                );
                shapeControl.classList.add('part-shape-control');
                shapeGrid.appendChild(shapeControl);
            });
            partCard.appendChild(shapeGrid);

            const swatchGrid = document.createElement('div');
            swatchGrid.className = 'matcap-grid';
            partCard.appendChild(swatchGrid);

            materialList.appendChild(partCard);
        });

        function renderMatcapGrid() {
            parts.forEach((part) => {
                const partCard = materialList.querySelector<HTMLElement>(`[data-part="${part.id}"]`);
                const grid = partCard?.querySelector<HTMLElement>('.matcap-grid');
                if (!grid) return;
                grid.innerHTML = '';

                const clearBtn = document.createElement('button');
                clearBtn.type = 'button';
                clearBtn.innerHTML = `
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M6 6L18 18M18 6L6 18" />
                    </svg>
                `;
                clearBtn.className = 'matcap-btn clear';
                clearBtn.title = `Clear ${part.label} material`;
                clearBtn.onclick = () => {
                    if (!tempStats.partMatcaps) tempStats.partMatcaps = {};
                    delete tempStats.partMatcaps[part.id];
                    markCustomizationDirty();
                    updatePreview(tempStats);
                    renderMatcapGrid();
                };
                grid.appendChild(clearBtn);

                MATCAP_LIBRARY.forEach(mc => {
                    const thumbUrl = mc.thumb;
                    const fullUrl = mc.file;
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'matcap-btn';
                    btn.title = `${part.label}: ${mc.category}`;
                    btn.style.background = `url(${thumbUrl}) center / cover`;
                    btn.classList.toggle('active', tempStats.partMatcaps?.[part.id] === fullUrl);
                    btn.onclick = () => {
                        if (!tempStats.partMatcaps) tempStats.partMatcaps = {};
                        tempStats.partMatcaps[part.id] = fullUrl;
                        markCustomizationDirty();
                        updatePreview(tempStats);
                        renderMatcapGrid();
                    };
                    grid.appendChild(btn);
                });
            });
        }

        renderMatcapGrid();

        let visualDialog: HTMLDialogElement | null = null;
        function openVisualCustomizationDialog() {
            if (visualDialog?.open) return;

            visualDialog = document.createElement('dialog');
            visualDialog.className = 'visual-customization-dialog';

            const visualContainer = document.createElement('div');
            visualContainer.className = 'visual-customization-container';
            visualDialog.appendChild(visualContainer);

            const visualHeader = document.createElement('div');
            visualHeader.className = 'modal-header';
            visualHeader.innerHTML = '<span class="modal-title">Visual customization</span>';

            const visualCloseBtn = document.createElement('button');
            visualCloseBtn.className = 'modal-close';
            visualCloseBtn.setAttribute('aria-label', 'Close');
            visualCloseBtn.innerHTML = `
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M6 6L18 18M18 6L6 18" />
                </svg>
            `;
            visualCloseBtn.onclick = () => visualDialog?.close();
            visualHeader.appendChild(visualCloseBtn);
            visualContainer.appendChild(visualHeader);

            const visualBody = document.createElement('div');
            visualBody.className = 'visual-customization-body';
            visualBody.appendChild(matcapSection);
            visualContainer.appendChild(visualBody);

            visualDialog.addEventListener('close', () => {
                detachedVisualControls.appendChild(matcapSection);
                visualDialog?.remove();
                visualDialog = null;
            });

            document.body.appendChild(visualDialog);
            visualDialog.showModal();
        }

        customizeBtn.onclick = openVisualCustomizationDialog;

        const actions = document.createElement('div');
        actions.className = 'preset-actions';

        const resetBtn = document.createElement('button');
        resetBtn.className = 'icon-action-btn reset';
        resetBtn.title = 'Reset defaults';
        resetBtn.setAttribute('aria-label', 'Reset defaults');
        resetBtn.innerHTML = `
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 4v6h6M20 20v-6h-6M5.5 15A7 7 0 0 0 17 18.5M18.5 9A7 7 0 0 0 7 5.5" />
            </svg>
            <span>Reset</span>
        `;

        resetBtn.onclick = () => {
            if (confirm(`Reset ${targetName} to defaults? This cannot be undone.`)) {
                trackGameEvent('bey_customization_reset', { target: customizationTarget });
                closeHandled = true;
                if (isPlayerTarget) Object.assign(targetStats, DEFAULT_PLAYER_STATS);
                else Object.assign(targetStats, DEFAULT_ENEMY_STATS);

                // Update snapshot so resetMatch uses new defaults
                if (isPlayerTarget) matchStartPlayerStats = JSON.parse(JSON.stringify(DEFAULT_PLAYER_STATS));
                else matchStartEnemyStats = JSON.parse(JSON.stringify(DEFAULT_ENEMY_STATS));

                savePresets();
                if (isPlayerTarget) sendLocalBeyEdit();
                dialog.close();
                resetMatch();
                syncHudButtonColors();
            }
        };

        const saveBtn = document.createElement('button');
        saveBtn.className = 'icon-action-btn save';
        saveBtn.title = 'Apply build';
        saveBtn.setAttribute('aria-label', 'Apply build');
        saveBtn.innerHTML = `
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 12l4 4L19 6" />
            </svg>
            <span>Apply</span>
        `;

        saveBtn.onclick = () => {
            const changed = commitCustomization();
            closeHandled = true;
            dialog.close();
            if (changed) {
                resetMatch();
                syncHudButtonColors();
            }
        };

        actions.appendChild(randomizeBtn);
        actions.appendChild(resetBtn);
        actions.appendChild(saveBtn);
        container.appendChild(actions);

        // Handle Dialog Close Event for Cleanup
        dialog.addEventListener('close', () => {
            if (!closeHandled) {
                trackGameEvent('bey_customization_closed', {
                    target: customizationTarget,
                    mode: multiplayer.role !== 'solo' ? 'online' : localPlayMode,
                    changed: customizationDirty,
                    applied: false
                });
                closeHandled = true;
            }
            if (visualDialog?.open) visualDialog.close();
            if (previewResizeObserver) {
                previewResizeObserver.disconnect();
                previewResizeObserver = null;
            }
            if (previewRenderer) {
                returnRenderer(previewRenderer);
                previewRenderer = null;
            }
            if (previewControls) {
                previewControls.dispose();
                previewControls = null;
            }
            if (dialog.parentNode) {
                dialog.parentNode.removeChild(dialog);
            }
        });

        document.body.appendChild(dialog);
        dialog.showModal();

    } catch (e) {
        console.error('Error opening stat editor:', e);
    }
}

// Hook up buttons
const p1Btn = document.getElementById('p1-btn');
const cpuBtn = document.getElementById('cpu-btn');

if (p1Btn) {
    p1Btn.onclick = () => {
        clearTutorialInstruction();
        openStatEditor(PLAYER_STATS, 'Player');
    };
} else {
    console.error('P1 Btn not found!');
}

if (cpuBtn) {
    cpuBtn.onclick = () => {
        if (multiplayer.role !== 'solo') return;
        clearTutorialInstruction();
        openStatEditor(ENEMY_STATS, getOpponentLabel());
    };
}

function syncOpponentHudLabel() {
    const label = getOpponentLabel();
    if (cpuBtn) {
        const isPeerOpponent = multiplayer.role !== 'solo';
        cpuBtn.textContent = label;
        cpuBtn.title = isPeerOpponent ? `${label} config is controlled by the peer` : `Customize ${label}`;
        cpuBtn.toggleAttribute('disabled', isPeerOpponent);
        cpuBtn.setAttribute('aria-disabled', String(isPeerOpponent));
    }
    enemyMeterEl.setAttribute('aria-label', `${label} RPM`);
    syncHudButtonColors();
}

function syncHudButtonColors() {
    if (p1Btn) p1Btn.style.setProperty('--bey-trail-color', `#${numberToHex(PLAYER_STATS.trailColor)}`);
    if (cpuBtn) cpuBtn.style.setProperty('--bey-trail-color', `#${numberToHex(ENEMY_STATS.trailColor)}`);
}

syncOpponentHudLabel();

let lastMenuSampleAt = 0;

function playMenuSampleHit() {
    const now = performance.now();
    if (now - lastMenuSampleAt < 180) return;
    lastMenuSampleAt = now;

    unlockAudio();
    playCollisionSound(0.24, 260, false);
}

function clearTutorialInstruction(options: { keepSlowMo?: boolean } = {}) {
    tutorialPromptEl?.remove();
    tutorialPromptEl = null;
    tutorialHighlightEl?.classList.remove('tutorial-highlight');
    tutorialHighlightEl = null;
    tutorialLayerEl?.classList.remove('tutorial-control-layer');
    tutorialLayerEl = null;
    uiContainer.classList.remove('tutorial-ui-layer');
    if (!options.keepSlowMo) tutorialSlowMoActive = false;
}

function clearTutorialWarning() {
    tutorialWarningEl?.remove();
    tutorialWarningEl = null;
    if (tutorialWarningTimeout !== undefined) {
        window.clearTimeout(tutorialWarningTimeout);
        tutorialWarningTimeout = undefined;
    }
}

function setTutorialHighlight(target: HTMLElement | null, layer: HTMLElement | null = null) {
    tutorialHighlightEl?.classList.remove('tutorial-highlight');
    tutorialLayerEl?.classList.remove('tutorial-control-layer');
    uiContainer.classList.remove('tutorial-ui-layer');

    tutorialHighlightEl = target;
    tutorialLayerEl = layer;
    target?.classList.add('tutorial-highlight');
    layer?.classList.add('tutorial-control-layer');
    if (target && uiContainer.contains(target)) {
        uiContainer.classList.add('tutorial-ui-layer');
    }
}

type TTutorialArrowAlignment = 'start' | 'middle' | 'end';

function positionTutorialMessage(
    overlay: HTMLElement,
    target: HTMLElement | null,
    fallback: 'bottom-left' | 'top-center' = 'bottom-left',
    arrowAlignment: TTutorialArrowAlignment = 'start'
) {
    const message = overlay.querySelector<HTMLElement>('.tutorial-game-message');
    if (!message) return;

    const margin = 12;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const messageRect = message.getBoundingClientRect();
    let left = margin;
    let top = margin;
    let arrowSide = 'none';

    if (target) {
        const rect = target.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const roomAbove = rect.top;
        const roomBelow = viewportHeight - rect.bottom;
        const roomRight = viewportWidth - rect.right;
        const roomLeft = rect.left;

        if (roomAbove >= messageRect.height + 18 && centerY > viewportHeight * 0.48) {
            top = rect.top - messageRect.height - 14;
            left = centerX - messageRect.width / 2;
            arrowSide = 'bottom';
        } else if (roomBelow >= messageRect.height + 18) {
            top = rect.bottom + 14;
            left = centerX - messageRect.width / 2;
            arrowSide = 'top';
        } else if (roomRight >= messageRect.width + 18) {
            top = centerY - messageRect.height / 2;
            left = rect.right + 14;
            arrowSide = 'left';
        } else if (roomLeft >= messageRect.width + 18) {
            top = centerY - messageRect.height / 2;
            left = rect.left - messageRect.width - 14;
            arrowSide = 'right';
        } else {
            top = Math.max(margin, rect.top - messageRect.height - 14);
            left = centerX - messageRect.width / 2;
            arrowSide = 'bottom';
        }
    } else if (fallback === 'top-center') {
        top = 80;
        left = (viewportWidth - messageRect.width) / 2;
    } else {
        top = viewportHeight - messageRect.height - 118;
        left = 18;
    }

    left = THREE.MathUtils.clamp(left, margin, Math.max(margin, viewportWidth - messageRect.width - margin));
    top = THREE.MathUtils.clamp(top, margin, Math.max(margin, viewportHeight - messageRect.height - margin));
    message.style.left = `${left}px`;
    message.style.top = `${top}px`;
    message.dataset.arrow = arrowSide === 'none' ? 'none' : `${arrowSide}-${arrowAlignment}`;
}

function showTutorialInstruction(
    title: string,
    body: string,
    target: HTMLElement | null = null,
    layer: HTMLElement | null = null,
    dimGame = true,
    arrowAlignment: TTutorialArrowAlignment = 'start'
) {
    tutorialPromptEl?.remove();
    setTutorialHighlight(target, layer);

    const overlay = document.createElement('div');
    overlay.className = `tutorial-game-overlay${dimGame ? '' : ' tutorial-game-overlay-clear'}`;
    overlay.dataset.arrowAlignment = arrowAlignment;
    overlay.innerHTML = `
        <div class="tutorial-game-message">
            <span>How to play</span>
            <strong>${title}</strong>
            <p>${body}</p>
        </div>
    `;
    document.body.appendChild(overlay);
    tutorialPromptEl = overlay;
    requestAnimationFrame(() => positionTutorialMessage(overlay, target, 'bottom-left', arrowAlignment));
}

function showTutorialWarning(title: string, body: string, target: HTMLElement | null = cycleBtn, arrowAlignment: TTutorialArrowAlignment = 'end') {
    clearTutorialWarning();
    tutorialPauseActive = true;

    const overlay = document.createElement('div');
    overlay.className = 'tutorial-game-overlay tutorial-game-overlay-blocking tutorial-warning-overlay';
    overlay.dataset.arrowAlignment = arrowAlignment;
    overlay.innerHTML = `
        <div class="tutorial-game-message tutorial-warning-message">
            <span>Warning</span>
            <strong>${title}</strong>
            <p>${body}</p>
            <button class="action-btn save" id="tutorial-warning-continue">Got it</button>
        </div>
    `;
    document.body.appendChild(overlay);
    tutorialWarningEl = overlay;
    requestAnimationFrame(() => positionTutorialMessage(overlay, target, 'bottom-left', arrowAlignment));
    overlay.querySelector('#tutorial-warning-continue')?.addEventListener('click', () => {
        clearTutorialWarning();
        tutorialPauseActive = false;
    });
}

function showTutorialCheckpoint(
    title: string,
    body: string,
    actionLabel: string,
    onContinue: () => void,
    target: HTMLElement | null = cycleBtn,
    arrowAlignment: TTutorialArrowAlignment = 'start'
) {
    clearTutorialInstruction({ keepSlowMo: true });
    tutorialPauseActive = true;
    setTutorialHighlight(target, target ? cycleBtnContainer : null);

    const overlay = document.createElement('div');
    overlay.className = 'tutorial-game-overlay tutorial-game-overlay-blocking';
    overlay.dataset.arrowAlignment = arrowAlignment;
    overlay.innerHTML = `
        <div class="tutorial-game-message tutorial-game-checkpoint">
            <span>How to play</span>
            <strong>${title}</strong>
            <p>${body}</p>
            <button class="action-btn save" id="tutorial-continue">${actionLabel}</button>
        </div>
    `;
    document.body.appendChild(overlay);
    tutorialPromptEl = overlay;
    requestAnimationFrame(() => positionTutorialMessage(overlay, target, 'top-center', arrowAlignment));

    overlay.querySelector('#tutorial-continue')?.addEventListener('click', () => {
        clearTutorialInstruction();
        tutorialPauseActive = false;
        onContinue();
    });
}

function startTutorialMode() {
    resetMatch();
    setGameSpeed('tutorial');
    clearTutorialWarning();
    tutorialLastWallWarningAt = -Infinity;
    tutorialCompletionTracked = false;
    tutorialModeActive = true;
    tutorialPauseActive = false;
    tutorialSlowMoActive = false;
    tutorialPhase = 'aim';
    tutorialNextPromptAt = 0;
    tutorialInitialAimAngle = currentLaunchAngle.value;
    trackGameEvent('tutorial_started');
    showTutorialInstruction(
        'Adjust launch angle',
        `Drag AIM left or right until the angle clearly changes. Release after at least ${TUTORIAL_MIN_AIM_DELTA} degrees of movement.`,
        dragZone,
        launchContainer,
        true,
        'middle'
    );
}

function startCustomizeBeyTutorial() {
    tutorialModeActive = false;
    tutorialPauseActive = false;
    tutorialSlowMoActive = false;
    tutorialPhase = 'idle';
    clearTutorialWarning();
    clearTutorialInstruction();
    trackGameEvent('customize_tutorial_started');
    showTutorialInstruction(
        'Customize bey',
        'Tap P1 to edit your bey. Before a match, tap CPU or P2 to edit the opponent bey.',
        hudTopBar,
        null,
        true,
        'middle'
    );
}

function handleTutorialAimComplete() {
    if (!tutorialModeActive || tutorialPhase !== 'aim') return;
    const aimDelta = getAngleDelta(currentLaunchAngle.value, tutorialInitialAimAngle);
    if (aimDelta < TUTORIAL_MIN_AIM_DELTA) {
        showTutorialInstruction(
            'Drag AIM farther',
            `Move the AIM bar until the launch angle changes by at least ${TUTORIAL_MIN_AIM_DELTA} degrees. A tiny tap does not set the path.`,
            dragZone,
            launchContainer,
            true,
            'middle'
        );
        return;
    }
    tutorialPhase = 'launch';
    showTutorialInstruction(
        'Press Launch',
        'Send your bey into the stadium. The lesson will slow down when "DIVE" matters.',
        launchBtn,
        launchContainer,
        true,
        'end'
    );
}

function handleTutorialDivePressed() {
    if (!tutorialModeActive || tutorialPhase !== 'dive') return;
    clearTutorialInstruction();
    tutorialPhase = 'gainSpeed';
    tutorialNextPromptAt = clock.getElapsedTime() + 1.1;
    showTutorialInstruction(
        'Control "DIVE"',
        'Use short "DIVE" bursts to gain speed. Sparks mean your bey is ready for bonus damage.',
        cycleBtn,
        cycleBtnContainer,
        false
    );
}

function notifyTutorialCriticalHit(entity: GameEntity, report?: TCriticalHitReport) {
    if (!tutorialModeActive || entity !== player) return;
    if (tutorialPhase !== 'waitingCrit' && tutorialPhase !== 'waitingSecondCrit') return;

    const streak = report?.streak || 1;
    if (tutorialPhase === 'waitingSecondCrit' && streak < 2) return;

    const damageCopy = report
        ? `Streak x${streak}: ${Math.round(report.crit)} - DEF ${Math.round(report.def)} = ${Math.round(report.dmg)} DMG. CPU lost ${Math.round(report.rpmLost)} RPM.`
        : 'That flash means your fast hit connected. Critical hits deal bonus damage.';

    if (tutorialPhase === 'waitingCrit') {
        tutorialPhase = 'finishModal';
        showTutorialCheckpoint(
            'First critical strike',
            `This is the first crit strike, so the streak is 1. ${damageCopy}`,
            'Chain another',
            () => {
                tutorialPhase = 'waitingSecondCrit';
                showTutorialInstruction(
                    'Land a second critical',
                    'Keep your speed high and hit again before a normal hit breaks the chain. The next critical shows the streak damage jump.',
                    cycleBtn,
                    cycleBtnContainer,
                    false
                );
            },
            cycleBtn,
            'end'
        );
        return;
    }

    tutorialPhase = 'finishModal';
    showTutorialCheckpoint(
        'Second critical chained',
        `This second critical keeps the streak alive, so the calculation grows again. ${damageCopy}`,
        'Continue',
        () => {
            tutorialPhase = 'finishModal';
            tutorialNextPromptAt = clock.getElapsedTime() + 0.1;
        },
        cycleBtn,
        'end'
    );
}

function notifyTutorialWallHit(entity: GameEntity, report?: TWallHitReport) {
    if (!tutorialModeActive || tutorialPauseActive || gameOver || entity !== player) return;
    if (tutorialPhase === 'idle' || tutorialPhase === 'aim' || tutorialPhase === 'launch' || tutorialPhase === 'complete') return;

    const now = clock.getElapsedTime();
    if (now - tutorialLastWallWarningAt < 5) return;
    tutorialLastWallWarningAt = now;

    showTutorialWarning(
        'Wall hit',
        report
            ? `Wall DMG ${Math.round(report.dmg)}. Your bey lost ${Math.round(report.rpmLost)} RPM. Use shorter "DIVE" bursts and curve back before the rim.`
            : 'Bumping the stadium wall drains RPM. Use shorter "DIVE" bursts and curve back before the rim.',
        cycleBtn,
        'end'
    );
}

function updateTutorialFlow(now: number) {
    if (!tutorialModeActive || tutorialPauseActive || gameOver) return;

    if (tutorialPhase === 'waitingDiveMoment') {
        const cpuDist = Math.hypot(enemy.body.position.x, enemy.body.position.y);
        const playerDist = Math.hypot(player.body.position.x, player.body.position.y);
        const goodDiveMoment = cpuDist < 120 && playerDist > 115;
        const fallbackDiveMoment = now >= tutorialNextPromptAt && playerDist > 92;

        if (goodDiveMoment || fallbackDiveMoment) {
            tutorialPhase = 'dive';
            tutorialSlowMoActive = true;
            showTutorialInstruction(
                'Hold "DIVE" now',
                'Your bey is wide while CPU is near center. Hold the "DIVE" button, or press the A key, to dive inward.',
                cycleBtn,
                cycleBtnContainer
            );
        }
        return;
    }

    if (tutorialPhase === 'gainSpeed' && now >= tutorialNextPromptAt && player.body.speed > CRIT_SPEED_THRESHOLD) {
        tutorialPhase = 'speedModal';
        tutorialNextPromptAt = now + 0.1;
        return;
    }

    if (tutorialPhase === 'speedModal' && now >= tutorialNextPromptAt) {
        showTutorialCheckpoint(
            'Speed gained',
            'Your bey has gained speed. Notice the SPARKLES: hitting the opponent in this state deals extra damage.',
            'Go for criticals',
            () => {
                tutorialPhase = 'waitingCrit';
                showTutorialInstruction(
                    'Land the hit',
                    'Keep controlling "DIVE" and collide while fast. Your first critical starts a streak at 1.',
                    cycleBtn,
                    cycleBtnContainer,
                    false
                );
            }
        );
        return;
    }

    if (tutorialPhase === 'finishModal' && now >= tutorialNextPromptAt) {
        showTutorialCheckpoint(
            'Last one standing wins',
            'Drain the opponent RPM to zero or knock them out. Keep enough stamina to stay spinning.',
            'Finish match',
            () => {
                setGameSpeed('tutorial');
                clearTutorialWarning();
                if (!tutorialCompletionTracked) {
                    tutorialCompletionTracked = true;
                    trackGameEvent('tutorial_completed');
                }
                tutorialPhase = 'complete';
                tutorialModeActive = false;
            }
        );
    }
}

function cloneStats(stats: BeybladeStats): BeybladeStats {
    return JSON.parse(JSON.stringify(stats)) as BeybladeStats;
}

function setMultiplayerStatus(status: TMultiplayerStatus) {
    multiplayer.status = status;
    document.querySelectorAll<HTMLElement>('.multiplayer-status').forEach((el) => {
        el.textContent = getMultiplayerStatusText();
    });
    document.querySelectorAll<HTMLInputElement>('.multiplayer-link').forEach((input) => {
        input.value = multiplayer.joinLink;
    });
    syncLaunchSetupUi();
}

function getGlobalRtcConfig(): RTCConfiguration | undefined {
    if (window.BBLADE_RTC_CONFIG) return window.BBLADE_RTC_CONFIG;
    const iceServers = window.BBLADE_ICE_SERVERS || window.GLOBAL_ICE_SERVERS || window.__ICE_SERVERS__;
    return iceServers?.length ? { iceServers } : undefined;
}

function getPeerOptions(): PeerOptions {
    const rtcConfig = getGlobalRtcConfig();
    const baseOptions = { ...(window.BBLADE_PEERJS_OPTIONS || {}) } as PeerOptions;
    return rtcConfig ? { ...baseOptions, config: rtcConfig } : baseOptions;
}

function cleanupMultiplayer() {
    multiplayer.conn?.close();
    multiplayer.peer?.destroy();
    multiplayer.role = 'solo';
    multiplayer.status = 'Offline';
    multiplayer.peer = null;
    multiplayer.conn = null;
    multiplayer.peerId = '';
    multiplayer.joinLink = '';
    multiplayer.localReady = false;
    multiplayer.remoteReady = false;
    multiplayer.localLaunchAngle = DEFAULT_LAUNCH_ANGLE;
    multiplayer.remoteLaunchAngle = DEFAULT_LAUNCH_ANGLE;
    multiplayer.remoteLaunchRequested = false;
    multiplayer.analyticsConnectedTracked = false;
    setMultiplayerStatus('Offline');
    syncOpponentHudLabel();
    syncLaunchSetupUi();
    syncGameSpeedControls();
}

function setLocalPlayMode(mode: TLocalPlayMode) {
    if (multiplayer.role !== 'solo') cleanupMultiplayer();
    localPlayMode = mode;
    syncOpponentHudLabel();
    syncGameSpeedControls();
    resetMatch();
}

function getMultiplayerStatusText() {
    if (multiplayer.role === 'solo') return 'Ready';
    if (multiplayer.status === 'Connected') return `${multiplayer.role === 'host' ? 'Hosting' : 'Joined'} - connected`;
    return `${multiplayer.role === 'host' ? 'Host' : 'Join'} - ${multiplayer.status}`;
}

function getOpponentLabel() {
    if (localPlayMode === '2p' || multiplayer.role !== 'solo') return 'P2';
    return localPlayMode === '1p-hard' ? 'CPU2' : 'CPU1';
}

function createJoinLink(peerId: string) {
    const url = new URL(window.location.href);
    url.searchParams.set('joinPeer', peerId);
    return url.toString();
}

function sendMultiplayerMessage(message: TMultiplayerMessage) {
    if (!multiplayer.conn?.open) return;
    multiplayer.conn.send(message);
}

function sendMultiplayerInput(input: Omit<Extract<TMultiplayerMessage, { type: 'input' }>, 'type'>) {
    if (multiplayer.role === 'solo') return;
    sendMultiplayerMessage({ type: 'input', ...input });
}

function sendLocalBeyStats() {
    if (multiplayer.role === 'solo') return;
    sendMultiplayerMessage({ type: 'stats', stats: cloneStats(PLAYER_STATS) });
}

function sendMultiplayerReset() {
    if (multiplayer.role === 'solo') return;
    sendMultiplayerMessage({ type: 'reset' });
}

function sendHostGameSpeed() {
    if (multiplayer.role !== 'host') return;
    sendMultiplayerMessage({ type: 'speed', speed: currentGameSpeed });
}

function sendLocalBeyEdit() {
    if (multiplayer.role === 'solo') return;
    sendLocalBeyStats();
    sendMultiplayerReset();
}

function diveActionToPattern(action: TDiveAction) {
    return action === 'dive_on' ? 1 : 0;
}

function divePatternToAction(pattern: number): TDiveAction {
    return pattern === 1 ? 'dive_on' : 'dive_off';
}

function resetMultiplayerDiveQueue() {
    multiplayer.matchTime = 0;
    multiplayer.nextStateSyncAt = MULTIPLAYER_STATE_SYNC_INTERVAL_SECONDS;
    multiplayer.diveQueue = [];
    multiplayer.processedDiveEventIds.clear();
}

function queueDiveEvent(event: TScheduledDiveEvent) {
    if (multiplayer.processedDiveEventIds.has(event.id)) return;
    if (multiplayer.diveQueue.some((queued) => queued.id === event.id)) return;
    multiplayer.diveQueue.push(event);
    multiplayer.diveQueue.sort((a, b) => a.applyAt - b.applyAt);
}

function queueLocalDiveEvent(pattern: number) {
    if (!isOnlineMatch()) return;
    if (!multiplayer.conn?.open) return;
    const action = divePatternToAction(pattern);
    const id = `${multiplayer.peerId || multiplayer.role}-${++multiplayer.diveEventSeq}`;
    const applyAt = multiplayer.matchTime + MULTIPLAYER_INPUT_DELAY_SECONDS;
    queueDiveEvent({ id, side: 'player', action, applyAt });
    sendMultiplayerMessage({ type: 'dive', id, action, applyAt });
}

function applyScheduledDiveEvent(event: TScheduledDiveEvent) {
    const pattern = diveActionToPattern(event.action);
    if (event.side === 'player') {
        applyPlayerDivePattern(pattern);
    } else {
        setCpuPattern(pattern);
    }
    multiplayer.processedDiveEventIds.add(event.id);
}

function processScheduledDiveEvents() {
    if (!isOnlineMatch() || !hasLaunched || gameOver) return;
    while (multiplayer.diveQueue.length > 0 && multiplayer.diveQueue[0].applyAt <= multiplayer.matchTime + 0.000001) {
        const event = multiplayer.diveQueue.shift();
        if (event) applyScheduledDiveEvent(event);
    }
}

function getBodyStateSnapshot(entity: GameEntity): TBodyStateSnapshot {
    return {
        x: entity.body.position.x,
        y: entity.body.position.y,
        vx: entity.body.velocity.x,
        vy: entity.body.velocity.y,
        angle: entity.body.angle,
        angularVelocity: entity.body.angularVelocity,
        rpm: entity.currentRpm || 0
    };
}

function averageAngle(localAngle: number, remoteAngle: number) {
    let delta = remoteAngle - localAngle;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    return localAngle + delta * 0.5;
}

function blendEntityWithRemoteState(entity: GameEntity, remote: TBodyStateSnapshot) {
    if (entity.isDead) return;
    Body.setPosition(entity.body, {
        x: (entity.body.position.x + remote.x) * 0.5,
        y: (entity.body.position.y + remote.y) * 0.5
    });
    Body.setVelocity(entity.body, {
        x: (entity.body.velocity.x + remote.vx) * 0.5,
        y: (entity.body.velocity.y + remote.vy) * 0.5
    });
    Body.setAngle(entity.body, averageAngle(entity.body.angle, remote.angle));
    Body.setAngularVelocity(entity.body, (entity.body.angularVelocity + remote.angularVelocity) * 0.5);
    if (entity.currentRpm !== undefined && Number.isFinite(remote.rpm)) {
        entity.currentRpm = (entity.currentRpm + remote.rpm) * 0.5;
    }
}

function applyRemoteMatterWorldState(message: Extract<TMultiplayerMessage, { type: 'state' }>) {
    if (!isOnlineMatch() || !hasLaunched || gameOver) return;
    blendEntityWithRemoteState(enemy, message.player);
    blendEntityWithRemoteState(player, message.enemy);
}

function maybeSendMatterWorldStateSample() {
    if (!isOnlineMatch() || !multiplayer.conn?.open || !hasLaunched || gameOver) return;
    if (multiplayer.matchTime + 0.000001 < multiplayer.nextStateSyncAt) return;
    multiplayer.nextStateSyncAt += MULTIPLAYER_STATE_SYNC_INTERVAL_SECONDS;
    if (multiplayer.nextStateSyncAt <= multiplayer.matchTime) {
        multiplayer.nextStateSyncAt = multiplayer.matchTime + MULTIPLAYER_STATE_SYNC_INTERVAL_SECONDS;
    }
    if (Math.random() > MULTIPLAYER_STATE_SYNC_CHANCE) return;
    sendMultiplayerMessage({
        type: 'state',
        matchTime: multiplayer.matchTime,
        player: getBodyStateSnapshot(player),
        enemy: getBodyStateSnapshot(enemy)
    });
}

function sendMultiplayerReady() {
    if (multiplayer.role === 'solo') return;
    sendMultiplayerMessage({
        type: 'ready',
        launchAngle: multiplayer.localLaunchAngle,
        stats: cloneStats(PLAYER_STATS)
    });
}

function tryStartMultiplayerCountdown() {
    if (multiplayer.role === 'solo' || hasLaunched || launchCountdownOverlay) return;
    if (!multiplayer.localReady || !multiplayer.remoteReady) return;
    startLaunchCountdown(() => startLocalSimulatedMatch(multiplayer.localLaunchAngle));
}

function markLocalMultiplayerReady() {
    if (multiplayer.role === 'solo' || multiplayer.localReady || hasLaunched) return;
    multiplayer.localReady = true;
    multiplayer.localLaunchAngle = currentLaunchAngle.value;
    syncLaunchSetupUi();
    sendMultiplayerReady();
    tryStartMultiplayerCountdown();
}

function launchEntity(entity: GameEntity, angleDeg: number) {
    const angleRad = (angleDeg * Math.PI) / 180;
    const launchSpeed = entity.stats ? entity.stats.spd : 200;
    Body.setVelocity(entity.body, {
        x: Math.cos(angleRad) * launchSpeed * 0.1,
        y: Math.sin(angleRad) * launchSpeed * 0.1
    });

    if (entity.stats) {
        entity.currentRpm = entity.stats.maxRpm;
        Body.setAngularVelocity(entity.body, entity.currentRpm / 100);
    } else {
        Body.setAngularVelocity(entity.body, 50);
    }
}

function primeEntityForMatch(entity: GameEntity) {
    if (entity.stats) {
        entity.currentRpm = entity.stats.maxRpm;
        Body.setAngularVelocity(entity.body, entity.currentRpm / 100);
    }
}

function finishLocalLaunch() {
    matchStartPlayerStats = JSON.parse(JSON.stringify(player.stats));
    matchStartEnemyStats = JSON.parse(JSON.stringify(enemy.stats));
    launchContainer.style.display = 'none';
    cycleBtnContainer.style.display = 'flex';
    cpuCycleBtnContainer.style.display = localPlayMode === '2p' ? 'flex' : 'none';
    resetHint.style.display = 'block';
}

function trackGameStarted() {
    if (multiplayer.role === 'guest') return;
    trackGameEvent('game_started', {
        mode: multiplayer.role !== 'solo' ? 'online' : localPlayMode,
        speed: currentGameSpeed,
        tutorial: tutorialModeActive,
        flashes: flashesEnabled,
        camera_shake: cameraShakeEnabled
    });
}

function startLocalSimulatedMatch(localLaunchAngle: number, localOpponentAngle?: number) {
    resetMatchCounters();
    resetMultiplayerDiveQueue();
    hasLaunched = true;
    trackGameStarted();
    if (tutorialModeActive && tutorialPhase === 'launch') {
        clearTutorialInstruction();
        tutorialPhase = 'waitingDiveMoment';
        tutorialNextPromptAt = clock.getElapsedTime() + 2.4;
    }

    setCpuPattern(0);
    cpuLastWallHitAt = -Infinity;
    cpuHardAiLastReason = 'idle';
    scheduleNextCpuDiveSwitch(clock.getElapsedTime() + 0.5);
    launchEntity(player, localLaunchAngle);
    if (multiplayer.role !== 'solo') {
        if (multiplayer.remoteReady || multiplayer.remoteLaunchRequested) launchEntity(enemy, multiplayer.remoteLaunchAngle);
        else primeEntityForMatch(enemy);
    } else {
        const opponentAngle = typeof localOpponentAngle === 'number'
            ? localOpponentAngle
            : localPlayMode === '2p'
                ? (localLaunchAngle + 180) % 360
                : Math.random() * 360;
        launchEntity(enemy, opponentAngle);
    }
    finishLocalLaunch();
}

function startLaunchCountdown(onComplete: () => void) {
    if (launchCountdownOverlay) return;
    clearLaunchCountdown();
    launchCountdownComplete = onComplete;
    launchContainer.style.display = 'none';
    guideMesh.visible = false;

    let count = 3;
    const overlay = document.createElement('div');
    overlay.className = 'launch-countdown-overlay';
    overlay.innerHTML = `<div class="launch-countdown-text">${count}</div>`;
    document.body.appendChild(overlay);
    launchCountdownOverlay = overlay;

    launchCountdownInterval = window.setInterval(() => {
        count -= 1;
        const text = overlay.querySelector<HTMLElement>('.launch-countdown-text');
        if (count > 0) {
            if (text) text.textContent = String(count);
            return;
        }

        if (text) text.textContent = 'GO';
        if (launchCountdownInterval !== undefined) {
            window.clearInterval(launchCountdownInterval);
            launchCountdownInterval = undefined;
        }
        window.setTimeout(() => {
            const complete = launchCountdownComplete;
            clearLaunchCountdown();
            complete?.();
        }, 300);
    }, 1000);
}

function startTwoPlayerLaunchCountdown() {
    startLaunchCountdown(() => startLocalSimulatedMatch(twoPlayerLaunchAngles.p1, twoPlayerLaunchAngles.p2));
}

function applyStatsToEntityPreservingMatchState(entity: GameEntity, stats: BeybladeStats) {
    const currentPosition = { x: entity.body.position.x, y: entity.body.position.y };
    const currentVelocity = { x: entity.body.velocity.x, y: entity.body.velocity.y };
    const currentAngularVelocity = entity.body.angularVelocity;
    const currentAngle = entity.body.angle;
    const currentRpm = entity.currentRpm;

    scene.remove(entity.mesh);
    const newVisuals = createBeybladeMesh(stats);
    entity.mesh = newVisuals.mesh;
    entity.tiltGroup = newVisuals.tiltGroup;
    entity.spinGroup = newVisuals.spinGroup;
    scene.add(entity.mesh);

    Body.setDensity(entity.body, stats.densityBase * stats.wt);
    entity.body.restitution = stats.restitution;
    entity.body.friction = stats.friction;
    entity.body.frictionAir = stats.frictionAir;
    Body.setPosition(entity.body, currentPosition);
    Body.setVelocity(entity.body, currentVelocity);
    Body.setAngularVelocity(entity.body, currentAngularVelocity);
    Body.setAngle(entity.body, currentAngle);

    entity.stats = stats;
    entity.currentRpm = currentRpm;
    if (entity.trail) {
        entity.trail.setColor(stats.trailColor);
    }
    setBeyVortexColor(entity.mesh, stats.trailColor);
}

function applyRemoteStats(stats: BeybladeStats) {
    Object.assign(ENEMY_STATS, { ...DEFAULT_ENEMY_STATS, ...stats });
    sanitizePartMatcaps(ENEMY_STATS);
    enforceBeyColorContrast(ENEMY_STATS);
    matchStartEnemyStats = JSON.parse(JSON.stringify(ENEMY_STATS));
    syncHudButtonColors();
    if (!hasLaunched) {
        resetEntityVisualsAndPhysics(enemy, ENEMY_STATS, { x: 0, y: -100 });
    } else {
        applyStatsToEntityPreservingMatchState(enemy, ENEMY_STATS);
    }
}

function handleMultiplayerMessage(data: unknown) {
    const message = data as Partial<TMultiplayerMessage>;
    if (!message || typeof message.type !== 'string') return;

    if ((message.type === 'hello' || message.type === 'stats') && 'stats' in message && message.stats) {
        applyRemoteStats(message.stats as BeybladeStats);
        return;
    }

    if (message.type === 'speed') {
        const speed = message.speed;
        if (multiplayer.role === 'guest' && typeof speed === 'string' && isGameSpeedId(speed)) {
            setGameSpeed(speed, false);
        }
        return;
    }

    if (message.type === 'ready' && multiplayer.role !== 'solo') {
        if (message.stats) applyRemoteStats(message.stats as BeybladeStats);
        if (typeof message.launchAngle === 'number') multiplayer.remoteLaunchAngle = message.launchAngle;
        multiplayer.remoteReady = true;
        multiplayer.remoteLaunchRequested = true;
        tryStartMultiplayerCountdown();
        return;
    }

    if (message.type === 'dive' && multiplayer.role !== 'solo') {
        if (typeof message.id !== 'string' || typeof message.applyAt !== 'number') return;
        if (message.action !== 'dive_on' && message.action !== 'dive_off') return;
        queueDiveEvent({
            id: message.id,
            side: 'enemy',
            action: message.action,
            applyAt: message.applyAt
        });
        return;
    }

    if (message.type === 'state' && multiplayer.role !== 'solo') {
        if (!message.player || !message.enemy) return;
        applyRemoteMatterWorldState(message as Extract<TMultiplayerMessage, { type: 'state' }>);
        return;
    }

    if (message.type === 'input' && multiplayer.role !== 'solo') {
        if (typeof message.launchAngle === 'number') multiplayer.remoteLaunchAngle = message.launchAngle;
        if (typeof message.pattern === 'number') setCpuPattern(message.pattern);
        if (message.stats) applyRemoteStats(message.stats as BeybladeStats);
        if (message.launch) {
            multiplayer.remoteLaunchRequested = true;
            if (hasLaunched) launchEntity(enemy, multiplayer.remoteLaunchAngle);
        }
        return;
    }

    if (message.type === 'reset') {
        clearWinnerOverlay();
        resetMatch();
    }
}

function bindMultiplayerConnection(conn: DataConnection) {
    multiplayer.conn = conn;
    conn.on('open', () => {
        setMultiplayerStatus('Connected');
        if (!multiplayer.analyticsConnectedTracked) {
            multiplayer.analyticsConnectedTracked = true;
            if (multiplayer.role === 'host') trackGameEvent('online_connected');
        }
        sendMultiplayerMessage({ type: 'hello', stats: cloneStats(PLAYER_STATS), name: 'Player' });
        sendHostGameSpeed();
        if (multiplayer.localReady) sendMultiplayerReady();
    });
    conn.on('data', handleMultiplayerMessage);
    conn.on('close', () => setMultiplayerStatus('Disconnected'));
    conn.on('error', () => setMultiplayerStatus('Error'));
}

function startMultiplayerHost() {
    cleanupMultiplayer();
    trackGameEvent('online_attempted', { role: 'host' });
    multiplayer.role = 'host';
    syncOpponentHudLabel();
    setMultiplayerStatus('Hosting');
    const peer = new Peer(getPeerOptions());
    multiplayer.peer = peer;
    peer.on('open', (id) => {
        multiplayer.peerId = id;
        multiplayer.joinLink = createJoinLink(id);
        setMultiplayerStatus('Hosting');
    });
    peer.on('connection', (conn) => {
        multiplayer.conn?.close();
        bindMultiplayerConnection(conn);
    });
    peer.on('error', () => setMultiplayerStatus('Error'));
}

function joinMultiplayerHost(hostPeerId: string) {
    if (!hostPeerId.trim()) return;
    cleanupMultiplayer();
    trackGameEvent('online_attempted', { role: 'guest' });
    multiplayer.role = 'guest';
    syncOpponentHudLabel();
    setMultiplayerStatus('Joining');
    const peer = new Peer(getPeerOptions());
    multiplayer.peer = peer;
    peer.on('open', () => {
        const conn = peer.connect(hostPeerId.trim(), { reliable: true });
        bindMultiplayerConnection(conn);
    });
    peer.on('error', () => setMultiplayerStatus('Error'));
}

function autoJoinFromUrl() {
    const peerId = new URLSearchParams(window.location.search).get('joinPeer');
    if (peerId) joinMultiplayerHost(peerId);
}

function getPeerIdFromInput(rawValue: string) {
    try {
        return new URL(rawValue).searchParams.get('joinPeer') || rawValue;
    } catch {
        return rawValue;
    }
}

function showOnlineDialog() {
    if (document.querySelector('.online-overlay')) return;

    const overlay = document.createElement('div');
    overlay.className = 'tutorial-overlay online-overlay';
    overlay.innerHTML = `
        <div class="tutorial-panel menu-panel">
            <span class="kicker">Online</span>
            <h1>Lobby</h1>
            <div class="multiplayer-lobby-grid">
                <section class="multiplayer-card">
                    <div class="multiplayer-card-head">
                        <span>Host</span>
                        <div class="multiplayer-status">${getMultiplayerStatusText()}</div>
                    </div>
                    <div class="multiplayer-card-body">
                        <input class="multiplayer-link" id="online-host-link" readonly value="${multiplayer.joinLink}" placeholder="Host link appears here">
                        <button class="action-btn save" id="online-host-match">Host</button>
                    </div>
                </section>
                <section class="multiplayer-card">
                    <div class="multiplayer-card-head">
                        <span>Join</span>
                    </div>
                    <div class="multiplayer-card-body multiplayer-join-row">
                        <input id="online-peer-id" placeholder="Paste host peer id or join URL">
                        <button class="action-btn save" id="online-join-match">Join</button>
                    </div>
                </section>
            </div>
            <div class="tutorial-actions">
                <button class="action-btn reset" id="online-back">Back</button>
                <button class="action-btn save" id="online-close">Done</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#online-host-match')?.addEventListener('click', () => {
        localPlayMode = '1p-easy';
        startMultiplayerHost();
    });
    overlay.querySelector('#online-join-match')?.addEventListener('click', () => {
        const rawValue = overlay.querySelector<HTMLInputElement>('#online-peer-id')?.value.trim() || '';
        localPlayMode = '1p-easy';
        joinMultiplayerHost(getPeerIdFromInput(rawValue));
    });
    overlay.querySelector<HTMLInputElement>('#online-host-link')?.addEventListener('click', async (event) => {
        const input = event.currentTarget as HTMLInputElement;
        input.select();
        if (input.value && navigator.clipboard) {
            await navigator.clipboard.writeText(input.value);
        }
    });
    overlay.querySelector('#online-back')?.addEventListener('click', () => {
        overlay.remove();
        showMenuDialog();
    });
    overlay.querySelector('#online-close')?.addEventListener('click', () => overlay.remove());
}

function showMenuDialog() {
    if (document.querySelector('.menu-overlay')) return;

    const overlay = document.createElement('div');
    overlay.className = 'tutorial-overlay menu-overlay';
    const speedLockedByHost = multiplayer.role === 'guest';
    const speedOptions = (Object.entries(GAME_SPEEDS) as Array<[TGameSpeedId, typeof GAME_SPEEDS[TGameSpeedId]]>)
        .map(([id, option]) => `
            <label class="menu-speed-option ${id === currentGameSpeed ? 'active' : ''} ${speedLockedByHost ? 'locked' : ''}">
                <input type="radio" name="menu-speed" value="${id}" ${id === currentGameSpeed ? 'checked' : ''} ${speedLockedByHost ? 'disabled' : ''}>
                <span>${option.label}</span>
            </label>
        `).join('');

    overlay.innerHTML = `
        <div class="tutorial-panel menu-panel">
            <span class="kicker">Battle menu</span>
            <h1>Settings</h1>
            <div class="menu-options">
                <label class="menu-option">
                    <span>Sound</span>
                    <input id="menu-volume" type="range" min="0" max="1" step="0.01" value="${masterVolume}">
                </label>
                <div class="menu-option menu-effects-row">
                    <span>Effects</span>
                    <div class="menu-toggle-grid">
                        <label class="menu-toggle-option">
                            <span>Flashes</span>
                            <input id="menu-flashes" type="checkbox" ${flashesEnabled ? 'checked' : ''}>
                        </label>
                        <label class="menu-toggle-option">
                            <span>Shake</span>
                            <input id="menu-camera-shake" type="checkbox" ${cameraShakeEnabled ? 'checked' : ''}>
                        </label>
                    </div>
                </div>
                <div class="menu-option">
                    <span>Game speed</span>
                    <div class="menu-speed-grid">${speedOptions}</div>
                </div>
            </div>
            <div class="tutorial-actions mode-actions menu-play-modes">
                <button class="action-btn save" id="menu-1p-easy">CPU1</button>
                <button class="action-btn save" id="menu-1p-hard">CPU2</button>
                <button class="action-btn save" id="menu-2p">2P</button>
                <button class="action-btn save" id="menu-online">Online</button>
            </div>
            <div class="tutorial-actions menu-how-to-play">
                <button class="action-btn reset" id="menu-tutorial">How to play</button>
                <button class="action-btn reset" id="menu-customize-tutorial">Customize bey</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector<HTMLInputElement>('#menu-volume')?.addEventListener('input', (event) => {
        setMasterVolume(Number((event.target as HTMLInputElement).value));
    });
    const volumeInput = overlay.querySelector<HTMLInputElement>('#menu-volume');
    volumeInput?.addEventListener('pointerup', playMenuSampleHit);
    volumeInput?.addEventListener('change', playMenuSampleHit);
    overlay.querySelector<HTMLInputElement>('#menu-flashes')?.addEventListener('change', (event) => {
        setFlashesEnabled((event.target as HTMLInputElement).checked);
    });
    overlay.querySelector<HTMLInputElement>('#menu-camera-shake')?.addEventListener('change', (event) => {
        setCameraShakeEnabled((event.target as HTMLInputElement).checked);
    });
    overlay.querySelectorAll<HTMLInputElement>('input[name="menu-speed"]').forEach((input) => {
        input.addEventListener('change', () => {
            if (multiplayer.role === 'guest') return;
            if (!isGameSpeedId(input.value)) return;
            setGameSpeed(input.value);
        });
    });
    const closeForMode = () => {
        tutorialModeActive = false;
        tutorialPauseActive = false;
        tutorialSlowMoActive = false;
        tutorialPhase = 'idle';
        clearTutorialInstruction();
        clearTutorialWarning();
        overlay.remove();
    };
    overlay.querySelector('#menu-1p-easy')?.addEventListener('click', () => {
        closeForMode();
        setLocalPlayMode('1p-easy');
    });
    overlay.querySelector('#menu-1p-hard')?.addEventListener('click', () => {
        closeForMode();
        setLocalPlayMode('1p-hard');
    });
    overlay.querySelector('#menu-2p')?.addEventListener('click', () => {
        closeForMode();
        setLocalPlayMode('2p');
    });
    overlay.querySelector('#menu-online')?.addEventListener('click', () => {
        overlay.remove();
        showOnlineDialog();
    });
    overlay.querySelector('#menu-tutorial')?.addEventListener('click', () => {
        overlay.remove();
        startTutorialMode();
    });
    overlay.querySelector('#menu-customize-tutorial')?.addEventListener('click', () => {
        overlay.remove();
        startCustomizeBeyTutorial();
    });
}

topMenuBtn.onclick = showMenuDialog;
showMenuDialog();
autoJoinFromUrl();

animate();



// --- Input Processing ---
// Removed Drag interaction for Launch. Using UI instead.

launchBtn.addEventListener('click', () => {
    if (hasLaunched) return;
    if (tutorialModeActive && tutorialPhase === 'aim') {
        showTutorialInstruction(
            'Drag AIM farther',
            `Drag AIM left or right until the angle changes by at least ${TUTORIAL_MIN_AIM_DELTA} degrees, then release.`,
            dragZone,
            launchContainer,
            true,
            'middle'
        );
        return;
    }

    unlockAudio();
    ensureBeyNoiseLayers();

    if (multiplayer.role !== 'solo') {
        markLocalMultiplayerReady();
        return;
    }

    if (localPlayMode === '2p' && multiplayer.role === 'solo') {
        if (twoPlayerLaunchStep === 'p1') {
            twoPlayerLaunchAngles.p1 = currentLaunchAngle.value;
            twoPlayerLaunchStep = 'p2';
            currentLaunchAngle.value = (twoPlayerLaunchAngles.p1 + 180) % 360;
            updateGuide(currentLaunchAngle.value);
            syncLaunchSetupUi();
            return;
        }

        twoPlayerLaunchAngles.p2 = currentLaunchAngle.value;
        startTwoPlayerLaunchCountdown();
        return;
    }

    startLocalSimulatedMatch(currentLaunchAngle.value);
});

// Window Resize Handling
window.addEventListener('resize', () => {
    const aspect = window.innerWidth / window.innerHeight;

    camera.left = frustumSize * aspect / -2;
    camera.right = frustumSize * aspect / 2;
    camera.top = frustumSize / 2;
    camera.bottom = frustumSize / -2;
    syncCriticalFlashPlaneToCamera();

    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    if (tutorialPromptEl?.classList.contains('tutorial-game-overlay')) {
        const arrowAlignment = (tutorialPromptEl.dataset.arrowAlignment as TTutorialArrowAlignment | undefined) || 'start';
        positionTutorialMessage(tutorialPromptEl, tutorialHighlightEl, 'bottom-left', arrowAlignment);
    }
    if (tutorialWarningEl?.classList.contains('tutorial-game-overlay')) {
        const arrowAlignment = (tutorialWarningEl.dataset.arrowAlignment as TTutorialArrowAlignment | undefined) || 'end';
        positionTutorialMessage(tutorialWarningEl, cycleBtn, 'bottom-left', arrowAlignment);
    }
});

// Game Over / Winner UI
function showWinner(text: string, accentColor = 0xf7cf2e) {
    const overlay = document.createElement('div');
    overlay.className = 'winner-overlay';
    const accent = `#${numberToHex(accentColor)}`;
    const accentRgb = `${(accentColor >> 16) & 255}, ${(accentColor >> 8) & 255}, ${accentColor & 255}`;
    overlay.style.setProperty('--winner-color', accent);
    overlay.style.setProperty('--winner-glow', `#${numberToHex(clampBeyColor(accentColor))}`);
    overlay.style.setProperty('--winner-rgb', accentRgb);

    const title = document.createElement('div');
    title.className = 'winner-title';
    title.innerText = text;
    overlay.appendChild(title);

    const stats = document.createElement('div');
    stats.className = 'winner-stats';
    const opponentLabel = getOpponentLabel();
    stats.innerHTML = `
        <div class="winner-stats-row">
            <span>P1</span>
            <span><strong>${matchCounters.player.criticalHits}</strong> Criticals</span>
            <span><strong>${matchCounters.player.wallDings}</strong> Crashes</span>
        </div>
        <div class="winner-stats-row">
            <span>${opponentLabel}</span>
            <span><strong>${matchCounters.enemy.criticalHits}</strong> Criticals</span>
            <span><strong>${matchCounters.enemy.wallDings}</strong> Crashes</span>
        </div>
    `;
    overlay.appendChild(stats);

    const rematchBtn = document.createElement('button');
    rematchBtn.className = 'rematch-btn';
    rematchBtn.innerText = 'REMATCH';
    rematchBtn.onclick = () => {
        document.body.removeChild(overlay);
        requestMatchReset();
    };
    overlay.appendChild(rematchBtn);

    document.body.appendChild(overlay);
}

function showWinnerSpotlightFrame(accentColor: number) {
    activeKoBlankOverlay?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'winner-spotlight-frame';
    overlay.style.setProperty('--ko-accent', `#${numberToHex(accentColor)}`);
    document.body.appendChild(overlay);
    activeKoBlankOverlay = overlay;
}

function triggerWinningShot(loser: GameEntity, winnerText: string, accentColor: number) {
    const impactPoint = loser.mesh.position.clone();
    finishSlowMoUntil = clock.getElapsedTime() + KO_FINISH_DURATION_SECONDS;

    triggerCriticalFeedback(impactPoint);
    cameraShakeState.duration = Math.max(cameraShakeState.duration, 0.48);
    cameraShakeState.amplitude = Math.max(cameraShakeState.amplitude, 15);
    playCollisionSound(0.62, 560, true);

    for (let i = 0; i < 34; i++) {
        createSpark(impactPoint.x, impactPoint.z, i % 4 === 0 ? 0xffffff : accentColor, i % 4 === 0 ? 10 : 7);
    }

    if (pendingWinnerTimeout !== null) {
        window.clearTimeout(pendingWinnerTimeout);
    }
    if (pendingKoBlankTimeout !== null) {
        window.clearTimeout(pendingKoBlankTimeout);
    }
    pendingKoBlankTimeout = window.setTimeout(() => {
        pendingKoBlankTimeout = null;
        showWinnerSpotlightFrame(accentColor);
    }, KO_FINISH_DURATION_SECONDS * 1000);

    pendingWinnerTimeout = window.setTimeout(() => {
        pendingWinnerTimeout = null;
        activeKoBlankOverlay?.remove();
        activeKoBlankOverlay = null;
        showWinner(winnerText, accentColor);
    }, (KO_FINISH_DURATION_SECONDS + KO_WINNER_BLANK_SECONDS) * 1000);
}

const resetEntityVisualsAndPhysics = (entity: GameEntity, stats: BeybladeStats, startPos: { x: number, y: number }) => {
    clearLooseBeyParts(entity);

    // 1. Remove old visual mesh
    scene.remove(entity.mesh);

    // 2. Create new visual mesh
    const newVisuals = createBeybladeMesh(stats);
    entity.mesh = newVisuals.mesh;
    entity.tiltGroup = newVisuals.tiltGroup;
    entity.spinGroup = newVisuals.spinGroup;
    scene.add(entity.mesh);

    // 3. Update Physics Body
    const density = stats.densityBase * stats.wt;
    Body.setDensity(entity.body, density);
    entity.body.restitution = stats.restitution;
    entity.body.friction = stats.friction;
    entity.body.frictionAir = stats.frictionAir;

    // Reset Physics State
    Body.setPosition(entity.body, startPos);
    Body.setVelocity(entity.body, { x: 0, y: 0 });
    Body.setAngularVelocity(entity.body, 0);
    Body.setAngle(entity.body, 0);

    // Clear all forces and torques
    entity.body.force = { x: 0, y: 0 };
    entity.body.torque = 0;

    // Wake the body to ensure physics updates, then it will settle
    Body.setStatic(entity.body, false);

    // Reset Visual Position
    entity.mesh.position.set(startPos.x, getArenaHeight(startPos.x, startPos.y) + 10, startPos.y); // Matter Y is Three Z
    entity.mesh.quaternion.set(0, 0, 0, 1);

    // 4. Update Trail Color
    if (entity.trail) {
        entity.trail.setColor(stats.trailColor);
        entity.trail.clear();
    }
    setBeyVortexColor(entity.mesh, stats.trailColor);

    // 5. Reset Game Logic Stats
    entity.stats = stats; // Ensure reference is up to date
    entity.isDead = false;
    entity.currentRpm = 0;

    // 6. Clear drift properties (prevents weird movement after reset)
    entity.driftVelocity = undefined;
    entity.driftRotation = undefined;
    entity.criticalKo = false;
    entity.looseParts = undefined;
};

function resetMatch() {
    hasLaunched = false;
    gameOver = false;
    finishSlowMoUntil = 0;
    if (pendingKoBlankTimeout !== null) {
        window.clearTimeout(pendingKoBlankTimeout);
        pendingKoBlankTimeout = null;
    }
    if (pendingWinnerTimeout !== null) {
        window.clearTimeout(pendingWinnerTimeout);
        pendingWinnerTimeout = null;
    }
    activeKoBlankOverlay?.remove();
    activeKoBlankOverlay = null;
    clearLaunchCountdown();
    resetMatchCounters();
    multiplayer.localReady = false;
    multiplayer.remoteReady = false;
    multiplayer.localLaunchAngle = DEFAULT_LAUNCH_ANGLE;
    multiplayer.remoteLaunchRequested = false;
    multiplayer.remoteLaunchAngle = DEFAULT_LAUNCH_ANGLE;
    resetMultiplayerDiveQueue();
    twoPlayerLaunchStep = 'p1';
    twoPlayerLaunchAngles = { p1: DEFAULT_LAUNCH_ANGLE, p2: 0 };
    localDiveIntent = 0;
    cpuDiveIntent = 0;
    cpuLastWallHitAt = -Infinity;
    cpuHardAiLastReason = 'idle';

    // Update action HUD buttons
    resetHint.style.display = 'none';
    cycleBtnContainer.style.display = 'none'; // Hide Pattern Button
    cpuCycleBtnContainer.style.display = 'none';
    applyPlayerDivePattern(0);
    setCpuPattern(0);
    scheduleNextCpuDiveSwitch(clock.getElapsedTime());


    // Clear Sparks
    sparks.forEach(s => scene.remove(s.mesh));
    sparks.length = 0;

    // Reset to match start stats (before power-ups were applied)
    if (matchStartPlayerStats && matchStartEnemyStats) {

        // Update global stats to match start snapshot
        Object.assign(PLAYER_STATS, matchStartPlayerStats);
        Object.assign(ENEMY_STATS, matchStartEnemyStats);

        // Reset entities with match start stats
        resetEntityVisualsAndPhysics(player, matchStartPlayerStats, { x: 0, y: 100 });
        resetEntityVisualsAndPhysics(enemy, matchStartEnemyStats, { x: 0, y: -100 });

    } else {
        // Fallback if no snapshot exists
        resetEntityVisualsAndPhysics(player, PLAYER_STATS, { x: 0, y: 100 });
        resetEntityVisualsAndPhysics(enemy, ENEMY_STATS, { x: 0, y: -100 });
    }
    // Ensure bodies are in world (safe add)
    Composite.remove(engine.world, player.body);
    Composite.remove(engine.world, enemy.body);
    Composite.add(engine.world, [player.body, enemy.body]);

    // Show UI
    launchContainer.style.display = 'flex';
    currentLaunchAngle.value = DEFAULT_LAUNCH_ANGLE;
    updateGuide(currentLaunchAngle.value);
    guideMesh.visible = true;
    syncLaunchSetupUi();
    syncHudButtonColors();
}

function clearWinnerOverlay() {
    document.querySelectorAll('.winner-overlay').forEach((overlay) => overlay.remove());
    document.querySelectorAll('.ko-blank-frame').forEach((overlay) => overlay.remove());
    document.querySelectorAll('.winner-spotlight-frame').forEach((overlay) => overlay.remove());
    activeKoBlankOverlay = null;
}

function requestMatchReset() {
    clearWinnerOverlay();
    sendMultiplayerReset();
    resetMatch();
}

// showResetDialog removed


// Reset Key
window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
        requestMatchReset();
    }
});
