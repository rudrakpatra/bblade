
import Matter from 'matter-js';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import "./style.css";

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
scene.background = new THREE.Color(0x222222);

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

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio); // Fix pixelation
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// --- Orbit Controls ---
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = false;
controls.maxPolarAngle = Math.PI / 2 - 0.1; // Keep floor constraint

// --- Launch UI (Slider + Button)
const launchContainer = document.createElement('div');
launchContainer.id = 'launch-container';
document.body.appendChild(launchContainer);


const currentLaunchAngle = { value: 0 };

// -- Linear Slider --
// -- Pointer Lock Drag Zone --
// -- Pointer Lock Drag Zone (Touch Compatible) --
const dragZone = document.createElement('div');
dragZone.className = 'drag-zone';
dragZone.innerText = "Adjust Launch Angle";
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
};

dragZone.addEventListener('pointerup', endAim);
dragZone.addEventListener('pointercancel', endAim);



// Launch Button
const launchBtn = document.createElement('button');
launchBtn.textContent = 'GO!';
launchBtn.className = 'launch-btn';
launchContainer.appendChild(launchBtn);


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
    if (!player) return;

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

    const startX = player.mesh.position.x;
    const startZ = player.mesh.position.z;

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

const textureLoader = new THREE.TextureLoader();
// Ceramic Matcap for Floor
const floorMatcap = textureLoader.load('https://raw.githubusercontent.com/nidorx/matcaps/master/256/D5D5D5_929292_ACACAC_B4B4B4-256px.png');

const floorGeometry = new THREE.LatheGeometry(profilePoints, 128); // Increased segments for smoothness
floorGeometry.computeVertexNormals(); // Ensure smooth normals

const floorMaterial = new THREE.MeshMatcapMaterial({
    color: 0x111111,
    matcap: floorMatcap,
    side: THREE.DoubleSide
});
const floor = new THREE.Mesh(floorGeometry, floorMaterial);
arenaGroup.add(floor);


// Walls Visual (Ring at top)
const wallGeometry = new THREE.RingGeometry(ARENA_RADIUS + 5, ARENA_RADIUS + 10, 100).translate(0, 0, -2);
const wallMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
const wallMesh = new THREE.Mesh(wallGeometry, wallMaterial);
wallMesh.rotation.x = Math.PI / 2;
wallMesh.position.y = BOWL_MAX_HEIGHT;
arenaGroup.add(wallMesh);






// Helper to create Beyblade 3D Model
function createBeybladeMesh(stats: BeybladeStats): { mesh: THREE.Group, tiltGroup: THREE.Group, spinGroup: THREE.Group } {
    const mesh = new THREE.Group();
    const tiltGroup = new THREE.Group();
    const spinGroup = new THREE.Group();

    mesh.add(tiltGroup);
    tiltGroup.add(spinGroup);

    // Apply global scale
    spinGroup.scale.setScalar(stats.beyScale || 1.0);

    const pm = stats.partMatcaps || {};
    const wheelTex = getMatcapTexture(pm.wheel);
    const ringTex = getMatcapTexture(pm.ring);
    const boltTex = getMatcapTexture(pm.bolt);
    const trackTex = getMatcapTexture(pm.spinTrack);
    const tipTex = getMatcapTexture(pm.tip);

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
    const wheelGeo = createRoundedCylinder(BEYBLADE_RADIUS, 5, 0.8);
    const wheelMat = new THREE.MeshMatcapMaterial({
        color: stats.wheelColor || 0x888888,
        matcap: wheelTex
    });
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.position.y = 5;
    wheel.rotation.x = Math.PI / 2; // Extrude creates on XY plane
    spinGroup.add(wheel);

    // 2. Clear Wheel / Energy Ring - Rounded
    const ringRadius = BEYBLADE_RADIUS * (stats.ringRadiusFactor || 0.75);
    const ringShape = new THREE.Shape();
    ringShape.absarc(0, 0, ringRadius, 0, Math.PI * 2, false);

    // Create hole for ring
    const holePath = new THREE.Path();
    holePath.absarc(0, 0, ringRadius * 0.7, 0, Math.PI * 2, true);
    ringShape.holes.push(holePath);

    let ringGeo: THREE.BufferGeometry = new THREE.ExtrudeGeometry(ringShape, {
        depth: 3, // slightly thinner interaction layer
        bevelEnabled: true,
        bevelThickness: 0.5,
        bevelSize: 0.5,
        bevelSegments: 6, // Smoother bevel
        curveSegments: Math.max(stats.ringSides || 32, 64) // Ensure high curve count unless sides specified
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
    const boltRadius = 10;

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
        depth: 4,
        bevelEnabled: true,
        bevelThickness: 1,
        bevelSize: 1,
        bevelSegments: 2
    });
    boltGeo.center();
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
    const stSize = stats.spinTrackSize || 1.0;
    // Use simple cylinder for stem but rounded for base?
    // Let's stick to Cylinder for the stem part as it's intricate
    let spinTrackGeo: THREE.BufferGeometry = new THREE.CylinderGeometry(BEYBLADE_RADIUS * .3 * stSize, BEYBLADE_RADIUS * .2 * stSize, 10, 32);
    spinTrackGeo = makeSmooth(spinTrackGeo);
    const spinTrackMat = new THREE.MeshMatcapMaterial({
        color: stats.spinTrackColor || 0x222222,
        matcap: trackTex
    });
    const spinTrack = new THREE.Mesh(spinTrackGeo, spinTrackMat);
    spinTrack.position.y = -1;
    spinGroup.add(spinTrack);

    // 5. Tip (Driver) - Rounded Tip
    const tSize = stats.tipSize || 1.0;
    // Lathe for a smooth tip shape
    const tipPoints = [];
    tipPoints.push(new THREE.Vector2(0, 0)); // Bottom contact point (sharp)
    tipPoints.push(new THREE.Vector2(2 * tSize, 1));
    tipPoints.push(new THREE.Vector2(5 * tSize, 8)); // Top wide base
    let tipGeo: THREE.BufferGeometry = new THREE.LatheGeometry(tipPoints, 32); // Smoother tip
    tipGeo = makeSmooth(tipGeo);

    const tipMat = new THREE.MeshMatcapMaterial({
        color: stats.tipColor || 0x333333,
        matcap: tipTex
    });
    const tip = new THREE.Mesh(tipGeo, tipMat);
    tip.position.y = -13;
    spinGroup.add(tip);

    return { mesh, tiltGroup, spinGroup };
}

