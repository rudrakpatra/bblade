import Matter from 'matter-js';
import Two from 'two.js';
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

// --- Rendering Setup (Two.js) ---
const two = new Two({
    fullscreen: true,
    autostart: true
}).appendTo(document.body);

// --- Game Constants ---
const ARENA_RADIUS = 300;
const BEYBLADE_RADIUS = 30;
const DISH_FORCE = 0.00002;

// --- Arena Creation ---
const screenCenter = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

// Helper to create circular wall
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
            label: 'Wall',
            render: { fillStyle: '#888' }
        });

        walls.push(wall);
    }
    return walls;
}

const walls = createCircularWall(screenCenter.x, screenCenter.y, ARENA_RADIUS, 32, 20);
Composite.add(engine.world, walls);


// --- Visuals for Arena ---
const arenaVisual = two.makeCircle(screenCenter.x, screenCenter.y, ARENA_RADIUS);
arenaVisual.fill = '#999';
arenaVisual.stroke = '#666';
arenaVisual.linewidth = 10;


// --- Scene Layers ---
const trailLayer = two.makeGroup();
const beybladeLayer = two.makeGroup();

// --- Beyblade Setup ---
interface GameEntity {
    body: Matter.Body;
    visual: any; // Two.Group
    trail: any; // Two.Path
}

const entities: GameEntity[] = [];


function createRotatingSmear(svg: any) {
    const group = two.makeGroup();
    const n = 5;
    for (let i = 0; i < n; i++) {
        const clone = svg.clone(group);
        clone.opacity = 1 / n + .5;
        clone.rotation = i * Math.PI / n;
    }
    return group;
}

function createBeybladeVisual(radius: number, color: string) {
    const group = two.makeGroup();
    const circle = two.makeCircle(0, 0, radius - 5 / 2);
    circle.fill = color;
    circle.stroke = '#444';
    circle.linewidth = 5;

    const blade = two.makePolygon(0, 0, radius + 4, 6);
    blade.fill = '#eee';
    blade.stroke = '#444';
    blade.linewidth = 2;

    // create blade ghosts
    const smearedBlade = createRotatingSmear(blade);

    const facebolt = two.makeCircle(0, 0, radius - 10);
    facebolt.fill = '#eee';
    facebolt.stroke = '#444';
    facebolt.linewidth = 2;

    group.add(smearedBlade, circle, facebolt);
    return group;
}

function createBeyblade(x: number, y: number, color: string): GameEntity {
    // Physics Body
    const body = Bodies.circle(x, y, BEYBLADE_RADIUS, {
        restitution: 0.9,
        friction: 0.02,
        frictionAir: 0.01,
        density: 0.05,
        label: 'Beyblade'
    });

    // Trail Visual (Behind main visual)
    const trail = two.makePath(null as any);
    trail.closed = false; // Open path
    trail.noFill();
    trail.stroke = color;
    trail.linewidth = 2;
    trail.cap = 'round';
    trail.join = 'round';

    // Add to trail layer
    trailLayer.add(trail);

    // Main Visual
    const visual = createBeybladeVisual(BEYBLADE_RADIUS, color);

    // Add to beyblade layer
    beybladeLayer.add(visual);

    // Initial Spawn
    Composite.add(engine.world, body);
    entities.push({ body, trail, visual, });

    return { body, visual, trail };
}

// Create Player and Enemy
const player = createBeyblade(screenCenter.x, screenCenter.y + 100, '#9966ff');
const enemy = createBeyblade(screenCenter.x, screenCenter.y - 100, '#ff6622');

// Enemy waits for match start (no initial spin/velocity here)


// --- Interaction State ---
let isDragging = false;
let hasLaunched = false; // "One time launch" flag

// Drag line visual
const dragLine = two.makeLine(0, 0, 0, 0);
dragLine.stroke = '#fff';
dragLine.linewidth = 3;
dragLine.visible = false;
dragLine.dashes = [5, 5]; // Dashed line for aiming

