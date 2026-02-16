
import Matter from 'matter-js';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
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



// Lights
const ambientLight = new THREE.AmbientLight(0x404040, 2); // Soft white light
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 2);
dirLight.position.set(100, 200, 100);
dirLight.castShadow = true;
dirLight.shadow.mapSize.width = 2048;
dirLight.shadow.mapSize.height = 2048;
scene.add(dirLight);


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

const floorGeometry = new THREE.LatheGeometry(profilePoints, 64);
const floorMaterial = new THREE.MeshBasicMaterial({
    color: 0x333333,
    side: THREE.DoubleSide
});
const floor = new THREE.Mesh(floorGeometry, floorMaterial);
arenaGroup.add(floor);


// Walls Visual (Ring at top)
const wallGeometry = new THREE.TorusGeometry(ARENA_RADIUS, 5, 16, 100);
const wallMaterial = new THREE.MeshBasicMaterial({ color: 0x666666 });
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

    // 1. Metal Wheel (Base)
    const wheelGeo = new THREE.CylinderGeometry(BEYBLADE_RADIUS, BEYBLADE_RADIUS, 4, 32);
    const wheelMat = new THREE.MeshMatcapMaterial({
        color: stats.wheelColor || 0x888888,
    });
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.position.y = 5;
    spinGroup.add(wheel);

    // 2. Clear Wheel / Energy Ring
    const ringRadius = BEYBLADE_RADIUS * (stats.ringRadiusFactor || 0.75);
    const ringGeo = new THREE.CylinderGeometry(ringRadius, ringRadius, 8, stats.ringSides || 32);
    const ringMat = new THREE.MeshMatcapMaterial({
        color: stats.ringColor || 0x0088ff,
    });

    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.y = 6;
    spinGroup.add(ring);

    // 3. Face Bolt
    const boltGeo = new THREE.CylinderGeometry(10, 10, 4, stats.boltSides || 6);
    const boltMat = new THREE.MeshMatcapMaterial({
        color: stats.boltColor || 0x00ccff,
    });
    const bolt = new THREE.Mesh(boltGeo, boltMat);
    bolt.position.y = 12;
    spinGroup.add(bolt);

    // 4. Spin Track
    const stSize = stats.spinTrackSize || 1.0;
    const spinTrackGeo = new THREE.CylinderGeometry(BEYBLADE_RADIUS * .3 * stSize, BEYBLADE_RADIUS * .2 * stSize, 6, 10);
    const spinTrackMat = new THREE.MeshMatcapMaterial({
        color: stats.spinTrackColor || 0x222222,
    });
    const spinTrack = new THREE.Mesh(spinTrackGeo, spinTrackMat);
    spinTrack.position.y = -2;
    spinGroup.add(spinTrack);

    // 5. Tip
    const tSize = stats.tipSize || 1.0;
    const tipGeo = new THREE.CylinderGeometry(5 * tSize, 2 * tSize, 10);
    const tipMat = new THREE.MeshMatcapMaterial({
        color: stats.tipColor || 0x333333,
    });
    const tip = new THREE.Mesh(tipGeo, tipMat);
    tip.position.y = -5;
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
            linewidth: 2
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
    crt: number;
    frictionAir: number;
    restitution: number;
    friction: number;
    densityBase: number;
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

// --- Power-Up System ---
interface PowerUp {
    id: string;
    label: string;
    detail: string;
    apply: (entity: GameEntity) => void;
}

// Physics Constants
const FRICTION_LOW = 0.02;
const FRICTION_HIGH = 0.1;

const DISH_LOW = 2;
const DISH_HIGH = 5;

const CURL_LOW = 1;
const CURL_HIGH = 50;