// Trail System
class TrailSystem {
    mesh: THREE.Line;
    positions: number[] = [];
    maxPoints = 50;
    geometry: THREE.BufferGeometry;

    constructor(color: number, scene: THREE.Scene) {
        this.geometry = new THREE.BufferGeometry();
        // Initialize with default position
        const posArray = new Float32Array(this.maxPoints * 3);
        this.geometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3));

        const material = new THREE.LineBasicMaterial({
            color: color,
            linewidth: 1,
        });

        this.mesh = new THREE.Line(this.geometry, material);
        this.mesh.frustumCulled = false;
        scene.add(this.mesh);
    }

    update(x: number, y: number, z: number) {
        this.positions.push(x, y, z);
        if (this.positions.length > this.maxPoints * 3) {
            this.positions.splice(0, 3);
        }

        const positionAttribute = this.geometry.attributes.position as THREE.BufferAttribute;
        const count = this.positions.length / 3;

        for (let i = 0; i < count; i++) {
            positionAttribute.setXYZ(i, this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]);
        }

        // Fill rest with last point to hide
        const lastX = this.positions[this.positions.length - 3] || x;
        const lastY = this.positions[this.positions.length - 2] || y;
        const lastZ = this.positions[this.positions.length - 1] || z;

        for (let i = count; i < this.maxPoints; i++) {
            positionAttribute.setXYZ(i, lastX, lastY, lastZ);
        }

        positionAttribute.needsUpdate = true;
    }

    clear() {
        this.positions = [];
        const positionAttribute = this.geometry.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < this.maxPoints; i++) {
            positionAttribute.setXYZ(i, 0, 0, 0);
        }
        positionAttribute.needsUpdate = true;
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
    wheelColor: number;
    ringColor: number;
    ringSides: number;
    ringRadiusFactor: number;
    boltColor: number;
    boltSides: number;
    spinTrackColor: number;
    spinTrackSize: number;
    tipColor: number;
    tipSize: number;
    dragFactor: number;
}

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
}
const entities: GameEntity[] = [];

// Physics Constants
// Physics Constants
const FRICTION_LOW = 0.02;
const FRICTION_HIGH = 0.1; // High Drag

const CRIT_SPEED_THRESHOLD = 20;
const BARRIER_DAMAGE = 20; // Self-damage when hitting walls



const DISH_LOW = 1;
const DISH_HIGH = 5;

const CURL_LOW = 1;
const CURL_HIGH = 100;

// Patterns
interface PhysicsPattern {
    name: string;
    dish: number;
    curl: number;
    drag: number;
}

const PATTERNS: PhysicsPattern[] = [
    { name: 'EDGE', dish: DISH_LOW, curl: CURL_HIGH, drag: FRICTION_LOW }, // Aggressive Center (High Curl = Edge/Orbit)
    { name: 'CENTER', dish: DISH_HIGH, curl: CURL_LOW, drag: FRICTION_HIGH }, // Heavy/Stable (High Dish = Center)
];

let currentPatternIndex = 0;

// --- Matcap Resources ---
const MATCAP_ROOT = 'https://raw.githubusercontent.com/nidorx/matcaps/master/';
let MATCAP_LIBRARY: { name: string, file: string, category: string, thumb: string }[] = [
    {
        name: 'Ceramic',
        file: MATCAP_ROOT + '256/D5D5D5_929292_ACACAC_B4B4B4-256px.png',
        category: 'Ceramic',
        thumb: MATCAP_ROOT + '64/D5D5D5_929292_ACACAC_B4B4B4-64px.png'
    }
];

