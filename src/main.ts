import Matter from 'matter-js';
import * as THREE from 'three';
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

// Increase solver iterations for stability with high speed collisions
engine.positionIterations = 16;
engine.velocityIterations = 16;

// --- Rendering Setup (Three.js) ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x222222);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 2000);
// Position camera for a slanted top-down view
camera.position.set(0, 600, 400);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

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
const DISH_FORCE = 0.00002;

// Helper function for Bowl Shape
// y = (r / R)^2 * MaxH
const BOWL_MAX_HEIGHT = 100;
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
floor.receiveShadow = true;
arenaGroup.add(floor);


// Walls Visual (Ring at top)
const wallGeometry = new THREE.TorusGeometry(ARENA_RADIUS, 5, 16, 100);
const wallMaterial = new THREE.MeshBasicMaterial({ color: 0x666666 });
const wallMesh = new THREE.Mesh(wallGeometry, wallMaterial);
wallMesh.rotation.x = Math.PI / 2;
wallMesh.position.y = BOWL_MAX_HEIGHT;
wallMesh.castShadow = true;
wallMesh.receiveShadow = true;
arenaGroup.add(wallMesh);


// --- Beyblade Setup ---
interface GameEntity {
    body: Matter.Body;
    mesh: THREE.Group; // Main container
    tiltGroup: THREE.Group; // Inner container for tilt
    spinGroup: THREE.Group; // Innermost for spin
    trail: TrailSystem;
}

const entities: GameEntity[] = [];

// Helper to create Beyblade 3D Model
function createBeybladeMesh(color: number): { mesh: THREE.Group, tiltGroup: THREE.Group, spinGroup: THREE.Group } {
    const mesh = new THREE.Group();
    const tiltGroup = new THREE.Group();
    const spinGroup = new THREE.Group();

    mesh.add(tiltGroup);
    tiltGroup.add(spinGroup);

    // 1. Metal Wheel (Base) - Heavy, shiny
    const wheelGeo = new THREE.CylinderGeometry(BEYBLADE_RADIUS, BEYBLADE_RADIUS, 4, 32);
    const wheelMat = new THREE.MeshMatcapMaterial({
        color: 0x666666,
    });
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.position.y = 5;
    spinGroup.add(wheel);

    // 2. Clear Wheel / Energy Ring - Colored
    const ringGeo = new THREE.CylinderGeometry(BEYBLADE_RADIUS * .75, BEYBLADE_RADIUS * .75, 8, 32); // Octagonal for "blade" look
    const ringMat = new THREE.MeshMatcapMaterial({
        color: color,
    });

    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.y = 6;
    spinGroup.add(ring);

    // 3. Face Bolt - Top center
    const boltGeo = new THREE.CylinderGeometry(10, 10, 4, 6); // Hex
    const boltMat = new THREE.MeshMatcapMaterial({ color: 0xaaeeff });
    const bolt = new THREE.Mesh(boltGeo, boltMat);
    bolt.position.y = 12;
    spinGroup.add(bolt);

    const spinTrackGeo = new THREE.CylinderGeometry(BEYBLADE_RADIUS * .3, BEYBLADE_RADIUS * .2, 6, 10);
    const spinTrackMat = new THREE.MeshMatcapMaterial({
        color: 0x222222,
    });
    const spinTrack = new THREE.Mesh(spinTrackGeo, spinTrackMat);
    spinTrack.position.y = -2;
    spinGroup.add(spinTrack);

    // 4. Tip (Bottom) - Small cone
    const tipGeo = new THREE.CylinderGeometry(5, 2, 10);
    const tipMat = new THREE.MeshMatcapMaterial({ color: 0xaa4488 });
    const tip = new THREE.Mesh(tipGeo, tipMat);
    tip.position.y = -5;
    // Don't add to spin group to keep it stable? No, it spins.
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
}


function createBeyblade(x: number, y: number, color: number): GameEntity {
    // Physics Body
    const body = Bodies.circle(x, y, BEYBLADE_RADIUS, {
        restitution: 0.9,
        friction: 0.02,
        frictionAir: 0.01,
        density: 0.05,
        label: 'Beyblade'
    });

    // Visuals
    const { mesh, tiltGroup, spinGroup } = createBeybladeMesh(color);
    scene.add(mesh); // Add to scene

    // Trail
    const trail = new TrailSystem(color, scene);

    // Initial Spawn
    Composite.add(engine.world, body);
    entities.push({ body, mesh, tiltGroup, spinGroup, trail });

    return { body, mesh, tiltGroup, spinGroup, trail };
}