// Power-Up Type Definitions
const POWERUP_TYPES: PowerUp[] = [
    {
        id: 'atk_boost',
        label: 'ATK +2',
        detail: 'Increased Dmg',
        apply: (entity) => {
            if (entity.stats) entity.stats.atk += 2;
        }
    },
    {
        id: 'def_boost',
        label: 'DEF +2',
        detail: 'Reduced Dmg',
        apply: (entity) => {
            if (entity.stats) entity.stats.def += 2;
        }
    },
    {
        id: 'sta_drain',
        label: 'DECAY -5%',
        detail: 'Decay Rate',
        apply: (entity) => {
            if (entity.stats) entity.stats.sta *= 0.95;
        }
    },
    {
        id: 'crit_boost',
        label: 'CRT% +5',
        detail: 'Crit% +=5',
        apply: (entity) => {
            if (entity.stats) entity.stats.crt += 0.05;
        }
    },
    {
        id: 'swap_drag',
        label: 'Swap D',
        detail: 'Drag',
        apply: (entity) => {
            if (entity.stats) {
                entity.stats.frictionAir = (entity.stats.frictionAir !== FRICTION_LOW) ? FRICTION_LOW : FRICTION_HIGH;
                entity.body.frictionAir = entity.stats.frictionAir;
            }
        }
    },
    {
        id: 'swap_radial',
        label: 'Swap R',
        detail: 'Radial',
        apply: (entity) => {
            if (entity.stats) {
                entity.stats.dishForce = (entity.stats.dishForce !== DISH_LOW) ? DISH_LOW : DISH_HIGH;
            }
        }
    },
    {
        id: 'swap_tangent',
        label: 'Swap T',
        detail: 'Tangential',
        apply: (entity) => {
            if (entity.stats) {
                entity.stats.curlForce = (entity.stats.curlForce !== CURL_LOW) ? CURL_LOW : CURL_HIGH;
            }
        }
    }
];

// Power-Up Pool Configuration (default counts)
interface PoolConfig {
    [key: string]: number;
}

const DEFAULT_POOL_CONFIG: PoolConfig = {
    'atk_boost': 3,
    'def_boost': 3,
    'sta_drain': 2,
    'crit_boost': 2,
    'swap_drag': 4,
    'swap_radial': 4,
    'swap_tangent': 4
};

class PowerUpPool {
    private pool: PowerUp[] = [];
    private config: PoolConfig;

    constructor(config: PoolConfig = DEFAULT_POOL_CONFIG) {
        this.config = { ...config };
        this.initialize();
    }

    initialize() {
        this.pool = [];
        for (const powerup of POWERUP_TYPES) {
            const count = this.config[powerup.id] || 0;
            for (let i = 0; i < count; i++) {
                this.pool.push(powerup);
            }
        }
        // Shuffle pool
        for (let i = this.pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.pool[i], this.pool[j]] = [this.pool[j], this.pool[i]];
        }
    }

    draw(count: number): PowerUp[] {
        const drawn: PowerUp[] = [];
        for (let i = 0; i < count && this.pool.length > 0; i++) {
            const index = Math.floor(Math.random() * this.pool.length);
            drawn.push(this.pool[index]);
            // Don't remove yet - only remove when selected
        }
        return drawn;
    }

    remove(powerup: PowerUp) {
        const index = this.pool.findIndex(p => p.id === powerup.id);
        if (index !== -1) {
            this.pool.splice(index, 1);
        }
    }

    updateConfig(newConfig: PoolConfig) {
        this.config = { ...newConfig };
        this.initialize();
    }

    getRemaining(): number {
        return this.pool.length;
    }
}

// Global pool instance
let powerUpPool = new PowerUpPool();

// Stats Presets
const PLAYER_STATS: BeybladeStats = {
    maxRpm: 1000,
    atk: 10,
    def: 5,
    wt: 1.0,
    sta: 1,
    spd: 60,
    spl: 0,
    crt: 0.2,
    restitution: 0.1,
    friction: 0.2,
    frictionAir: FRICTION_LOW,
    densityBase: 0.05,
    // Arena Forces
    dishForce: DISH_LOW,  // Normal dish effect
    curlForce: CURL_LOW,  // Moderate curl
    // Visuals (Blue Theme)
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
    tipSize: 1.0
};

const ENEMY_STATS: BeybladeStats = {
    maxRpm: 1000,
    atk: 10,
    def: 5,
    wt: 1.0,
    sta: 1,
    spd: 60,
    spl: 0,
    crt: 0.2,
    restitution: 0.1,
    friction: 0.2,
    frictionAir: FRICTION_LOW,
    densityBase: 0.05,
    // Arena Forces
    dishForce: DISH_LOW,  // Normal dish effect
    curlForce: CURL_LOW,  // Moderate curl
    // Visuals (Orange Theme)
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
    tipSize: 1.0
};

const DEFAULT_PLAYER_STATS = { ...PLAYER_STATS };
const DEFAULT_ENEMY_STATS = { ...ENEMY_STATS };

function savePresets() {
    console.log("Saving presets", PLAYER_STATS, ENEMY_STATS);
    localStorage.setItem('bblade_player_stats', JSON.stringify(PLAYER_STATS));
    localStorage.setItem('bblade_enemy_stats', JSON.stringify(ENEMY_STATS));
    console.log('Presets Saved!');
}