// Helper: Hex to HSL for categorization
function getMatcapCategory(filename: string): string {
    if (!filename.endsWith('.png')) return 'Other';
    // Remove resolution suffix if present (e.g. -256px)
    const raw = filename.replace(/-[0-9]+px\.png$/, '.png').replace('.png', '');
    const parts = raw.split('_');
    if (parts.length < 4) return 'Other';

    let r = 0, g = 0, b = 0;
    parts.forEach(hex => {
        const bigint = parseInt(hex, 16);
        r += (bigint >> 16) & 255;
        g += (bigint >> 8) & 255;
        b += bigint & 255;
    });
    r /= parts.length; g /= parts.length; b /= parts.length;

    // RGB to HSL
    r /= 255, g /= 255, b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0, l = (max + min) / 2;

    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }
    const hDeg = h * 360;

    if (s < 0.15) {
        if (l < 0.2) return 'Dark';
        if (l > 0.8) return 'Ceramic';
        return 'Silver';
    } else {
        if (hDeg >= 30 && hDeg < 60 && l > 0.4) return 'Gold/Bronze';
        if (hDeg >= 0 && hDeg < 30) return 'Red';
        if (hDeg >= 330 && hDeg <= 360) return 'Red';
        if (hDeg >= 60 && hDeg < 150) return 'Green';
        if (hDeg >= 150 && hDeg < 260) return 'Cyan/Blue';
        if (hDeg >= 260 && hDeg < 330) return 'Purple';
        return 'Color';
    }
}

async function loadMatcapLibrary() {
    try {
        const response = await fetch('/matcaps_library.json');
        const data = await response.json();
        MATCAP_LIBRARY = data
            .filter((f: any) => f.name.endsWith('.png'))
            .map((f: any) => {
                // Determine logic to swap resolution
                // Original name is 1024/Hex.png or just Hex.png inside the json "name" field
                // The json "name" from the raw file list is just the filename usually?
                // Let's check the json structure you viewed earlier.
                // It has "path": "1024/..." and "name": "..." 

                const baseName = f.name; // e.g. "0404E8.....png"
                const nameWithoutExt = baseName.replace('.png', '');

                // Nidorx naming convention for other sizes:
                // 1024/NAME.png
                // 256/NAME-256px.png
                // 64/NAME-64px.png

                return {
                    name: baseName,
                    file: `${MATCAP_ROOT}256/${nameWithoutExt}-256px.png`,
                    category: getMatcapCategory(baseName),
                    thumb: `${MATCAP_ROOT}64/${nameWithoutExt}-64px.png`
                };
            });
        console.log(`Loaded ${MATCAP_LIBRARY.length} matcaps.`);
    } catch (e) {
        console.error('Failed to load matcap library:', e);
        // Keep default
    }
}

// Start loading immediately
loadMatcapLibrary();

const textureCache: Record<string, THREE.Texture> = {};
// textureLoader already defined above or we get from global if available. 
// Actually textureLoader was defined in main scope, let's just use it or create new if scope issue.
// Global textureLoader is at line ~350, so it should be visible here.
const defaultMatcapUrl = 'https://raw.githubusercontent.com/nidorx/matcaps/master/256/D5D5D5_929292_ACACAC_B4B4B4-256px.png';
const matcapTexture = textureLoader.load(defaultMatcapUrl);

function getMatcapTexture(url: string | undefined): THREE.Texture {
    if (!url) return matcapTexture; // Default ceramic

    if (!textureCache[url]) {
        textureCache[url] = textureLoader.load(url);
    }
    return textureCache[url];
}



// Stats Presets
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
    wheelColor: 0x888888,
    ringColor: 0x0088ff, // Blue
    ringSides: 32,
    ringRadiusFactor: 0.75,
    boltColor: 0x00ccff, // Cyan
    boltSides: 6,
    spinTrackColor: 0x222222,
    spinTrackSize: 1.0,
    tipColor: 0x333333,
    tipSize: 1.0,
    trailColor: 0x00ffff, // Default Cyan
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
    wheelColor: 0x888888,
    ringColor: 0xff6600, // Orange
    ringSides: 32,
    ringRadiusFactor: 0.75,
    boltColor: 0xffaa00, // Gold
    boltSides: 6,
    spinTrackColor: 0x222222,
    spinTrackSize: 1.0,
    tipColor: 0x333333,
    tipSize: 1.0,
    trailColor: 0x00ffff, // Main Cyan
    // Arena Forces
    dishForce: 2, // DISH_LOW
    curlForce: 1, // CURL_LOW
    dragFactor: 0.000
};

// Defaults for Reset
const DEFAULT_PLAYER_STATS = JSON.parse(JSON.stringify(PLAYER_STATS));
const DEFAULT_ENEMY_STATS = JSON.parse(JSON.stringify(ENEMY_STATS));

function savePresets() {
    localStorage.setItem('bblade_player_stats', JSON.stringify(PLAYER_STATS));
    localStorage.setItem('bblade_enemy_stats', JSON.stringify(ENEMY_STATS));
}

function loadPresets() {
    const pData = localStorage.getItem('bblade_player_stats');
    if (pData) {
        // Merge with default to ensure new fields are present
        const parsed = JSON.parse(pData);
        Object.assign(PLAYER_STATS, { ...DEFAULT_PLAYER_STATS, ...parsed });
    }
    const eData = localStorage.getItem('bblade_enemy_stats');
    if (eData) {
        const parsed = JSON.parse(eData);
        Object.assign(ENEMY_STATS, { ...DEFAULT_ENEMY_STATS, ...parsed });
    }
}

// Load Immediately
loadPresets();