// --- UI Overlay ---
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
    visual: any; // Two.Line or Two.Circle
    velocity: { x: number, y: number };
    life: number;
}
const sparks: Spark[] = [];

function createSparks(x: number, y: number, count: number) {
    for (let i = 0; i < count; i++) {
        const visual = two.makeLine(0, 0, 5, 0); // Short line for spark
        visual.stroke = '#ffcc00';
        visual.linewidth = 3; // Thicker for better blur effect
        visual.translation.set(x, y);
        visual.rotation = Math.random() * Math.PI * 2;

        // Add CSS class for blur and blend mode
        if (visual.classList) {
            visual.classList.push('game-spark');
        }

        const speed = 2 + Math.random() * 5 * 2;

        const angle = Math.random() * Math.PI * 2;
        const velocity = {
            x: Math.cos(angle) * speed,
            y: Math.sin(angle) * speed
        };

        sparks.push({ visual, velocity, life: 1.0 });
    }
}

// --- Audio System ---
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

    // 1. Impact "Thud" (Low pass noise)
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

    // 2. Heavy Metal Clang (Additive with Dissonance)
    // Lower base frequency for "heavy" metal
    // play in scale
    const scale = [1, 3 / 2, 5 / 4, 7 / 4, 2];
    const pick = Math.floor(Math.random() * scale.length);
    const baseFreq = 200 * scale[pick];

    // Ratios for a bell/plate like metallic sound
    const ratios = [1, 1.5, 2.0, 2.5];

    ratios.forEach((ratio, index) => {
        const osc = audioCtx.createOscillator();
        const oscGain = audioCtx.createGain();

        // Square wave for the fundamental gives it a "hollow" metallic quality
        // Sawtooth for higher partials adds "bite"
        osc.type = index % 2 == 0 ? 'square' : 'triangle';
        osc.frequency.setValueAtTime(baseFreq * ratio, t);

        osc.connect(oscGain);
        oscGain.connect(masterGain);

        // Envelope
        // Hard attack
        oscGain.gain.setValueAtTime(0.0, t);
        oscGain.gain.linearRampToValueAtTime(0.6 / (index + 0.8), t + 0.002);

        // Decay - lower partials ring longer
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

        // Approximate collision point
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
// Use high substeps for accurate collision detection at high speeds
const SUBSTEPS = 8;
let frameCounter = 0;

two.bind('update', (_frameCount: number) => {
    // Physics loop with substepping
    // Fixed timestep of ~16.6ms divided by substeps
    const subStepDelta = (1000 / 60) / SUBSTEPS;

    for (let i = 0; i < SUBSTEPS; i++) {
        Engine.update(engine, subStepDelta);
        // Body.setAngularVelocity(player.body, 1.0); // Fixed high RPM
        // Body.setAngularVelocity(enemy.body, 1.0); // Fixed high RPM

        if (hasLaunched) {
            entities.forEach(entity => {
                const dx = screenCenter.x - entity.body.position.x;
                const dy = screenCenter.y - entity.body.position.y;
                const forceMagnitude = DISH_FORCE * entity.body.mass;
                Body.applyForce(entity.body, entity.body.position, {
                    x: dx * forceMagnitude,
                    y: dy * forceMagnitude
                });
            });
        }
    }

    // Update Sparks
    for (let i = sparks.length - 1; i >= 0; i--) {
        const spark = sparks[i];
        spark.visual.translation.x += spark.velocity.x;
        spark.visual.translation.y += spark.velocity.y;
        spark.life -= 0.05; // Fade out speed

        spark.visual.opacity = spark.life;

        if (spark.life <= 0) {
            two.remove(spark.visual); // Remove from scene
            // spark.visual.remove(); // Two.js way? two.remove(object)
            sparks.splice(i, 1);
        }
    }

    // Sync Visuals & Update Trails
    entities.forEach(entity => {
        // Sync main visual
        entity.visual.translation.set(entity.body.position.x, entity.body.position.y);
        entity.visual.rotation = entity.body.angle;

        // Update Trail
        // Add new point
        const anchor = new Two.Anchor(entity.body.position.x, entity.body.position.y);
        entity.trail.vertices.push(anchor);

        // Limit trail length
        if (entity.trail.vertices.length > 20) {
            entity.trail.vertices.shift();
        }
    });

    // Drag Line Update (if dragging)
    if (isDragging) {
        dragLine.vertices[0].set(player.body.position.x, player.body.position.y);
    }

    // Update UI (Throttle)
    frameCounter++;
    if (frameCounter % 10 === 0) {
        const playerRpm = Math.round(Math.abs(player.body.angularVelocity) * 100);
        const enemyRpm = Math.round(Math.abs(enemy.body.angularVelocity) * 100);

        if (playerRpmEl) playerRpmEl.innerText = playerRpm.toString();
        if (enemyRpmEl) enemyRpmEl.innerText = enemyRpm.toString();
    }
});

// --- Controls ---
document.addEventListener('mousedown', (e) => {
    if (hasLaunched) return; // Disable control after launch

    // Only drag if clicking near player
    const dist = Matter.Vector.magnitude(Matter.Vector.sub({ x: e.clientX, y: e.clientY }, player.body.position));
    if (dist < BEYBLADE_RADIUS * 2) {
        isDragging = true;

        dragLine.visible = true;
        dragLine.vertices[0].set(player.body.position.x, player.body.position.y);
        // Reset 2nd vertex
        dragLine.vertices[1].set(player.body.position.x, player.body.position.y);
    }
});

document.addEventListener('mousemove', (e) => {
    if (isDragging) {
        dragLine.vertices[0].set(player.body.position.x, player.body.position.y);

        // limit the line length
        const maxLineLength = 200;
        const dx = e.clientX - player.body.position.x;
        const dy = e.clientY - player.body.position.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > maxLineLength) {
            const angle = Math.atan2(dy, dx);
            dragLine.vertices[1].set(
                player.body.position.x + Math.cos(angle) * maxLineLength,
                player.body.position.y + Math.sin(angle) * maxLineLength
            );
        } else {
            dragLine.vertices[1].set(e.clientX, e.clientY);
        }
    }
});

document.addEventListener('mouseup', (e) => {
    if (isDragging) {
        isDragging = false;
        hasLaunched = true; // Mark as launched and start match
        dragLine.visible = false;

        const mouseX = e.clientX;
        const mouseY = e.clientY;

        // --- Player Launch ---
        // Launch logic: Direct Throw (Drag in target direction)
        let dx = mouseX - player.body.position.x;
        let dy = mouseY - player.body.position.y;

        // limit the interaction vector length for power calculation
        const maxSpeed = 300;
        const speed = Math.sqrt(dx * dx + dy * dy);

        let launchDx = dx;
        let launchDy = dy;

        if (speed > maxSpeed) {
            const scale = maxSpeed / speed;
            launchDx = dx * scale;
            launchDy = dy * scale;
        }

        // Apply force/velocity
        Body.setVelocity(player.body, { x: launchDx * 0.1, y: launchDy * 0.1 });
        Body.setAngularVelocity(player.body, 15.0); // Fixed high RPM

        // --- Start Enemy ---
        // Launch in random direction
        const randAngle = Math.random() * Math.PI * 2;
        const enemyMaxSpeed = maxSpeed;
        const randSpeedVal = 0.2 * enemyMaxSpeed + Math.random() * 0.8 * enemyMaxSpeed;

        const enemyVx = Math.cos(randAngle) * randSpeedVal;
        const enemyVy = Math.sin(randAngle) * randSpeedVal;

        Body.setVelocity(enemy.body, { x: enemyVx * 0.1, y: enemyVy * 0.1 });
        Body.setAngularVelocity(enemy.body, 15.0); // Fixed high RPM

        resetHint.style.opacity = '0';
    }
});

// --- Reset ---
window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
        window.location.reload();
    }
});