function loadPresets() {
    const pData = localStorage.getItem('bblade_player_stats');
    const eData = localStorage.getItem('bblade_enemy_stats');
    if (pData) Object.assign(PLAYER_STATS, JSON.parse(pData));
    if (eData) Object.assign(ENEMY_STATS, JSON.parse(eData));
}

// Load on Startup
loadPresets();


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
    const trail = new TrailSystem(stats.ringColor, scene);

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

const poolBtn = document.createElement('button');
poolBtn.className = 'action-hud-btn';
poolBtn.innerText = 'POOL';
poolBtn.onclick = () => openPoolEditor();
actionHud.appendChild(poolBtn);

const resetHint = document.createElement('button');
resetHint.className = 'action-hud-btn';
resetHint.innerText = 'RESET';
resetHint.onclick = () => showResetDialog(true);
resetHint.style.display = 'none';
actionHud.appendChild(resetHint);

uiContainer.appendChild(actionHud);

// Presets Button Trigger Logic
setTimeout(() => {
    const p1Btn = document.getElementById('p1-btn');
    const cpuBtn = document.getElementById('cpu-btn');

    if (p1Btn) p1Btn.onclick = () => openPresetsModal(PLAYER_STATS, 'Player');
    if (cpuBtn) cpuBtn.onclick = () => openPresetsModal(ENEMY_STATS, 'CPU');
}, 0);

const PRESET_FIELDS = [
    { key: 'maxRpm', label: 'RPM', hint: 'Spin Speed', type: 'number', step: 10 },
    { key: 'spd', label: 'SPD', hint: 'Launch Vel.', type: 'number', step: 10 },
    { key: 'atk', label: 'ATK', hint: 'Damage', type: 'number', step: 1 },
    { key: 'def', label: 'DEF', hint: 'Reduction', type: 'number', step: 1 },
    { key: 'wt', label: 'WT', hint: 'weight', type: 'number', step: 0.1 },
    { key: 'sta', label: 'STA', hint: '-RPM/s', type: 'number', step: 1 },
    { key: 'crt', label: 'CRT', hint: 'Crit %', type: 'number', step: 0.05 },
    { key: 'restitution', label: 'BOUNCE', hint: 'restitution', type: 'number', step: 0.2 },
    { key: 'friction', label: 'GRIP', hint: 'friction', type: 'number', step: 0.2 },
    { key: 'frictionAir', label: 'DRAG', hint: 'air friction', type: 'number', step: 0.001 },
    { key: 'dishForce', label: 'DISH', hint: 'radial', type: 'number', step: 0.1 },
    { key: 'curlForce', label: 'CURL', hint: 'tangential', type: 'number', step: 0.1 },
];

const VISUAL_FIELDS = [
    { key: 'beyScale', label: 'BEY SIZE', hint: 'Scale', type: 'number', step: 0.1 },
    { key: 'wheelColor', label: 'WHEEL COLOR', hint: 'Metal color', type: 'color' },
    { key: 'ringColor', label: 'RING COLOR', hint: 'Energy color', type: 'color' },
    { key: 'ringRadiusFactor', label: 'RING RADIUS', hint: 'Size factor', type: 'number', step: 0.05 },
    { key: 'ringSides', label: 'RING SIDES', hint: 'Shape sides', type: 'number', step: 1 },
    { key: 'boltColor', label: 'BOLT COLOR', hint: 'Face color', type: 'color' },
    { key: 'boltSides', label: 'BOLT SIDES', hint: 'Hex/Circle', type: 'number', step: 1 },
    { key: 'spinTrackColor', label: 'ST COLOR', hint: 'Track color', type: 'color' },
    { key: 'spinTrackSize', label: 'ST SIZE', hint: 'Track depth', type: 'number', step: 0.1 },
    { key: 'tipColor', label: 'TIP COLOR', hint: 'Base color', type: 'color' },
    { key: 'tipSize', label: 'TIP SIZE', hint: 'Radius', type: 'number', step: 0.1 },
];