// Create Player and Enemy - Positioned relative to 0,0
const player = createBeyblade(0, 100, 0x9966ff);
const enemy = createBeyblade(0, -100, 0xff6622);

// --- Interaction State ---
let isDragging = false;
let hasLaunched = false;

// Drag line visual (Three.js Line)
const dragLineGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0)]);
const dragLineMaterial = new THREE.LineBasicMaterial({ color: 0xffffff });
const dragLine = new THREE.Line(dragLineGeometry, dragLineMaterial);
dragLine.frustumCulled = false;
dragLine.visible = false;
scene.add(dragLine);

// --- UI Overlay (HTML - Keep mostly same) ---
const uiContainer = document.createElement('div');
document.body.appendChild(uiContainer);

// Player HUD
const playerHud = document.createElement('div');
playerHud.className = 'hud hud-left';
playerHud.innerHTML = `
    <div class="bey-icon" style="background-color: #9966ff; box-shadow: 0 0 10px #9966ff; color: white;">P</div>
    <div>
        <span id="player-rpm" class="rpm-text">0</span>
        <span class="rpm-label">RPM</span>
    </div>
`;
uiContainer.appendChild(playerHud);

// Enemy HUD
const enemyHud = document.createElement('div');
enemyHud.className = 'hud hud-right';
enemyHud.innerHTML = `
    <div class="bey-icon" style="background-color: #ff6622; box-shadow: 0 0 10px #ff6622; color: white;">E</div>
    <div>
        <span id="enemy-rpm" class="rpm-text">0</span>
        <span class="rpm-label">RPM</span>
    </div>
`;
uiContainer.appendChild(enemyHud);

// Reset Hint
const resetHint = document.createElement('div');
resetHint.className = 'reset-hint';
resetHint.innerText = 'Drag to Launch | Press R to Reset';
uiContainer.appendChild(resetHint);

const playerRpmEl = document.getElementById('player-rpm')!;
const enemyRpmEl = document.getElementById('enemy-rpm')!;


// --- Spark System ---
const Events = Matter.Events;

interface Spark {
    mesh: THREE.Mesh;
    velocity: THREE.Vector3;
    life: number;
}
const sparks: Spark[] = [];
const sparkGeometry = new THREE.BoxGeometry(2, 2, 2);
const sparkMaterial = new THREE.MeshBasicMaterial({ color: 0xffcc00 });

function createSparks(x: number, y: number, count: number) {
    for (let i = 0; i < count; i++) {
        const mesh = new THREE.Mesh(sparkGeometry, sparkMaterial.clone());
        mesh.position.set(x, 5, y); // z is y in 2D physics mapping
        scene.add(mesh);

        const speed = 2 + Math.random() * 5 * 2;
        const angle = Math.random() * Math.PI * 2;
        // Spread in 3D? Mostly horizontal
        const velocity = new THREE.Vector3(
            Math.cos(angle) * speed,
            Math.random() * 5, // Some upward pop
            Math.sin(angle) * speed
        );

        sparks.push({ mesh, velocity, life: 1.0 });
    }
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

function playCollisionSound(intensity: number) {
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
    const pairs = event.pairs;
    for (let i = 0; i < pairs.length; i++) {
        const pair = pairs[i];

        // Approximate collision point (Matter coords)
        const supports = pair.collision.supports;
        let x = 0, y = 0;
        if (supports.length > 0) {
            x = supports[0].x;
            y = supports[0].y;
        } else {
            x = (pair.bodyA.position.x + pair.bodyB.position.x) / 2;
            y = (pair.bodyA.position.y + pair.bodyB.position.y) / 2;
        }

        createSparks(x, y, 8);
        playCollisionSound(0.5);
    }
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
                // Dish Effect: Push towards center (0,0)
                const dx = 0 - entity.body.position.x;
                const dy = 0 - entity.body.position.y;
                const forceMagnitude = DISH_FORCE * entity.body.mass;
                Body.applyForce(entity.body, entity.body.position, {
                    x: dx * forceMagnitude,
                    y: dy * forceMagnitude
                });
            });
        }
    }

    // Update Visuals
    entities.forEach(entity => {
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
        const playerRpm = Math.round(Math.abs(player.body.angularVelocity) * 100);
        const enemyRpm = Math.round(Math.abs(enemy.body.angularVelocity) * 100);

        if (playerRpmEl) playerRpmEl.innerText = playerRpm.toString();
        if (enemyRpmEl) enemyRpmEl.innerText = enemyRpm.toString();
    }

    renderer.render(scene, camera);
}
animate();