const VISUAL_FIELDS = [
    { key: 'beyScale', label: 'SCALE', hint: 'Size', type: 'number', step: 0.1 },
    { key: 'wheelColor', label: 'WHEEL', hint: 'Hex', type: 'color' },
    { key: 'ringColor', label: 'RING', hint: 'Hex', type: 'color' },
    { key: 'ringRadiusFactor', label: 'RING RADIUS', hint: 'Size factor', type: 'number', step: 0.05 },
    { key: 'ringSides', label: 'RING SIDES', hint: 'Shape sides', type: 'number', step: 1 },
    { key: 'boltColor', label: 'BOLT', hint: 'Hex', type: 'color' },
    { key: 'boltSides', label: 'BOLT SIDES', hint: 'Hex/Circle', type: 'number', step: 1 },
    { key: 'spinTrackColor', label: 'TRACK', hint: 'Hex', type: 'color' },
    { key: 'spinTrackSize', label: 'ST SIZE', hint: 'Track depth', type: 'number', step: 0.1 },
    { key: 'tipColor', label: 'TIP', hint: 'Hex', type: 'color' },
    { key: 'tipSize', label: 'TIP SIZE', hint: 'Radius', type: 'number', step: 0.1 },
    { key: 'trailColor', label: 'TRAIL', hint: 'Hex', type: 'color' },
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
updateGuide(0);

// Trigger once logic moved to setup


// --- Interaction State ---
let isDragging = false;
let hasLaunched = false;
let gameOver = false;

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
        <button class="rpm-label" id="p1-btn" style="cursor: pointer; text-decoration: underline;">P1</button>
        <span id="player-rpm" class="rpm-text">0</span>
        <meter id="player-meter" min="0" max="1000" low="200" high="800" optimum="1000" value="0"></meter>
    </div>
    <div class="hud-divider">VS</div>
    <div class="hud-group">
        <meter id="enemy-meter" min="0" max="1000" low="200" high="800" optimum="1000" value="0" style="transform: scaleX(-1);"></meter>
        <span id="enemy-rpm" class="rpm-text">0</span>
        <button class="rpm-label" id="cpu-btn" style="cursor: pointer; text-decoration: underline;">CPU</button>
    </div>
`;
uiContainer.appendChild(hudTopBar);

// Floating Action HUD (Pool + Reset buttons)
const actionHud = document.createElement('div');
actionHud.id = 'action-hud';
actionHud.className = 'action-hud';

const resetHint = document.createElement('button');
resetHint.className = 'action-hud-btn';
resetHint.innerText = 'RESET';
resetHint.onclick = () => resetMatch();
resetHint.style.display = 'none';
actionHud.appendChild(resetHint);

uiContainer.appendChild(actionHud);




// --- Cycle Button ---
const cycleBtnContainer = document.createElement('div');
cycleBtnContainer.className = 'cycle-container';
cycleBtnContainer.style.display = 'none'; // Hidden initially
uiContainer.appendChild(cycleBtnContainer);

function updatePhysicsFromPattern() {
    if (!player || !player.body || !player.stats) return;

    // Standard Pattern Logic
    const p = PATTERNS[currentPatternIndex];
    player.stats.dishForce = p.dish;
    player.stats.curlForce = p.curl;
    player.body.frictionAir = p.drag;
    player.stats.frictionAir = p.drag;
}

// Dive Logic
const setPattern = (e: Event | null, pattern: number) => {
    if (e) e.preventDefault(); // Prevent ghost clicks
    currentPatternIndex = pattern;
    if (pattern === 1) cycleBtn.classList.add('active');
    else cycleBtn.classList.remove('active');
    updatePhysicsFromPattern();
};

// Input for Dive Mode (Space)
window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && currentPatternIndex !== 1) {
        setPattern(null, 1);
    }
});

window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
        setPattern(null, 0);
    }
});

const cycleBtn = document.createElement('button');
cycleBtn.className = 'pattern-btn';
currentPatternIndex = 0;
cycleBtn.innerHTML = `
    <span class="value">DIVE</span>
`;

// Event Listeners for Button
cycleBtn.addEventListener('mousedown', (e) => { setPattern(e, 1) });
cycleBtn.addEventListener('pointerdown', (e) => { setPattern(e, 1) }, { passive: false });

cycleBtn.addEventListener('pointerup', (e) => { setPattern(e, 0) });
cycleBtn.addEventListener('pointerleave', (e) => { setPattern(e, 0) });


cycleBtnContainer.appendChild(cycleBtn);

// Init Physics
updatePhysicsFromPattern();

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

// --- Audio System (Keep same) ---
const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();

// Create a noise buffer once
const bufferSize = audioCtx.sampleRate * 0.1; // 0.1 seconds
const noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
const data = noiseBuffer.getChannelData(0);
for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
}

function playCollisionSound(intensity: number, baseFrequency: number) {
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }

    const t = audioCtx.currentTime;
    const masterGain = audioCtx.createGain();
    masterGain.connect(audioCtx.destination);
    masterGain.gain.setValueAtTime(intensity, t);

    // 1. Impact "Thud"
    const noise = audioCtx.createBufferSource();
    noise.buffer = noiseBuffer;
    const noiseFilter = audioCtx.createBiquadFilter();
    noiseFilter.type = 'highpass';
    noiseFilter.frequency.value = 100;
    const noiseGain = audioCtx.createGain();

    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(masterGain);

    noiseGain.gain.setValueAtTime(0.7, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.025, t + 0.1);
    noise.start(t);
    noise.stop(t + 0.1);

    // 2. Heavy Metal Clang
    const scale = [1, 3 / 2, 5 / 4, 7 / 4, 2];
    const pick = Math.floor(Math.random() * scale.length);
    // Use the passed baseFrequency instead of calculating from 200 constant
    // But keep the scale variation? user passed 200/400/100, so we can treat that as the "200" in original code
    const baseFreq = baseFrequency * scale[pick];
    const ratios = [1, 1.5, 2.0, 2.5];

    ratios.forEach((ratio, index) => {
        const osc = audioCtx.createOscillator();
        const oscGain = audioCtx.createGain();

        osc.type = index % 2 == 0 ? 'square' : 'triangle';
        osc.frequency.setValueAtTime(baseFreq * ratio, t);

        osc.connect(oscGain);
        oscGain.connect(masterGain);

        oscGain.gain.setValueAtTime(0.0, t);
        oscGain.gain.linearRampToValueAtTime(0.6 / (index + 0.8), t + 0.002);

        const decayDuration = 0.3 + (Math.random() * 0.2) + (1.0 / (index + 1)) * 0.5;
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
            const rawDmgA = isCritA ? entityA.stats.crtAtk : entityA.stats.atk;
            const finalDmgA = Math.max(0, rawDmgA - entityB.stats.def);

            if (entityB.currentRpm !== undefined) {
                entityB.currentRpm = Math.max(0, entityB.currentRpm - finalDmgA);
            }

            // B hits A
            const speedB = entityB.body.speed;
            const isCritB = speedB > CRIT_SPEED_THRESHOLD;
            const rawDmgB = isCritB ? entityB.stats.crtAtk : entityB.stats.atk;
            const finalDmgB = Math.max(0, rawDmgB - entityA.stats.def);

            if (entityA.currentRpm !== undefined) {
                entityA.currentRpm = Math.max(0, entityA.currentRpm - finalDmgB);
            }


            // Sparks & Sound
            const isHighSpeed = isCritA || isCritB;

            const count = isHighSpeed ? 15 : 3;
            const speed = isHighSpeed ? 5 : 2;

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
            }
            if (isHighSpeed)
                playCollisionSound(0.5, 400); // High Pitch
            else
                playCollisionSound(0.2, 200); // Normal Pitch
        } else {
            // Fallback / Wall hits
            // If one is a Beyblade and the other is not (Environment), apply Barrier Damage
            if (entityA && !entityB) {
                // A hit a wall
                if (entityA.currentRpm !== undefined) {
                    entityA.currentRpm = Math.max(0, entityA.currentRpm - BARRIER_DAMAGE);
                }
            } else if (entityB && !entityA) {
                // B hit a wall
                if (entityB.currentRpm !== undefined) {
                    entityB.currentRpm = Math.max(0, entityB.currentRpm - BARRIER_DAMAGE);
                }
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
const SUBSTEPS = 8;
let frameCounter = 0;


function animate() {
    requestAnimationFrame(animate);

    // Physics Update
    const subStepDelta = (1000 / 60) / SUBSTEPS;
    for (let i = 0; i < SUBSTEPS; i++) {
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
                    const radialX = -px / dist;
                    const radialY = -py / dist;


                    // Tangent direction (perpendicular, clockwise)
                    // Rotate radial 90° clockwise: (x, y) -> (y, -x)
                    const tangentX = radialY;
                    const tangentY = -radialX;

                    if (entity.currentRpm === undefined) return;
                    // const life = entity.currentRpm / entity.stats.maxRpm;
                    // Calculate force magnitudes
                    const dishMagnitude = FORCE_CONSTANT * entity.body.mass * dist * entity.stats.dishForce;
                    const curlMagnitude = FORCE_CONSTANT * entity.body.mass * (1 - dist / ARENA_RADIUS) * entity.stats.curlForce;

                    // Apply combined force
                    Body.applyForce(entity.body, entity.body.position, {
                        x: radialX * dishMagnitude + tangentX * curlMagnitude,
                        y: radialY * dishMagnitude + tangentY * curlMagnitude
                    });
                }
            });
        }
    }

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

                entity.driftVelocity = driftV;

                entity.driftRotation = new THREE.Vector3(
                    Math.random() * 0.2 - 0.1,
                    Math.random() * 0.2 - 0.1,
                    Math.random() * 0.2 - 0.1
                );

                // Remove from Physics World
                Composite.remove(engine.world, entity.body);

                // Win Condition Check
                if (!gameOver) {
                    gameOver = true;
                    if (entity === player) {
                        showWinner('CPU WINS');
                    } else if (entity === enemy) {
                        showWinner('P1 WINS');
                    }
                }
            }
        }

        // --- Visual Update ---
        if (entity.isDead) {
            // Asteroid Mode
            if (entity.driftVelocity && entity.driftRotation) {
                entity.mesh.position.add(entity.driftVelocity);
                entity.mesh.rotation.x += entity.driftRotation.x;
                entity.mesh.rotation.y += entity.driftRotation.y;
                entity.mesh.rotation.z += entity.driftRotation.z;

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
            const decay = entity.stats.sta * (subStepDelta / 1000) * SUBSTEPS;
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
    }

    // Update controls
    controls.update();

    if (!hasLaunched) {
        const angle = currentLaunchAngle.value;
        updateGuide(angle);
        guideMesh.visible = true;
        arrowMat.uniforms.uTime.value = clock.getElapsedTime();
    } else {
        guideMesh.visible = false;
        launchContainer.style.display = 'none';
    }

    renderer.render(scene, camera);


}
// --- Visual Forge Helpers ---

function createInput(id: string, label: string, value: any, hint: string, type: string, step: number | string, onChange: (val: any) => void) {
    const div = document.createElement('div');
    div.className = 'stat-item';

    // Handle color values (hex num to #hex str)
    let displayValue = value;
    if (type === 'color') {
        const safeVal = value ?? 0; // Fallback to black if undefined
        displayValue = '#' + safeVal.toString(16).padStart(6, '0');
    }

    div.innerHTML = `
        <label class="stat-label" for="${id}">${label}</label>
        <input class="stat-input" type="${type}" ${type === 'number' ? `step="${step}"` : ''} id="${id}" value="${displayValue}">
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
let previewBeyblade: { mesh: THREE.Group, tiltGroup: THREE.Group, spinGroup: THREE.Group } | null = null;

function updatePreview(stats: BeybladeStats) {
    if (!previewScene) return;
    if (previewBeyblade) {
        previewScene.remove(previewBeyblade.mesh);
    }
    previewBeyblade = createBeybladeMesh(stats);
    previewScene.add(previewBeyblade.mesh);
}

// --- Stat Changer UI ---
function openStatEditor(targetStats: BeybladeStats, targetName: string) {
    try {
        let previewControls: OrbitControls | null = null;
        // Create a working copy of stats so we don't apply immediately
        const tempStats = JSON.parse(JSON.stringify(targetStats));


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
        closeBtn.innerText = '×';
        closeBtn.onclick = () => {
            dialog.close();
        };
        header.appendChild(closeBtn);
        container.appendChild(header);

        // --- Visual Forge Section (Compact & Wrapped) ---
        const vSection = document.createElement('div');
        vSection.className = 'stat-section';
        vSection.innerHTML = `<div class="section-title">Visual</div>`;

        const vContainer = document.createElement('div');
        vContainer.className = 'forge-container';
        vSection.appendChild(vContainer);

        // 1. Preview (Floated Left)
        const previewContainer = document.createElement('div');
        previewContainer.className = 'preview-float';
        vContainer.appendChild(previewContainer);

        VISUAL_FIELDS.forEach(field => {
            try {
                // Custom compact input creation
                const div = createInput(
                    `v-${field.key}`,
                    field.label,
                    (targetStats as any)[field.key], // Use targetStats for initial display
                    field.hint,
                    field.type,
                    field.step || 1,
                    (val) => {
                        (tempStats as any)[field.key] = val;
                        updatePreview(tempStats);
                    }
                );
                vContainer.appendChild(div);
            } catch (e) {
                console.error('Error creating input for field:', field.key, e);
            }
        });
        container.appendChild(vSection);


        // Setup Preview Scene
        requestAnimationFrame(() => {
            const width = previewContainer.clientWidth;
            const height = previewContainer.clientHeight;

            // Get renderer from pool instead of creating new one
            previewRenderer = getOrCreateRenderer();
            previewRenderer.setSize(width, height);
            previewRenderer.setClearColor(0x000000, 0); // Transparent background
            previewContainer.appendChild(previewRenderer.domElement);

            previewScene = new THREE.Scene();
            previewCamera = new THREE.PerspectiveCamera(50, width / height, 1, 1000);
            previewCamera.position.set(0, 40, 60);
            previewCamera.lookAt(0, 5, 0);

            // Orbit Controls for Preview
            previewControls = new OrbitControls(previewCamera, previewRenderer.domElement);
            previewControls.enableDamping = false; // User requested removal

            // Lights
            const ambient = new THREE.AmbientLight(0xffffff, 1.5);
            previewScene.add(ambient);
            const dir = new THREE.DirectionalLight(0xffffff, 2);
            dir.position.set(10, 50, 20);
            previewScene.add(dir);

            updatePreview(tempStats);

            function animatePreview() {
                if (!previewRenderer) return;
                requestAnimationFrame(animatePreview);

                if (previewControls) previewControls.update();

                // No rotation as requested
                // if (previewBeyblade) {
                //     previewBeyblade.spinGroup.rotation.y += 0.02;
                // }

                previewRenderer.render(previewScene!, previewCamera!);
            }
            animatePreview();
        });

        // --- Visual Forge (Multi-Part Matcap Selector) ---
        const matcapSection = document.createElement('div');
        matcapSection.className = 'stat-section';
        matcapSection.innerHTML = `<div class=\"section-title\">Material</div>`;

        // 1. Part Selector Tabs
        const parts = [
            { id: 'wheel', label: 'Wheel' },
            { id: 'ring', label: 'Ring' },
            { id: 'bolt', label: 'Bolt' },
            { id: 'spinTrack', label: 'Track' },
            { id: 'tip', label: 'Tip' }
        ];
        let activePart = 'wheel'; // Default selection

        const tabContainer = document.createElement('div');
        tabContainer.style.display = 'flex';
        tabContainer.style.gap = '5px';
        tabContainer.style.marginBottom = '10px';

        parts.forEach(p => {
            const tab = document.createElement('button');
            tab.innerText = p.label;
            tab.className = 'editor-btn';
            tab.style.flex = '1';
            tab.style.padding = '5px';
            tab.style.fontSize = '12px';
            if (p.id === activePart) tab.style.background = '#444'; // Highlight active

            tab.onclick = () => {
                console.log('Tab clicked:', p.id);
                activePart = p.id;
                // Update tab styles
                Array.from(tabContainer.children).forEach((c: any) => c.style.background = '#222');
                tab.style.background = '#444';
                renderMatcapGrid(); // Refresh grid state
            };
            tabContainer.appendChild(tab);
        });
        matcapSection.appendChild(tabContainer);

        // 2. Matcap Grid Container
        const matcapGrid = document.createElement('div');
        matcapGrid.style.display = 'grid';
        matcapGrid.style.gridTemplateColumns = 'repeat(5, 1fr)';
        matcapGrid.style.gap = '8px';
        matcapGrid.style.maxHeight = '200px';
        matcapGrid.style.overflowY = 'auto';
        matcapGrid.style.marginBottom = '15px';
        matcapSection.appendChild(matcapGrid);

        // Function to render grid based on library
        function renderMatcapGrid() {
            console.log('Rendering grid for:', activePart, 'Library size:', MATCAP_LIBRARY.length);
            matcapGrid.innerHTML = '';

            // Allow "No Matcap" option (Clear)
            const clearBtn = document.createElement('div');
            clearBtn.innerText = 'X';
            clearBtn.className = 'matcap-btn';
            clearBtn.style.background = '#333';
            clearBtn.style.color = '#fff';
            clearBtn.style.display = 'flex';
            clearBtn.style.alignItems = 'center';
            clearBtn.style.justifyContent = 'center';
            clearBtn.onclick = () => {
                if (!tempStats.partMatcaps) tempStats.partMatcaps = {};
                delete tempStats.partMatcaps[activePart];
                updatePreview(tempStats);
            };
            matcapGrid.appendChild(clearBtn);

            MATCAP_LIBRARY.forEach(mc => {
                // UI uses 64px thumb
                const thumbUrl = mc.thumb;
                // Application uses 256px full
                const fullUrl = mc.file;

                const btn = document.createElement('div');
                btn.className = 'matcap-btn';
                btn.title = `${mc.category}: ${mc.name}`;
                btn.style.width = '100%';
                btn.style.aspectRatio = '1';
                btn.style.borderRadius = '50%';
                btn.style.cursor = 'pointer';
                btn.style.background = `url(${thumbUrl})`;
                btn.style.backgroundSize = 'cover';
                btn.style.border = '2px solid transparent';
                btn.style.boxShadow = '0 2px 5px rgba(0,0,0,0.5)';

                // Highlight if currently selected for this part (compare against fullUrl)
                const currentVal = tempStats.partMatcaps?.[activePart];
                if (currentVal === fullUrl) {
                    btn.style.border = '2px solid #fff';
                }

                btn.onclick = () => {
                    const prev = matcapGrid.querySelectorAll('.matcap-btn');
                    prev.forEach(p => (p as HTMLElement).style.border = '2px solid transparent');
                    btn.style.border = '2px solid #fff';

                    if (!tempStats.partMatcaps) tempStats.partMatcaps = {};
                    tempStats.partMatcaps[activePart] = fullUrl; // Save high res
                    updatePreview(tempStats);
                };

                matcapGrid.appendChild(btn);
            });
        }

        renderMatcapGrid(); // Initial render
        container.appendChild(matcapSection);

        // --- Combat Stats Section ---
        const pSection = document.createElement('div');
        pSection.className = 'stat-section';
        pSection.innerHTML = `<div class="section-title">Combat Logic</div>`;

        const pGrid = document.createElement('div');
        pGrid.className = 'stat-grid';

        const combatFields = [
            { key: 'atk', label: 'ATTACK', hint: 'Damage', type: 'number', step: 1 },
            { key: 'def', label: 'DEFENSE', hint: 'Resistance', type: 'number', step: 1 },
            { key: 'sta', label: 'STAMINA', hint: 'Endurance', type: 'number', step: 1 },
            { key: 'spd', label: 'SPEED', hint: 'Velocity', type: 'number', step: 1 },
            { key: 'wt', label: 'WEIGHT', hint: 'Mass', type: 'number', step: 0.1 },
            { key: 'crtAtk', label: 'CRIT ATK', hint: 'Crit Dmg', type: 'number', step: 1 },
        ];

        combatFields.forEach(field => {
            pGrid.appendChild(createInput(
                `p-${field.key}`,
                field.label,
                (targetStats as any)[field.key],
                field.hint,
                field.type,
                field.step,
                (val) => {
                    (tempStats as any)[field.key] = val;
                }
            ));
        });
        pSection.appendChild(pGrid);
        container.appendChild(pSection);

        // Actions
        const actions = document.createElement('div');
        actions.className = 'preset-actions';

        const resetBtn = document.createElement('button');
        resetBtn.className = 'action-btn reset';
        resetBtn.innerText = 'RESET DEFAULTS';
        resetBtn.style.flex = '0 0 auto';

        resetBtn.onclick = () => {
            if (confirm(`Reset ${targetName} to defaults? This cannot be undone.`)) {
                if (targetName === 'Player') Object.assign(targetStats, DEFAULT_PLAYER_STATS);
                if (targetName === 'CPU') Object.assign(targetStats, DEFAULT_ENEMY_STATS);

                // Update snapshot so resetMatch uses new defaults
                if (targetName === 'Player') matchStartPlayerStats = JSON.parse(JSON.stringify(DEFAULT_PLAYER_STATS));
                if (targetName === 'CPU') matchStartEnemyStats = JSON.parse(JSON.stringify(DEFAULT_ENEMY_STATS));

                savePresets();
                dialog.close();
                resetMatch();
            }
        };

        const saveBtn = document.createElement('button');
        saveBtn.className = 'action-btn save';
        saveBtn.textContent = 'SAVE & APPLY';

        saveBtn.onclick = () => {
            // Apply temp stats to target
            Object.assign(targetStats, tempStats);

            // Update snapshot so resetMatch uses new stats
            if (targetName === 'Player') matchStartPlayerStats = JSON.parse(JSON.stringify(targetStats));
            if (targetName === 'CPU') matchStartEnemyStats = JSON.parse(JSON.stringify(targetStats));

            savePresets();
            dialog.close();
            resetMatch();
        };

        actions.appendChild(resetBtn);
        actions.appendChild(saveBtn);
        container.appendChild(actions);

        // Handle Dialog Close Event for Cleanup
        dialog.addEventListener('close', () => {
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
        openStatEditor(PLAYER_STATS, 'Player');
    };
} else {
    console.error('P1 Btn not found!');
}

if (cpuBtn) {
    cpuBtn.onclick = () => {
        openStatEditor(ENEMY_STATS, 'CPU');
    };
}

animate();



// --- Input Processing ---
// Removed Drag interaction for Launch. Using UI instead.

launchBtn.addEventListener('click', () => {
    if (hasLaunched) return;

    hasLaunched = true;

    // Player Launch
    const angleRad = (currentLaunchAngle.value * Math.PI) / 180;

    // Use player stats for speed
    const launchSpeed = player.stats ? player.stats.spd : 200;

    // Matter.js velocity
    const vx = Math.cos(angleRad) * launchSpeed * 0.1;
    const vy = Math.sin(angleRad) * launchSpeed * 0.1;

    Body.setVelocity(player.body, { x: vx, y: vy });

    // Initialize Player HP (RPM)
    if (player.stats) {
        player.currentRpm = player.stats.maxRpm;
        // visual spin speed (rad/s approx rpm/100)
        Body.setAngularVelocity(player.body, player.currentRpm / 100);
    } else {
        Body.setAngularVelocity(player.body, 50); // Fallback
    }

    // Enemy Launch (Random Angle, Max Power)
    const enemyAngle = Math.random() * Math.PI * 2;
    const enemySpeed = enemy.stats ? enemy.stats.spd : 200;
    const enemyVx = Math.cos(enemyAngle) * enemySpeed * 0.1;
    const enemyVy = Math.sin(enemyAngle) * enemySpeed * 0.1;

    Body.setVelocity(enemy.body, { x: enemyVx, y: enemyVy });

    // Initialize Enemy HP (RPM)
    if (enemy.stats) {
        enemy.currentRpm = enemy.stats.maxRpm;
        Body.setAngularVelocity(enemy.body, enemy.currentRpm / 100);
    } else {
        Body.setAngularVelocity(enemy.body, 50);
    }

    // Save stats snapshot at match start (for "Keep Power-Ups" reset)
    matchStartPlayerStats = JSON.parse(JSON.stringify(player.stats));
    matchStartEnemyStats = JSON.parse(JSON.stringify(enemy.stats));

    // Hide UI handled in animate loop or here
    launchContainer.style.display = 'none';
    cycleBtnContainer.style.display = 'flex'; // Show Pattern Button

    // Update action HUD buttons
    resetHint.style.display = 'block';
});

// Window Resize Handling
window.addEventListener('resize', () => {
    const aspect = window.innerWidth / window.innerHeight;
    const frustumSize = 600;

    camera.left = frustumSize * aspect / -2;
    camera.right = frustumSize * aspect / 2;
    camera.top = frustumSize / 2;
    camera.bottom = frustumSize / -2;
    camera.updateProjectionMatrix();

    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
});

// Game Over / Winner UI
function showWinner(text: string) {
    const overlay = document.createElement('div');
    overlay.className = 'winner-overlay';

    const title = document.createElement('div');
    title.className = 'winner-title';
    title.innerText = text;
    overlay.appendChild(title);

    const rematchBtn = document.createElement('button');
    rematchBtn.className = 'rematch-btn';
    rematchBtn.innerText = 'REMATCH';
    rematchBtn.onclick = () => {
        document.body.removeChild(overlay);
        resetMatch();
    };
    overlay.appendChild(rematchBtn);

    document.body.appendChild(overlay);
}

const resetEntityVisualsAndPhysics = (entity: GameEntity, stats: BeybladeStats, startPos: { x: number, y: number }) => {
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
    if (entity.trail && entity.trail.mesh.material instanceof THREE.LineBasicMaterial) {
        entity.trail.mesh.material.color.setHex(stats.trailColor);
        entity.trail.clear();
    }

    // 5. Reset Game Logic Stats
    entity.stats = stats; // Ensure reference is up to date
    entity.isDead = false;
    entity.currentRpm = 0;

    // 6. Clear drift properties (prevents weird movement after reset)
    entity.driftVelocity = undefined;
    entity.driftRotation = undefined;
};

function resetMatch() {
    hasLaunched = false;
    gameOver = false;

    // Update action HUD buttons
    resetHint.style.display = 'none';
    cycleBtnContainer.style.display = 'none'; // Hide Pattern Button


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
    updateGuide(currentLaunchAngle.value);
    guideMesh.visible = true;
}

// showResetDialog removed


// Reset Key
window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
        const overlay = document.querySelector('.winner-overlay');
        if (overlay && overlay.parentNode) {
            overlay.parentNode.removeChild(overlay);
        }
        resetMatch();
    }
});