function createInput(id: string, label: string, value: any, hint: string, type: string, step: number | string, onChange: (val: any) => void) {
    const div = document.createElement('div');
    div.className = 'stat-item';

    // Handle color values (hex num to #hex str)
    let displayValue = value;
    if (type === 'color') {
        displayValue = '#' + value.toString(16).padStart(6, '0');
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
// --- Preset Modal Preview System ---
// WebGL Renderer Pool (max 3 contexts to prevent exhaustion)
const rendererPool: THREE.WebGLRenderer[] = [];
const MAX_RENDERERS = 3;

function getOrCreateRenderer(): THREE.WebGLRenderer {
    // Try to reuse an existing renderer
    if (rendererPool.length > 0) {
        return rendererPool.pop()!;
    }

    // Create new renderer if under limit
    if (rendererPool.length < MAX_RENDERERS) {
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(window.devicePixelRatio);
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

function openPresetsModal(targetStats: BeybladeStats, targetName: string) {
    let previewControls: OrbitControls | null = null;
    // Create a working copy of stats so we don't apply immediately
    const tempStats = { ...targetStats };

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const content = document.createElement('div');
    content.className = 'modal-content';

    const header = document.createElement('div');
    header.className = 'modal-header';
    header.innerHTML = `<span class="modal-title">Customise ${targetName} Beyblade</span>`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close';
    closeBtn.innerText = '×';
    closeBtn.onclick = () => {
        uiContainer.removeChild(overlay);
        if (previewRenderer) {
            returnRenderer(previewRenderer); // Return to pool
            previewRenderer = null;
        }
        if (previewControls) {
            previewControls.dispose();
            previewControls = null;
        }
    };
    header.appendChild(closeBtn);
    content.appendChild(header);

    // --- Visual Forge Section (Compact & Wrapped) ---
    const vSection = document.createElement('div');
    vSection.className = 'stat-section';
    vSection.innerHTML = `<div class="section-title">Visual Forge</div>`;

    const vContainer = document.createElement('div');
    vContainer.className = 'forge-container';
    vSection.appendChild(vContainer);

    // 1. Preview (Floated Left)
    const previewContainer = document.createElement('div');
    previewContainer.className = 'preview-float';
    vContainer.appendChild(previewContainer);

    VISUAL_FIELDS.forEach(field => {
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
        div.className = 'stat-item'; // Override class for compact flow
        vContainer.appendChild(div);
    });
    content.appendChild(vSection);

    // Setup Preview Scene
    setTimeout(() => {
        const width = previewContainer.clientWidth;
        const height = previewContainer.clientHeight;

        // Get renderer from pool instead of creating new one
        previewRenderer = getOrCreateRenderer();
        previewRenderer.setSize(width, height);
        previewRenderer.setClearColor(0x000000, 0);
        previewContainer.appendChild(previewRenderer.domElement);

        previewScene = new THREE.Scene();
        previewCamera = new THREE.PerspectiveCamera(50, width / height, 1, 1000);
        previewCamera.position.set(0, 40, 60);
        previewCamera.lookAt(0, 5, 0);

        // Orbit Controls for Preview
        previewControls = new OrbitControls(previewCamera, previewRenderer.domElement);

        // Lights
        const ambient = new THREE.AmbientLight(0xffffff, 2);
        previewScene.add(ambient);
        const dir = new THREE.DirectionalLight(0xffffff, 3);
        dir.position.set(10, 50, 20);
        previewScene.add(dir);

        updatePreview(tempStats);

        function animatePreview() {
            if (!previewRenderer) return;
            requestAnimationFrame(animatePreview);

            if (previewControls) previewControls.update();

            // No auto spin/wobble as requested
            // if (previewBeyblade) {
            //     previewBeyblade.spinGroup.rotation.y += 0.1;
            // }

            previewRenderer.render(previewScene!, previewCamera!);
        }
        animatePreview();
    }, 0);


    // --- Combat Stats Section (Bottom) ---
    const pSection = document.createElement('div');
    pSection.className = 'stat-section';
    pSection.innerHTML = `<div class="section-title">Combat Logic</div>`;
    const pGrid = document.createElement('div');
    pGrid.className = 'stat-grid';
    PRESET_FIELDS.forEach(field => {
        pGrid.appendChild(createInput(
            `p-${field.key}`,
            field.label,
            (targetStats as any)[field.key], // Use targetStats for initial display
            field.hint,
            field.type || 'number',
            field.step || 0.01,
            (val) => {
                (tempStats as any)[field.key] = val;
            }
        ));
    });
    pSection.appendChild(pGrid);
    content.appendChild(pSection);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'preset-actions';

    const resetBtn = document.createElement('button');
    resetBtn.className = 'action-btn reset';
    resetBtn.innerText = 'Reset Defaults';
    resetBtn.style.marginRight = 'auto';
    resetBtn.onclick = () => {
        showConfirmDialog(
            `Reset ${targetName} Beyblade?`,
            `This will remove all customizations and restore default stats for ${targetName}. This action will clear saved data from local storage.`,
            () => {
                // Confirmed - Reset specific target
                if (targetName === 'Player') Object.assign(PLAYER_STATS, DEFAULT_PLAYER_STATS);
                if (targetName === 'CPU') Object.assign(ENEMY_STATS, DEFAULT_ENEMY_STATS);


                savePresets(); // Persist the reset

                uiContainer.removeChild(overlay);
                if (previewRenderer) {
                    returnRenderer(previewRenderer); // Return to pool
                    previewRenderer = null;
                }
                resetMatch(); // Apply visual reset immediately
            }
        );
    };
    actions.appendChild(resetBtn);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'action-btn save';
    saveBtn.innerText = 'Save & Apply';
    saveBtn.onclick = () => {
        // Commit temp stats to actual target stats
        Object.assign(targetStats, tempStats);
        savePresets(); // Save everything
        uiContainer.removeChild(overlay);
        if (previewRenderer) {
            returnRenderer(previewRenderer); // Return to pool
            previewRenderer = null;
        }

        // Apply the updated stats by resetting entities with new stats
        // This ensures visuals (colors, scale) and physics are all updated
        if (!hasLaunched) {
            // Reset entities with updated PLAYER_STATS/ENEMY_STATS
            resetEntityVisualsAndPhysics(player, PLAYER_STATS, { x: 0, y: 100 });
            resetEntityVisualsAndPhysics(enemy, ENEMY_STATS, { x: 0, y: -100 });

            // Ensure bodies are in world
            Composite.remove(engine.world, player.body);
            Composite.remove(engine.world, enemy.body);
            Composite.add(engine.world, [player.body, enemy.body]);
        } else {
            // If match is running, reset with new stats
            resetMatch(false);
        }
    };
    actions.appendChild(saveBtn);
    content.appendChild(actions);

    // Close on overlay background click
    overlay.onclick = (e) => {
        if (e.target === overlay) {
            uiContainer.removeChild(overlay);
            if (previewRenderer) {
                returnRenderer(previewRenderer); // Return to pool
                previewRenderer = null;
            }
            if (previewControls) {
                previewControls.dispose();
                previewControls = null;
            }
        }
    };

    overlay.appendChild(content);
    uiContainer.appendChild(overlay);
}

// Pool Editor Modal
function openPoolEditor() {
    const tempConfig: PoolConfig = { ...powerUpPool['config'] };

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const content = document.createElement('div');
    content.className = 'modal-content';

    const header = document.createElement('div');
    header.className = 'modal-header';
    header.innerHTML = `<span class="modal-title">Power-Up Pool Editor</span>`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close';
    closeBtn.innerText = '×';
    closeBtn.onclick = () => {
        uiContainer.removeChild(overlay);
    };
    header.appendChild(closeBtn);
    content.appendChild(header);

    // Pool Config Section
    const poolSection = document.createElement('div');
    poolSection.className = 'stat-section';
    poolSection.innerHTML = `<div class="section-title">Configure Pool Counts</div>`;
    const poolGrid = document.createElement('div');
    poolGrid.className = 'stat-grid';

    POWERUP_TYPES.forEach(powerup => {
        const div = createInput(
            `pool-${powerup.id}`,
            powerup.label,
            tempConfig[powerup.id] || 0,
            powerup.detail,
            'number',
            1,
            (val) => {
                tempConfig[powerup.id] = Math.max(0, Math.floor(val));
            }
        );
        poolGrid.appendChild(div);
    });

    poolSection.appendChild(poolGrid);
    content.appendChild(poolSection);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'preset-actions';

    const goBtn = document.createElement('button');
    goBtn.className = 'action-btn save';
    goBtn.innerText = 'GO';
    goBtn.onclick = () => {
        powerUpPool.updateConfig(tempConfig);
        uiContainer.removeChild(overlay);
    };
    actions.appendChild(goBtn);
    content.appendChild(actions);

    overlay.onclick = (e) => {
        if (e.target === overlay) {
            uiContainer.removeChild(overlay);
        }
    };

    overlay.appendChild(content);
    uiContainer.appendChild(overlay);
}

// Custom Confirm Dialog
function showConfirmDialog(title: string, message: string, onConfirm: () => void) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.maxWidth = '400px';

    const header = document.createElement('div');
    header.className = 'modal-header';
    header.innerHTML = `<span class="modal-title">${title}</span>`;
    content.appendChild(header);

    const messageDiv = document.createElement('div');
    messageDiv.style.padding = '20px';
    messageDiv.style.lineHeight = '1.5';
    messageDiv.innerText = message;
    content.appendChild(messageDiv);

    const actions = document.createElement('div');
    actions.className = 'preset-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'action-btn';
    cancelBtn.innerText = 'Cancel';
    cancelBtn.onclick = () => {
        uiContainer.removeChild(overlay);
    };
    actions.appendChild(cancelBtn);

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'action-btn save';
    confirmBtn.innerText = 'Confirm Reset';
    confirmBtn.onclick = () => {
        uiContainer.removeChild(overlay);
        onConfirm();
    };
    actions.appendChild(confirmBtn);

    content.appendChild(actions);
    overlay.appendChild(content);
    uiContainer.appendChild(overlay);
}

// Power-Up Card Container
const powerupContainer = document.createElement('div');
powerupContainer.className = 'powerup-container';
powerupContainer.style.display = 'none';
uiContainer.appendChild(powerupContainer);

// Power-Up Timer State
interface PowerUpState {
    isActive: boolean;
    elapsedTime: number; // in ms
    playerChoice: { powerup: PowerUp, index: number } | null;
    enemyChoice: { powerup: PowerUp, index: number } | null;
    isRevealing: boolean;
    revealTime: number;
}

const POWERUP_DURATION = 5000; // 5 seconds to choose
const REVEAL_DURATION = 2000; // 2 seconds to show result

let powerUpState: PowerUpState = {
    isActive: false,
    elapsedTime: 0,
    playerChoice: null,
    enemyChoice: null,
    isRevealing: false,
    revealTime: 0
};

let currentPowerups: PowerUp[] = [];

function showPowerupCards() {
    if (!hasLaunched || gameOver) return;

    // Draw 3 cards from pool
    currentPowerups = powerUpPool.draw(3);

    if (currentPowerups.length === 0) {
        // Pool exhausted
        powerupContainer.style.display = 'none';
        return;
    }

    // Reset State
    powerUpState = {
        isActive: true,
        elapsedTime: 0,
        playerChoice: null,
        enemyChoice: null,
        isRevealing: false,
        revealTime: 0
    };

    // Clear container
    powerupContainer.innerHTML = '';

    // Create cards
    currentPowerups.forEach((powerup, index) => {
        const card = document.createElement('div');
        card.className = 'powerup-card';
        card.dataset.index = index.toString(); // For easy access
        card.innerHTML = `
            <div class="powerup-label">${powerup.label}</div>
            <div class="powerup-detail">${powerup.detail}</div>
            <div class="powerup-key">${index + 1}</div>
            <div class="choice-badge player-badge" style="display: none;">P1</div>
            <div class="choice-badge cpu-badge" style="display: none;">CPU</div>
        `;

        // Click handler
        card.onclick = () => selectPowerup(powerup, index);

        powerupContainer.appendChild(card);
    });

    powerupContainer.style.display = 'flex';
}

function selectPowerup(powerup: PowerUp, index: number) {
    if (!powerUpState.isActive || powerUpState.isRevealing || powerUpState.playerChoice) return;

    // Lock in Player Choice
    powerUpState.playerChoice = { powerup, index };

    // Highlight selected card visually
    const cards = powerupContainer.querySelectorAll('.powerup-card');
    cards[index].classList.add('selected');
}

function updatePowerUpLogic(dt: number) {
    if (!powerUpState.isActive) return;

    // 1. Selection Phase
    if (!powerUpState.isRevealing) {
        powerUpState.elapsedTime += dt;

        // Update Timer UI (Optional - maybe add a bar later)

        if (powerUpState.elapsedTime >= POWERUP_DURATION) {
            // Time's up! Transition to Reveal
            resolveChoicesAndReveal();
        }
    }
    // 2. Reveal Phase
    else {
        powerUpState.revealTime += dt;
        if (powerUpState.revealTime >= REVEAL_DURATION) {
            finishPowerUpCycle();
        }
    }
}

function resolveChoicesAndReveal() {
    powerUpState.isRevealing = true;

    // 1. Ensure Player Choice (Random if not made)
    if (!powerUpState.playerChoice) {
        // Pick random available
        const randomIdx = Math.floor(Math.random() * currentPowerups.length);
        powerUpState.playerChoice = { powerup: currentPowerups[randomIdx], index: randomIdx };
    }

    // 2. Ensure Enemy Choice (Random)
    if (!powerUpState.enemyChoice) {
        const randomIdx = Math.floor(Math.random() * currentPowerups.length);
        powerUpState.enemyChoice = { powerup: currentPowerups[randomIdx], index: randomIdx };
    }

    // 3. Update UI to show choices
    const cards = powerupContainer.querySelectorAll('.powerup-card');

    // Show P1 Badge
    const p1Card = cards[powerUpState.playerChoice.index] as HTMLElement;
    if (p1Card) {
        p1Card.classList.add('selected'); // Ensure highlighted
        const badge = p1Card.querySelector('.player-badge') as HTMLElement;
        if (badge) badge.style.display = 'block';
    }

    // Show CPU Badge
    const cpuCard = cards[powerUpState.enemyChoice.index] as HTMLElement;
    if (cpuCard) {
        // CPU might pick same as player, that's fine
        const badge = cpuCard.querySelector('.cpu-badge') as HTMLElement;
        if (badge) badge.style.display = 'block';
    }
}

function finishPowerUpCycle() {
    powerUpState.isActive = false;
    powerUpState.isRevealing = false;

    // Apply Effects
    if (powerUpState.playerChoice) {
        powerUpState.playerChoice.powerup.apply(player);
        powerUpPool.remove(powerUpState.playerChoice.powerup);
    }

    if (powerUpState.enemyChoice) {
        powerUpState.enemyChoice.powerup.apply(enemy);
        // Only remove if different from player selection
        if (!powerUpState.playerChoice || powerUpState.playerChoice.powerup.id !== powerUpState.enemyChoice.powerup.id) {
            powerUpPool.remove(powerUpState.enemyChoice.powerup);
        }
    }

    // Hide UI
    powerupContainer.style.display = 'none';

    // Start next cycle after a brief delay
    startPowerupTimer();
}

function startPowerupTimer() {
    // Just trigger show immediately, logic handles the rest
    setTimeout(showPowerupCards, 500);
}

function stopPowerupTimer() {
    powerUpState.isActive = false;
    powerupContainer.style.display = 'none';
}

// Keyboard shortcuts for power-up selection
window.addEventListener('keydown', (e) => {
    if (!hasLaunched || gameOver || currentPowerups.length === 0) return;

    const key = e.key;
    if (key === '1' && currentPowerups[0]) {
        selectPowerup(currentPowerups[0], 0);
    } else if (key === '2' && currentPowerups[1]) {
        selectPowerup(currentPowerups[1], 1);
    } else if (key === '3' && currentPowerups[2]) {
        selectPowerup(currentPowerups[2], 2);
    }
});

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

function playCollisionSound(intensity: number, isCrit: boolean) {
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
    const baseFreq = 200 * scale[pick];
    const ratios = [1, 1.5, 2.0, 2.5];

    ratios.forEach((ratio, index) => {
        const osc = audioCtx.createOscillator();
        const oscGain = audioCtx.createGain();

        osc.type = index % 2 == 0 ? 'square' : 'triangle';
        osc.frequency.setValueAtTime(baseFreq * ratio * (isCrit ? 2 : 1), t);

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
            const critA = Math.random() < entityA.stats.crt;
            const rawDmgA = critA ? entityA.stats.atk * 2 : entityA.stats.atk;
            const dmgA = Math.max(0, rawDmgA - entityB.stats.def);
            if (entityB.currentRpm !== undefined) {
                entityB.currentRpm = Math.max(0, entityB.currentRpm - dmgA);
            }

            // B hits A
            const critB = Math.random() < entityB.stats.crt;
            const rawDmgB = critB ? entityB.stats.atk * 2 : entityB.stats.atk;
            const dmgB = Math.max(0, rawDmgB - entityA.stats.def);
            if (entityA.currentRpm !== undefined) {
                entityA.currentRpm = Math.max(0, entityA.currentRpm - dmgB);
            }

            // Sparks - White by default, Attacker color on Crit
            const attacker = critA ? entityA : (critB ? entityB : null);
            const sparkColor = attacker ? attacker.stats!.ringColor : 0xffffff;
            const isCrit = critA || critB;
            const count = isCrit ? 15 : 5;
            const speed = isCrit ? 5 : 2;

            if (pair.collision.supports.length > 0) {
                const { x, y } = pair.collision.supports[0];
                for (let i = 0; i < count; i++) {
                    createSpark(x, y, sparkColor, speed);
                }
            }

            playCollisionSound(isCrit ? 0.5 : 0.25, isCrit);

        } else {
            // Fallback / Wall hits
            if (pair.collision.supports.length > 0) {
                const { x, y } = pair.collision.supports[0];
                for (let i = 0; i < 5; i++) {
                    createSpark(x, y, 0xaaaaaa, 2);
                }
            }
            playCollisionSound(0.1, false);
        }
    });
});


// --- Game Loop ---
const SUBSTEPS = 8;
let frameCounter = 0;
let lastTime = performance.now();

function animate() {
    requestAnimationFrame(animate);

    const currentTime = performance.now();
    const deltaTime = currentTime - lastTime;
    lastTime = currentTime;

    // Update Power-Up Logic
    updatePowerUpLogic(deltaTime);

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
                    // if (dist == 0) return;
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

    // Update action HUD buttons
    poolBtn.style.display = 'none';
    resetHint.style.display = 'block';

    // Start power-up timer
    startPowerupTimer();
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
        showResetDialog(false);
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
        entity.trail.mesh.material.color.setHex(stats.ringColor);
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

function resetMatch(keepPowerups: boolean = false) {
    hasLaunched = false;
    gameOver = false;

    // Update action HUD buttons
    poolBtn.style.display = 'block';
    resetHint.style.display = 'none';

    // Stop power-up timer and reset pool
    stopPowerupTimer();
    powerUpPool.initialize();

    // Clear Sparks
    sparks.forEach(s => scene.remove(s.mesh));
    sparks.length = 0;

    if (keepPowerups) {
        // Keep power-ups: Save current stats to localStorage and update PLAYER_STATS/ENEMY_STATS
        if (player.stats && enemy.stats) {
            // Update the global stats with current accumulated stats
            Object.assign(PLAYER_STATS, player.stats);
            Object.assign(ENEMY_STATS, enemy.stats);

            // Save to localStorage
            savePresets();

            // Reset entities with the new stats
            resetEntityVisualsAndPhysics(player, PLAYER_STATS, { x: 0, y: 100 });
            resetEntityVisualsAndPhysics(enemy, ENEMY_STATS, { x: 0, y: -100 });
        }
    } else {
        // Discard power-ups: Reset to match start stats (before power-ups were applied)
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

function showResetDialog(showCancel: boolean = true) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.maxWidth = '400px';

    const header = document.createElement('div');
    header.className = 'modal-header';
    header.innerHTML = `<span class="modal-title">Reset Match</span>`;
    content.appendChild(header);

    const messageDiv = document.createElement('div');
    messageDiv.style.padding = '20px';
    messageDiv.style.lineHeight = '1.5';
    messageDiv.innerText = 'Do you want to keep the power-ups applied?';
    content.appendChild(messageDiv);

    const actions = document.createElement('div');
    actions.className = 'preset-actions';
    actions.style.flexDirection = 'column';
    actions.style.gap = '10px';

    const keepBtn = document.createElement('button');
    keepBtn.className = 'action-btn save';
    keepBtn.innerText = 'Keep Power Ups';
    keepBtn.style.width = '100%';
    keepBtn.onclick = () => {
        uiContainer.removeChild(overlay);
        resetMatch(true);
    };
    actions.appendChild(keepBtn);

    const fullResetBtn = document.createElement('button');
    fullResetBtn.className = 'action-btn';
    fullResetBtn.innerText = 'Discard Power Ups';
    fullResetBtn.style.width = '100%';
    fullResetBtn.onclick = () => {
        uiContainer.removeChild(overlay);
        resetMatch(false);
    };
    actions.appendChild(fullResetBtn);

    // Only show Cancel button if showCancel is true
    if (showCancel) {
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'action-btn reset';
        cancelBtn.innerText = 'Cancel';
        cancelBtn.style.width = '100%';
        cancelBtn.onclick = () => {
            uiContainer.removeChild(overlay);
        };
        actions.appendChild(cancelBtn);
    }

    content.appendChild(actions);
    overlay.appendChild(content);
    uiContainer.appendChild(overlay);
}

// Reset Key
window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
        const overlay = document.querySelector('.winner-overlay');
        if (overlay && overlay.parentNode) {
            overlay.parentNode.removeChild(overlay);
        }
        if (hasLaunched) {
            showResetDialog(true);
        }
    }
});