// --- Input Processing (Raycasting for 3D) ---
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // Ground plane

function getIntersectPoint(clientX: number, clientY: number): THREE.Vector3 | null {
    mouse.x = (clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(clientY / window.innerHeight) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const target = new THREE.Vector3();
    const intersection = raycaster.ray.intersectPlane(plane, target);
    return intersection;
}

document.addEventListener('mousedown', (e) => {
    if (hasLaunched) return;

    const point = getIntersectPoint(e.clientX, e.clientY);
    if (!point) return;

    // Check distance to player
    const dist = Math.sqrt(
        Math.pow(point.x - player.body.position.x, 2) +
        Math.pow(point.z - player.body.position.y, 2)
    );

    if (dist < BEYBLADE_RADIUS * 2) {
        isDragging = true;
        dragLine.visible = true;
    }
});

document.addEventListener('mousemove', (e) => {
    if (isDragging) {
        const point = getIntersectPoint(e.clientX, e.clientY);
        if (point) {
            const positions = dragLine.geometry.attributes.position.array as Float32Array;
            // Set Start (Player)
            const pHeight = getArenaHeight(player.body.position.x, player.body.position.y);
            positions[0] = player.body.position.x;
            positions[1] = pHeight + 5;
            positions[2] = player.body.position.y;

            // Set End (Mouse)
            // Limit line length
            const maxLen = 200;
            const dx = point.x - player.body.position.x;
            const dy = point.z - player.body.position.y; // Z is Y in physics
            const len = Math.sqrt(dx * dx + dy * dy);

            let targetX = point.x;
            let targetZ = point.z;

            if (len > maxLen) {
                const angle = Math.atan2(dy, dx);
                targetX = player.body.position.x + Math.cos(angle) * maxLen;
                targetZ = player.body.position.y + Math.sin(angle) * maxLen;
            }

            positions[3] = targetX;
            positions[4] = getArenaHeight(targetX, targetZ) + 5;
            positions[5] = targetZ;

            dragLine.geometry.attributes.position.needsUpdate = true;
        }
    }
});

document.addEventListener('mouseup', (e) => {
    if (isDragging) {
        isDragging = false;
        hasLaunched = true;
        dragLine.visible = false;
        resetHint.style.display = 'none';

        const point = getIntersectPoint(e.clientX, e.clientY);
        if (!point) return; // Should likely use last known valid point or just current mouse projection

        // Calculate launch vector
        // Drag logic: Pull BACK to shoot FORWARD? Or Drag TOWARDS target? 
        // Original was "Drag to launch" -> usually pull back like slingshot or drag in direction?
        // Code said: dx = mouseX - playerX. Body.setVelocity(dx * 0.1).
        // This means it shoots TOWARDS the mouse.

        // Re-read current mouse pos from drag line end if needed, better to use event
        let dx = point.x - player.body.position.x;
        let dy = point.z - player.body.position.y;

        const maxSpeed = 300;
        const speed = Math.sqrt(dx * dx + dy * dy);

        let launchDx = dx;
        let launchDy = dy;

        if (speed > maxSpeed) {
            const scale = maxSpeed / speed;
            launchDx = dx * scale;
            launchDy = dy * scale;
        }

        Body.setVelocity(player.body, { x: launchDx * 0.1, y: launchDy * 0.1 });
        Body.setAngularVelocity(player.body, 15.0);

        // enemy launch
        const randAngle = Math.random() * Math.PI * 2;
        const enemyMaxSpeed = maxSpeed;
        const randSpeedVal = 0.2 * enemyMaxSpeed + Math.random() * 0.8 * enemyMaxSpeed;

        const enemyVx = Math.cos(randAngle) * randSpeedVal;
        const enemyVy = Math.sin(randAngle) * randSpeedVal;

        Body.setVelocity(enemy.body, { x: enemyVx * 0.1, y: enemyVy * 0.1 });
        Body.setAngularVelocity(enemy.body, 15.0);
    }
});

// Window Resize Handling
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Reset
window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
        window.location.reload();
    }
});
