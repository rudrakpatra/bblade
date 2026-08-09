export const FIXED_SCALE = 16_384;
export const SIMULATION_TIME_HZ = 120_000;
// Matter.js previously ran four substeps per 60 Hz frame in Normal mode:
// (1 / 60 * 0.5) / 4 = 1 / 480 simulation seconds.
export const FIXED_STEP_TICKS = 250;
const REFERENCE_STEP_TICKS = 2_000;
const TOI_SCALE = 1_000_000;
const MAX_COLLISIONS_PER_STEP = 8;
const ARENA_RADIUS = 300;
const DEFAULT_BODY_RADIUS = 30;
const WALL_THICKNESS = 20;
const CRITICAL_SPEED = 20;
const WALL_DAMAGE = 20;
// Matter.Body's default collision slop. The position solver deliberately
// leaves this much penetration so a resting contact stays the same active pair
// instead of flickering between collisionStart and collisionEnd.
const MATTER_CONTACT_SLOP = 819; // round(0.05 * FIXED_SCALE)
// Exact circles do not retain Matter's multi-point polygon contact manifold.
// Keep the pair alive across a very small solver gap so collisionStart cannot
// flicker while the same impact is still settling. A new hit is armed only
// after the bodies have clearly separated beyond this margin.
const CONTACT_END_GAP = 3 * FIXED_SCALE;
// Original force integration:
// 0.00002 * (1000 / 60)^2 = 1 / 180 normalized velocity per 60 Hz step.
const CENTER_FORCE_DENOMINATOR = 180;
const CURL_FORCE_DENOMINATOR = 180;
// Original DIVE_BOOST_FORCE (0.00012) integrated over a 60 Hz reference step.
const DIVE_BOOST_PER_REFERENCE = 546;
// Matter's iterative contact solver yielded about 92% of the configured
// restitution in isolated circle and wall impacts.
const MATTER_RESTITUTION_RESPONSE = 15_073;
const CORDIC_SCALE = 1_073_741_824;
const CORDIC_GAIN = 652_032_874;
const CORDIC_FULL_TURN = 1_073_741_824;
const CORDIC_QUARTER_TURN = CORDIC_FULL_TURN / 4;
const CORDIC_HALF_TURN = CORDIC_FULL_TURN / 2;
const CORDIC_ANGLES = [
    134_217_728, 79_233_351, 41_864_727, 21_251_189, 10_666_833,
    5_338_616, 2_669_960, 1_335_061, 667_541, 333_772, 166_886,
    83_443, 41_722, 20_861, 10_430, 5_215, 2_608, 1_304, 652, 326,
    163, 81, 41, 20, 10, 5, 3, 1, 1
] as const;

export type DiveState = 0 | 1;
export type BodyIndex = 0 | 1;

export type PhysicsBodyConfig = {
    maxRpm: number;
    attack: number;
    defense: number;
    stamina: number;
    speed: number;
    weight: number;
    criticalAttack: number;
    restitution: number;
    orbitDrag: number;
    diveDrag: number;
    orbitDish: number;
    diveDish: number;
    orbitCurl: number;
    diveCurl: number;
    dishModifier?: number;
    curlModifier?: number;
    radius?: number;
};

type FixedBodyConfig = {
    maxRpm: number;
    attack: number;
    defense: number;
    stamina: number;
    speed: number;
    mass: number;
    criticalAttack: number;
    restitution: number;
    orbitDrag: number;
    diveDrag: number;
    orbitDish: number;
    diveDish: number;
    orbitCurl: number;
    diveCurl: number;
    dishModifier: number;
    curlModifier: number;
    radius: number;
};

export type FixedBodyState = {
    x: number;
    y: number;
    vx: number;
    vy: number;
    angle: number;
    angularVelocity: number;
    rpm: number;
    pendingForceX: number;
    pendingForceY: number;
    active: 0 | 1;
};

export type PhysicsSnapshot = {
    version: 1;
    timeTicks: number;
    bodies: [FixedBodyState, FixedBodyState];
    dive: [DiveState, DiveState];
    touching: 0 | 1;
    wallTouching: [0 | 1, 0 | 1];
    criticalStreak: [number, number];
    criticalHits: [number, number];
    wallHits: [number, number];
};

export type HitReport = {
    attacker: BodyIndex;
    target: BodyIndex;
    critical: boolean;
    damage: number;
    rpmLost: number;
    streak: number;
};

export type PhysicsEvent =
    | {
        kind: 'blade';
        gameTime: number;
        x: number;
        y: number;
        reports: [HitReport, HitReport];
      }
    | {
        kind: 'wall';
        gameTime: number;
        body: BodyIndex;
        x: number;
        y: number;
        damage: number;
        rpmLost: number;
      };

export type DiveInput = {
    id: string;
    body: BodyIndex;
    diving: DiveState;
    gameTime: number;
};

export type ScheduledDiveInput = DiveInput & {
    timeTicks: number;
};

export type RollbackResult = {
    accepted: boolean;
    rolledBack: boolean;
};

function toFixed(value: number) {
    return Math.round(value * FIXED_SCALE);
}

function fromFixed(value: number) {
    return value / FIXED_SCALE;
}

function roundDiv(numerator: number, denominator: number) {
    if (denominator === 0) throw new Error('deterministic physics division by zero');
    if (numerator === 0) return 0;
    const sign = numerator < 0 !== denominator < 0 ? -1 : 1;
    return sign * Math.floor((Math.abs(numerator) + Math.floor(Math.abs(denominator) / 2)) / Math.abs(denominator));
}

function floorDiv(numerator: number, denominator: number) {
    return Math.floor(numerator / denominator);
}

function deterministicDirection(angleDegrees: number) {
    let degreeMilli = Math.round(angleDegrees * 1_000) % 360_000;
    if (degreeMilli < 0) degreeMilli += 360_000;
    let angle = roundDiv(degreeMilli * CORDIC_FULL_TURN, 360_000);
    if (angle >= CORDIC_HALF_TURN) angle -= CORDIC_FULL_TURN;
    let flip = false;
    if (angle > CORDIC_QUARTER_TURN) {
        angle -= CORDIC_HALF_TURN;
        flip = true;
    } else if (angle < -CORDIC_QUARTER_TURN) {
        angle += CORDIC_HALF_TURN;
        flip = true;
    }

    let x = CORDIC_GAIN;
    let y = 0;
    let remaining = angle;
    CORDIC_ANGLES.forEach((cordicAngle, index) => {
        const direction = remaining >= 0 ? 1 : -1;
        const shiftedX = x >> index;
        const shiftedY = y >> index;
        const nextX = x - direction * shiftedY;
        y += direction * shiftedX;
        x = nextX;
        remaining -= direction * cordicAngle;
    });
    return flip ? { x: -x, y: -y } : { x, y };
}

function clampSafeInteger(value: number) {
    if (!Number.isSafeInteger(value)) {
        throw new Error(`deterministic physics overflow: ${value}`);
    }
    return value;
}

function integerSqrt(value: number) {
    if (value <= 0) return 0;
    if (!Number.isSafeInteger(value)) {
        throw new Error(`integerSqrt requires a safe integer, received ${value}`);
    }
    let low = 1;
    let high = Math.min(value, 16_777_216);
    let result = 0;
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (middle <= Math.floor(value / middle)) {
            result = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    return result;
}

function bigintSqrt(value: bigint) {
    if (value < 0n) throw new Error('bigintSqrt requires a non-negative integer');
    if (value < 2n) return value;
    let x = 1n << BigInt(Math.ceil(value.toString(2).length / 2));
    let next = (x + value / x) >> 1n;
    while (next < x) {
        x = next;
        next = (x + value / x) >> 1n;
    }
    return x;
}

function cloneBody(body: FixedBodyState): FixedBodyState {
    return { ...body };
}

function cloneSnapshot(snapshot: PhysicsSnapshot): PhysicsSnapshot {
    return {
        version: 1,
        timeTicks: snapshot.timeTicks,
        bodies: [cloneBody(snapshot.bodies[0]), cloneBody(snapshot.bodies[1])],
        dive: [snapshot.dive[0], snapshot.dive[1]],
        touching: snapshot.touching,
        wallTouching: [snapshot.wallTouching[0], snapshot.wallTouching[1]],
        criticalStreak: [snapshot.criticalStreak[0], snapshot.criticalStreak[1]],
        criticalHits: [snapshot.criticalHits[0], snapshot.criticalHits[1]],
        wallHits: [snapshot.wallHits[0], snapshot.wallHits[1]]
    };
}

function normalizeConfig(config: PhysicsBodyConfig): FixedBodyConfig {
    return {
        maxRpm: toFixed(config.maxRpm),
        attack: toFixed(config.attack),
        defense: toFixed(config.defense),
        stamina: toFixed(config.stamina),
        speed: toFixed(config.speed),
        mass: toFixed(Math.max(0.05, config.weight)),
        criticalAttack: toFixed(config.criticalAttack),
        restitution: toFixed(config.restitution),
        orbitDrag: toFixed(config.orbitDrag),
        diveDrag: toFixed(config.diveDrag),
        orbitDish: toFixed(config.orbitDish),
        diveDish: toFixed(config.diveDish),
        orbitCurl: toFixed(config.orbitCurl),
        diveCurl: toFixed(config.diveCurl),
        dishModifier: toFixed(config.dishModifier ?? 1),
        curlModifier: toFixed(config.curlModifier ?? 1),
        radius: toFixed(config.radius ?? DEFAULT_BODY_RADIUS)
    };
}

function makeBody(x: number, y: number): FixedBodyState {
    return {
        x: toFixed(x),
        y: toFixed(y),
        vx: 0,
        vy: 0,
        angle: 0,
        angularVelocity: 0,
        rpm: 0,
        pendingForceX: 0,
        pendingForceY: 0,
        active: 1
    };
}

function bodySpeed(body: FixedBodyState) {
    return integerSqrt(clampSafeInteger(body.vx * body.vx + body.vy * body.vy));
}

function segmentCircleToi(
    px: number,
    py: number,
    dx: number,
    dy: number,
    radius: number,
    entering: boolean
): number | null {
    const pxBig = BigInt(px);
    const pyBig = BigInt(py);
    const dxBig = BigInt(dx);
    const dyBig = BigInt(dy);
    const radiusBig = BigInt(radius);
    const a = dxBig * dxBig + dyBig * dyBig;
    const b = 2n * (pxBig * dxBig + pyBig * dyBig);
    const c = pxBig * pxBig + pyBig * pyBig - radiusBig * radiusBig;

    if (a === 0n) {
        if (entering && c <= 0n) return 0;
        if (!entering && c >= 0n) return 0;
        return null;
    }

    // Matter's SAT detector reports an existing overlap regardless of whether
    // the bodies are approaching or separating. Direction only matters when
    // finding a future swept hit.
    if (entering && c <= 0n) return 0;
    if (!entering && c >= 0n) return 0;

    const discriminant = b * b - 4n * a * c;
    if (discriminant < 0n) return null;
    const root = bigintSqrt(discriminant);
    const numerator = entering ? -b - root : -b + root;
    const denominator = 2n * a;
    if (numerator < 0n || numerator > denominator) return null;
    return Number((numerator * BigInt(TOI_SCALE)) / denominator);
}

function fnvMix(hash: number, value: number) {
    let next = hash >>> 0;
    let remaining = BigInt(value);
    for (let index = 0; index < 8; index += 1) {
        next ^= Number(remaining & 255n);
        next = Math.imul(next, 16_777_619) >>> 0;
        remaining >>= 8n;
    }
    return next;
}

export function checksumSnapshot(snapshot: PhysicsSnapshot) {
    let hash = 2_166_136_261;
    hash = fnvMix(hash, snapshot.timeTicks);
    snapshot.bodies.forEach((body) => {
        hash = fnvMix(hash, body.x);
        hash = fnvMix(hash, body.y);
        hash = fnvMix(hash, body.vx);
        hash = fnvMix(hash, body.vy);
        hash = fnvMix(hash, body.angle);
        hash = fnvMix(hash, body.angularVelocity);
        hash = fnvMix(hash, body.rpm);
        hash = fnvMix(hash, body.pendingForceX);
        hash = fnvMix(hash, body.pendingForceY);
        hash = fnvMix(hash, body.active);
    });
    hash = fnvMix(hash, snapshot.dive[0]);
    hash = fnvMix(hash, snapshot.dive[1]);
    hash = fnvMix(hash, snapshot.touching);
    hash = fnvMix(hash, snapshot.wallTouching[0]);
    hash = fnvMix(hash, snapshot.wallTouching[1]);
    hash = fnvMix(hash, snapshot.criticalStreak[0]);
    hash = fnvMix(hash, snapshot.criticalStreak[1]);
    hash = fnvMix(hash, snapshot.criticalHits[0]);
    hash = fnvMix(hash, snapshot.criticalHits[1]);
    hash = fnvMix(hash, snapshot.wallHits[0]);
    hash = fnvMix(hash, snapshot.wallHits[1]);
    return hash.toString(16).padStart(8, '0');
}

export function secondsToSimulationTicks(seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`invalid game time: ${seconds}`);
    return Math.round(seconds * SIMULATION_TIME_HZ);
}

export function simulationTicksToSeconds(ticks: number) {
    return ticks / SIMULATION_TIME_HZ;
}

export class DeterministicPhysics {
    private configs: [FixedBodyConfig, FixedBodyConfig];
    private state: PhysicsSnapshot;

    constructor(player: PhysicsBodyConfig, opponent: PhysicsBodyConfig) {
        this.configs = [normalizeConfig(player), normalizeConfig(opponent)];
        this.state = {
            version: 1,
            timeTicks: 0,
            bodies: [makeBody(0, 100), makeBody(0, -100)],
            dive: [0, 0],
            touching: 0,
            wallTouching: [0, 0],
            criticalStreak: [0, 0],
            criticalHits: [0, 0],
            wallHits: [0, 0]
        };
    }

    get gameTime() {
        return simulationTicksToSeconds(this.state.timeTicks);
    }

    get timeTicks() {
        return this.state.timeTicks;
    }

    configureBody(index: BodyIndex, config: PhysicsBodyConfig) {
        this.configs[index] = normalizeConfig(config);
        this.state.bodies[index].rpm = Math.min(this.state.bodies[index].rpm, this.configs[index].maxRpm);
    }

    snapshot() {
        return cloneSnapshot(this.state);
    }

    restore(snapshot: PhysicsSnapshot) {
        if (snapshot.version !== 1) throw new Error(`unsupported physics snapshot version: ${snapshot.version}`);
        this.validateSnapshot(snapshot);
        this.state = cloneSnapshot(snapshot);
    }

    reset() {
        this.state = {
            version: 1,
            timeTicks: 0,
            bodies: [makeBody(0, 100), makeBody(0, -100)],
            dive: [0, 0],
            touching: 0,
            wallTouching: [0, 0],
            criticalStreak: [0, 0],
            criticalHits: [0, 0],
            wallHits: [0, 0]
        };
    }

    resetBody(index: BodyIndex, x: number, y: number) {
        this.state.bodies[index] = makeBody(x, y);
        this.state.touching = 0;
        this.state.wallTouching[index] = 0;
        this.state.criticalStreak[index] = 0;
        this.state.criticalHits[index] = 0;
        this.state.wallHits[index] = 0;
    }

    launchBody(index: BodyIndex, angleDegrees: number) {
        const body = this.state.bodies[index];
        const config = this.configs[index];
        const direction = deterministicDirection(angleDegrees);
        body.vx = roundDiv(direction.x * config.speed, CORDIC_SCALE * 10);
        body.vy = roundDiv(direction.y * config.speed, CORDIC_SCALE * 10);
        body.rpm = config.maxRpm;
        body.angularVelocity = roundDiv(body.rpm, 100);
        body.active = 1;
    }

    setDive(index: BodyIndex, diving: DiveState) {
        this.state.dive[index] = diving;
    }

    getDive(index: BodyIndex) {
        return this.state.dive[index];
    }

    setActive(index: BodyIndex, active: boolean) {
        this.state.bodies[index].active = active ? 1 : 0;
    }

    setPosition(index: BodyIndex, x: number, y: number) {
        const body = this.state.bodies[index];
        body.x = toFixed(x);
        body.y = toFixed(y);
    }

    setVelocity(index: BodyIndex, x: number, y: number) {
        const body = this.state.bodies[index];
        body.vx = toFixed(x);
        body.vy = toFixed(y);
    }

    setAngle(index: BodyIndex, angle: number) {
        this.state.bodies[index].angle = toFixed(angle);
    }

    setAngularVelocity(index: BodyIndex, angularVelocity: number) {
        this.state.bodies[index].angularVelocity = toFixed(angularVelocity);
    }

    setRpm(index: BodyIndex, rpm: number) {
        this.state.bodies[index].rpm = Math.max(0, Math.min(this.configs[index].maxRpm, toFixed(rpm)));
    }

    getBody(index: BodyIndex) {
        const body = this.state.bodies[index];
        return {
            x: fromFixed(body.x),
            y: fromFixed(body.y),
            vx: fromFixed(body.vx),
            vy: fromFixed(body.vy),
            speed: fromFixed(bodySpeed(body)),
            angle: fromFixed(body.angle),
            angularVelocity: fromFixed(body.angularVelocity),
            rpm: fromFixed(body.rpm),
            mass: fromFixed(this.configs[index].mass),
            active: body.active === 1
        };
    }

    stepTicks(durationTicks: number, emitEvents = true) {
        if (!Number.isInteger(durationTicks) || durationTicks < 0) {
            throw new Error(`stepTicks requires a non-negative integer, received ${durationTicks}`);
        }
        if (durationTicks === 0) return [] as PhysicsEvent[];
        const events: PhysicsEvent[] = [];
        this.applyPendingForcesAndDrag(durationTicks);
        this.moveWithContinuousCollisions(durationTicks, events, emitEvents);
        this.applyStaminaDecay(durationTicks);
        this.updateSpin(durationTicks);
        this.updatePendingForces();
        this.state.timeTicks += durationTicks;
        return events;
    }

    private validateSnapshot(snapshot: PhysicsSnapshot) {
        const integers = [
            snapshot.timeTicks,
            snapshot.touching,
            ...snapshot.wallTouching,
            ...snapshot.dive,
            ...snapshot.criticalStreak,
            ...snapshot.criticalHits,
            ...snapshot.wallHits,
            ...snapshot.bodies.flatMap((body) => [
                body.x,
                body.y,
                body.vx,
                body.vy,
                body.angle,
                body.angularVelocity,
                body.rpm,
                body.pendingForceX,
                body.pendingForceY,
                body.active
            ])
        ];
        if (integers.some((value) => !Number.isSafeInteger(value))) {
            throw new Error('physics snapshot contains a non-integer or unsafe value');
        }
    }

    private applyPendingForcesAndDrag(durationTicks: number) {
        ([0, 1] as BodyIndex[]).forEach((index) => {
            const body = this.state.bodies[index];
            if (!body.active || body.rpm <= 0) return;
            const config = this.configs[index];
            const diving = this.state.dive[index] === 1;
            const drag = diving ? config.diveDrag : config.orbitDrag;
            const dragForDuration = roundDiv(drag * durationTicks, REFERENCE_STEP_TICKS);
            const retained = Math.max(0, FIXED_SCALE - dragForDuration);
            body.vx = roundDiv(body.vx * retained, FIXED_SCALE)
                + roundDiv(body.pendingForceX * durationTicks, REFERENCE_STEP_TICKS);
            body.vy = roundDiv(body.vy * retained, FIXED_SCALE)
                + roundDiv(body.pendingForceY * durationTicks, REFERENCE_STEP_TICKS);
        });
    }

    private updatePendingForces() {
        ([0, 1] as BodyIndex[]).forEach((index) => {
            const body = this.state.bodies[index];
            if (!body.active || body.rpm <= 0) {
                body.pendingForceX = 0;
                body.pendingForceY = 0;
                return;
            }
            const config = this.configs[index];
            const distance = integerSqrt(clampSafeInteger(body.x * body.x + body.y * body.y));
            const safeDistance = Math.max(1, distance);
            const radialX = roundDiv(-body.x * FIXED_SCALE, safeDistance);
            const radialY = roundDiv(-body.y * FIXED_SCALE, safeDistance);
            const tangentX = radialY;
            const tangentY = -radialX;
            const diving = this.state.dive[index] === 1;
            const dish = diving ? config.diveDish : config.orbitDish;
            const curl = diving ? config.diveCurl : config.orbitCurl;
            const modifiedDish = roundDiv(dish * config.dishModifier, FIXED_SCALE);
            const modifiedCurl = roundDiv(curl * config.curlModifier, FIXED_SCALE);
            const centerAcceleration = roundDiv(
                distance * modifiedDish,
                FIXED_SCALE * CENTER_FORCE_DENOMINATOR
            );
            const arena = toFixed(ARENA_RADIUS);
            const remainingRadius = Math.max(0, arena - Math.min(arena, distance));
            const curlAcceleration = roundDiv(
                remainingRadius * modifiedCurl,
                arena * CURL_FORCE_DENOMINATOR
            );
            let accelerationX = roundDiv(
                radialX * centerAcceleration + tangentX * curlAcceleration,
                FIXED_SCALE
            );
            let accelerationY = roundDiv(
                radialY * centerAcceleration + tangentY * curlAcceleration,
                FIXED_SCALE
            );
            const speed = bodySpeed(body);
            if (diving && speed > 0) {
                accelerationX += roundDiv(body.vx * DIVE_BOOST_PER_REFERENCE, speed);
                accelerationY += roundDiv(body.vy * DIVE_BOOST_PER_REFERENCE, speed);
            }
            body.pendingForceX = accelerationX;
            body.pendingForceY = accelerationY;
        });
    }

    private displacement(body: FixedBodyState, durationTicks: number) {
        return {
            x: roundDiv(body.vx * durationTicks, REFERENCE_STEP_TICKS),
            y: roundDiv(body.vy * durationTicks, REFERENCE_STEP_TICKS)
        };
    }

    private moveWithContinuousCollisions(durationTicks: number, events: PhysicsEvent[], emitEvents: boolean) {
        let remainingTicks = durationTicks;
        let collisionIterations = 0;
        let bladePairConfirmed = false;
        let bladePairHandled = false;
        const wallPairsConfirmed: [boolean, boolean] = [false, false];
        const wallPairsHandled: [boolean, boolean] = [false, false];
        while (remainingTicks > 0 && collisionIterations < MAX_COLLISIONS_PER_STEP) {
            const movements = [
                this.displacement(this.state.bodies[0], remainingTicks),
                this.displacement(this.state.bodies[1], remainingTicks)
            ] as const;
            let earliestToi = TOI_SCALE + 1;
            let collision: { kind: 'blade' } | { kind: 'wall'; body: BodyIndex } | null = null;

            // Matter detects a body pair once, then runs solver iterations over
            // that pair. Do not turn solver iterations into repeated impacts.
            if (!bladePairHandled && this.state.bodies[0].active && this.state.bodies[1].active) {
                const relativeX = this.state.bodies[1].x - this.state.bodies[0].x;
                const relativeY = this.state.bodies[1].y - this.state.bodies[0].y;
                const relativeMoveX = movements[1].x - movements[0].x;
                const relativeMoveY = movements[1].y - movements[0].y;
                const collisionRadius = this.configs[0].radius + this.configs[1].radius;
                const toi = segmentCircleToi(
                    relativeX,
                    relativeY,
                    relativeMoveX,
                    relativeMoveY,
                    collisionRadius,
                    true
                );
                if (toi !== null && toi <= TOI_SCALE) {
                    earliestToi = toi;
                    collision = { kind: 'blade' };
                }
            }

            for (const index of [0, 1] as BodyIndex[]) {
                const body = this.state.bodies[index];
                if (!body.active || wallPairsHandled[index]) continue;
                const boundaryRadius = toFixed(ARENA_RADIUS - WALL_THICKNESS / 2) - this.configs[index].radius;
                const toi = segmentCircleToi(
                    body.x,
                    body.y,
                    movements[index].x,
                    movements[index].y,
                    boundaryRadius,
                    false
                );
                if (toi !== null && toi < earliestToi) {
                    earliestToi = toi;
                    collision = { kind: 'wall', body: index };
                }
            }

            if (!collision || earliestToi > TOI_SCALE) {
                this.moveBodies(movements[0].x, movements[0].y, movements[1].x, movements[1].y);
                remainingTicks = 0;
                break;
            }

            const elapsedTicks = Math.max(0, Math.min(
                remainingTicks,
                floorDiv(remainingTicks * earliestToi, TOI_SCALE)
            ));
            this.moveBodies(
                roundDiv(movements[0].x * earliestToi, TOI_SCALE),
                roundDiv(movements[0].y * earliestToi, TOI_SCALE),
                roundDiv(movements[1].x * earliestToi, TOI_SCALE),
                roundDiv(movements[1].y * earliestToi, TOI_SCALE)
            );
            const eventTicks = this.state.timeTicks + (durationTicks - remainingTicks) + elapsedTicks;
            if (collision.kind === 'blade') {
                bladePairConfirmed = true;
                bladePairHandled = true;
                this.resolveBladeCollision(eventTicks, events, emitEvents);
            } else {
                wallPairsConfirmed[collision.body] = true;
                wallPairsHandled[collision.body] = true;
                this.resolveWallCollision(collision.body, eventTicks, events, emitEvents);
            }
            const consumed = Math.max(1, elapsedTicks);
            remainingTicks = Math.max(0, remainingTicks - consumed);
            collisionIterations += 1;
        }

        if (remainingTicks > 0) {
            const first = this.displacement(this.state.bodies[0], remainingTicks);
            const second = this.displacement(this.state.bodies[1], remainingTicks);
            this.moveBodies(first.x, first.y, second.x, second.y);
        }
        this.separateOverlaps();
        // Equivalent to Matter.Pairs.update: a pair remains active when the
        // detector confirmed it this tick, otherwise it emits collisionEnd and
        // is removed. Only an inactive -> active transition can hit again.
        // Matter's polygon manifold naturally survives tiny gaps while its
        // iterative solver settles. Exact circles need an explicit exit margin
        // to prevent start/end/start callback flicker for one physical impact.
        if (!bladePairConfirmed && this.state.touching === 1) {
            const first = this.state.bodies[0];
            const second = this.state.bodies[1];
            if (first.active && second.active) {
                const dx = second.x - first.x;
                const dy = second.y - first.y;
                const contactEndDistance = this.configs[0].radius
                    + this.configs[1].radius
                    + CONTACT_END_GAP;
                bladePairConfirmed = BigInt(dx) * BigInt(dx) + BigInt(dy) * BigInt(dy)
                    <= BigInt(contactEndDistance) * BigInt(contactEndDistance);
            }
        }
        for (const index of [0, 1] as BodyIndex[]) {
            if (wallPairsConfirmed[index] || this.state.wallTouching[index] === 0) continue;
            const body = this.state.bodies[index];
            const contactEndRadius = toFixed(ARENA_RADIUS - WALL_THICKNESS / 2)
                - this.configs[index].radius
                - CONTACT_END_GAP;
            wallPairsConfirmed[index] = body.active === 1
                && BigInt(body.x) * BigInt(body.x) + BigInt(body.y) * BigInt(body.y)
                    >= BigInt(contactEndRadius) * BigInt(contactEndRadius);
        }
        if (!bladePairConfirmed) this.state.touching = 0;
        if (!wallPairsConfirmed[0]) this.state.wallTouching[0] = 0;
        if (!wallPairsConfirmed[1]) this.state.wallTouching[1] = 0;
    }

    private moveBodies(dx0: number, dy0: number, dx1: number, dy1: number) {
        if (this.state.bodies[0].active) {
            this.state.bodies[0].x += dx0;
            this.state.bodies[0].y += dy0;
        }
        if (this.state.bodies[1].active) {
            this.state.bodies[1].x += dx1;
            this.state.bodies[1].y += dy1;
        }
    }

    private resolveBladeCollision(eventTicks: number, events: PhysicsEvent[], emitEvents: boolean) {
        const first = this.state.bodies[0];
        const second = this.state.bodies[1];
        const dx = second.x - first.x;
        const dy = second.y - first.y;
        const distance = Math.max(1, integerSqrt(clampSafeInteger(dx * dx + dy * dy)));
        const normalX = roundDiv(dx * FIXED_SCALE, distance);
        const normalY = roundDiv(dy * FIXED_SCALE, distance);
        const relativeNormalVelocity = roundDiv(
            (second.vx - first.vx) * normalX + (second.vy - first.vy) * normalY,
            FIXED_SCALE
        );
        if (relativeNormalVelocity < 0) {
            const restitution = roundDiv(
                Math.max(this.configs[0].restitution, this.configs[1].restitution)
                    * MATTER_RESTITUTION_RESPONSE,
                FIXED_SCALE
            );
            const response = roundDiv(relativeNormalVelocity * (FIXED_SCALE + restitution), FIXED_SCALE);
            const totalMass = this.configs[0].mass + this.configs[1].mass;
            const firstDelta = roundDiv(response * this.configs[1].mass, totalMass);
            const secondDelta = roundDiv(-response * this.configs[0].mass, totalMass);
            first.vx += roundDiv(firstDelta * normalX, FIXED_SCALE);
            first.vy += roundDiv(firstDelta * normalY, FIXED_SCALE);
            second.vx += roundDiv(secondDelta * normalX, FIXED_SCALE);
            second.vy += roundDiv(secondDelta * normalY, FIXED_SCALE);
        }

        const isNewContact = this.state.touching === 0;
        this.state.touching = 1;
        this.nudgeBladesApart(normalX, normalY);
        if (isNewContact) {
            const firstReport = this.applyBladeDamage(0, 1);
            const secondReport = this.applyBladeDamage(1, 0);
            if (!emitEvents) return;
            events.push({
                kind: 'blade',
                gameTime: simulationTicksToSeconds(eventTicks),
                x: fromFixed(roundDiv(first.x + second.x, 2)),
                y: fromFixed(roundDiv(first.y + second.y, 2)),
                reports: [firstReport, secondReport]
            });
        }
    }

    private applyBladeDamage(attacker: BodyIndex, target: BodyIndex): HitReport {
        const attackerBody = this.state.bodies[attacker];
        const targetBody = this.state.bodies[target];
        const attackerConfig = this.configs[attacker];
        const targetConfig = this.configs[target];
        const critical = bodySpeed(attackerBody) > toFixed(CRITICAL_SPEED);
        if (critical) this.state.criticalStreak[attacker] += 1;
        else this.state.criticalStreak[attacker] = 0;
        if (critical) this.state.criticalHits[attacker] += 1;
        const streak = this.state.criticalStreak[attacker];
        const rawDamage = critical ? attackerConfig.criticalAttack : attackerConfig.attack;
        let damage = Math.max(0, rawDamage - targetConfig.defense);
        if (critical && streak > 0 && attackerConfig.attack > 0) {
            const multiplier = roundDiv(attackerConfig.criticalAttack * FIXED_SCALE, attackerConfig.attack);
            for (let count = 0; count < streak; count += 1) {
                damage = roundDiv(damage * multiplier, FIXED_SCALE);
            }
        }
        const before = targetBody.rpm;
        targetBody.rpm = Math.max(0, targetBody.rpm - damage);
        return {
            attacker,
            target,
            critical,
            damage: fromFixed(damage),
            rpmLost: fromFixed(before - targetBody.rpm),
            streak
        };
    }

    private nudgeBladesApart(normalX: number, normalY: number) {
        const first = this.state.bodies[0];
        const second = this.state.bodies[1];
        const targetDistance = this.configs[0].radius + this.configs[1].radius - MATTER_CONTACT_SLOP;
        const dx = second.x - first.x;
        const dy = second.y - first.y;
        const distance = Math.max(1, integerSqrt(clampSafeInteger(dx * dx + dy * dy)));
        const overlap = Math.max(0, targetDistance - distance);
        const half = Math.ceil(overlap / 2);
        first.x -= roundDiv(normalX * half, FIXED_SCALE);
        first.y -= roundDiv(normalY * half, FIXED_SCALE);
        second.x += roundDiv(normalX * half, FIXED_SCALE);
        second.y += roundDiv(normalY * half, FIXED_SCALE);
    }

    private resolveWallCollision(index: BodyIndex, eventTicks: number, events: PhysicsEvent[], emitEvents: boolean) {
        const body = this.state.bodies[index];
        const distance = Math.max(1, integerSqrt(clampSafeInteger(body.x * body.x + body.y * body.y)));
        const normalX = roundDiv(body.x * FIXED_SCALE, distance);
        const normalY = roundDiv(body.y * FIXED_SCALE, distance);
        const outwardVelocity = roundDiv(body.vx * normalX + body.vy * normalY, FIXED_SCALE);
        if (outwardVelocity > 0) {
            const effectiveRestitution = roundDiv(
                this.configs[index].restitution * MATTER_RESTITUTION_RESPONSE,
                FIXED_SCALE
            );
            const response = roundDiv(
                outwardVelocity * (FIXED_SCALE + effectiveRestitution),
                FIXED_SCALE
            );
            body.vx -= roundDiv(response * normalX, FIXED_SCALE);
            body.vy -= roundDiv(response * normalY, FIXED_SCALE);
        }
        // Like Matter's position solver, retain a tiny overlap with the wall;
        // the active pair then persists until the rebound actually separates.
        const boundaryRadius = toFixed(ARENA_RADIUS - WALL_THICKNESS / 2)
            - this.configs[index].radius
            + MATTER_CONTACT_SLOP;
        body.x = roundDiv(normalX * boundaryRadius, FIXED_SCALE);
        body.y = roundDiv(normalY * boundaryRadius, FIXED_SCALE);
        const isNewContact = this.state.wallTouching[index] === 0;
        this.state.wallTouching[index] = 1;
        if (isNewContact) {
            const damage = toFixed(WALL_DAMAGE);
            const before = body.rpm;
            body.rpm = Math.max(0, body.rpm - damage);
            this.state.criticalStreak[index] = 0;
            this.state.wallHits[index] += 1;
            if (!emitEvents) return;
            events.push({
                kind: 'wall',
                gameTime: simulationTicksToSeconds(eventTicks),
                body: index,
                x: fromFixed(body.x),
                y: fromFixed(body.y),
                damage: WALL_DAMAGE,
                rpmLost: fromFixed(before - body.rpm)
            });
        }
    }

    private separateOverlaps() {
        const first = this.state.bodies[0];
        const second = this.state.bodies[1];
        if (!first.active || !second.active) return;
        const dx = second.x - first.x;
        const dy = second.y - first.y;
        const distanceSquared = clampSafeInteger(dx * dx + dy * dy);
        const radius = this.configs[0].radius + this.configs[1].radius;
        if (distanceSquared >= radius * radius) return;
        const distance = Math.max(1, integerSqrt(distanceSquared));
        const normalX = roundDiv(dx * FIXED_SCALE, distance);
        const normalY = roundDiv(dy * FIXED_SCALE, distance);
        this.nudgeBladesApart(normalX, normalY);
    }

    private applyStaminaDecay(durationTicks: number) {
        ([0, 1] as BodyIndex[]).forEach((index) => {
            const body = this.state.bodies[index];
            if (!body.active || body.rpm <= 0) return;
            const decay = roundDiv(this.configs[index].stamina * durationTicks, SIMULATION_TIME_HZ);
            body.rpm = Math.max(0, body.rpm - decay);
        });
    }

    private updateSpin(durationTicks: number) {
        ([0, 1] as BodyIndex[]).forEach((index) => {
            const body = this.state.bodies[index];
            body.angularVelocity = roundDiv(body.rpm, 100);
            body.angle += roundDiv(body.angularVelocity * durationTicks, SIMULATION_TIME_HZ);
            const fullTurn = toFixed(Math.PI * 2);
            if (body.angle >= fullTurn || body.angle <= -fullTurn) body.angle %= fullTurn;
        });
    }
}

export class DeterministicBodyView {
    readonly index: BodyIndex;
    private world: DeterministicPhysics;
    frictionAir = 0;
    restitution = 0.1;
    friction = 0.2;
    density = 0.05;
    force = { x: 0, y: 0 };
    torque = 0;

    constructor(world: DeterministicPhysics, index: BodyIndex) {
        this.world = world;
        this.index = index;
    }

    get position() {
        const body = this.world.getBody(this.index);
        return { x: body.x, y: body.y };
    }

    get velocity() {
        const body = this.world.getBody(this.index);
        return { x: body.vx, y: body.vy };
    }

    get speed() {
        return this.world.getBody(this.index).speed;
    }

    get mass() {
        return this.world.getBody(this.index).mass;
    }

    get angle() {
        return this.world.getBody(this.index).angle;
    }

    get angularVelocity() {
        return this.world.getBody(this.index).angularVelocity;
    }

    setPosition(position: { x: number; y: number }) {
        this.world.setPosition(this.index, position.x, position.y);
    }

    setVelocity(velocity: { x: number; y: number }) {
        this.world.setVelocity(this.index, velocity.x, velocity.y);
    }

    setAngle(angle: number) {
        this.world.setAngle(this.index, angle);
    }

    setAngularVelocity(angularVelocity: number) {
        this.world.setAngularVelocity(this.index, angularVelocity);
    }

    setActive(active: boolean) {
        this.world.setActive(this.index, active);
    }
}

export class RollbackPhysics {
    readonly world: DeterministicPhysics;
    private inputs: ScheduledDiveInput[] = [];
    private inputIds = new Set<string>();
    private inputCursor = 0;
    private history: PhysicsSnapshot[] = [];
    private initialSnapshot: PhysicsSnapshot;
    private maxHistoryTicks: number;

    constructor(world: DeterministicPhysics, historySeconds = 10) {
        this.world = world;
        this.initialSnapshot = world.snapshot();
        this.history = [cloneSnapshot(this.initialSnapshot)];
        this.maxHistoryTicks = secondsToSimulationTicks(historySeconds);
    }

    resetHistory() {
        this.inputs = [];
        this.inputIds.clear();
        this.inputCursor = 0;
        this.initialSnapshot = this.world.snapshot();
        this.history = [cloneSnapshot(this.initialSnapshot)];
    }

    scheduleInput(input: DiveInput): RollbackResult {
        if (this.inputIds.has(input.id)) return { accepted: false, rolledBack: false };
        const scheduled: ScheduledDiveInput = {
            ...input,
            timeTicks: secondsToSimulationTicks(input.gameTime)
        };
        this.inputIds.add(input.id);
        this.inputs.push(scheduled);
        this.inputs.sort((left, right) => {
            const timeOrder = left.timeTicks - right.timeTicks;
            if (timeOrder !== 0) return timeOrder;
            if (left.id === right.id) return 0;
            return left.id < right.id ? -1 : 1;
        });
        const currentTicks = this.world.timeTicks;
        if (scheduled.timeTicks > currentTicks) {
            this.inputCursor = this.findInputCursor(currentTicks);
            return { accepted: true, rolledBack: false };
        }

        const snapshot = this.findRollbackSnapshot(scheduled.timeTicks);
        this.world.restore(snapshot);
        this.history = this.history.filter((entry) => entry.timeTicks <= snapshot.timeTicks);
        this.inputCursor = this.findInputCursor(snapshot.timeTicks);
        this.advanceToTicks(currentTicks, false);
        return { accepted: true, rolledBack: true };
    }

    advanceTo(gameTime: number, emitEvents = true) {
        return this.advanceToTicks(secondsToSimulationTicks(gameTime), emitEvents);
    }

    advanceToTicks(targetTicks: number, emitEvents = true) {
        if (targetTicks < this.world.timeTicks) {
            throw new Error(`cannot advance backwards from ${this.world.timeTicks} to ${targetTicks}`);
        }
        const events: PhysicsEvent[] = [];
        while (this.world.timeTicks < targetTicks) {
            this.applyInputsAtCurrentTime();
            const nextBoundary = (Math.floor(this.world.timeTicks / FIXED_STEP_TICKS) + 1) * FIXED_STEP_TICKS;
            const nextInputTicks = this.inputs[this.inputCursor]?.timeTicks ?? Number.POSITIVE_INFINITY;
            const nextTicks = Math.min(targetTicks, nextBoundary, nextInputTicks);
            if (nextTicks === this.world.timeTicks) {
                this.applyInputsAtCurrentTime();
                continue;
            }
            events.push(...this.world.stepTicks(nextTicks - this.world.timeTicks, emitEvents));
            this.applyInputsAtCurrentTime();
            if (this.world.timeTicks % FIXED_STEP_TICKS === 0) this.recordSnapshot();
        }
        this.applyInputsAtCurrentTime();
        return events;
    }

    applyAuthoritativeSnapshot(snapshot: PhysicsSnapshot) {
        const targetTicks = this.world.timeTicks;
        this.world.restore(snapshot);
        this.initialSnapshot = cloneSnapshot(snapshot);
        this.history = [cloneSnapshot(snapshot)];
        this.inputCursor = this.findInputCursor(snapshot.timeTicks);
        if (targetTicks > snapshot.timeTicks) this.advanceToTicks(targetTicks, false);
    }

    getInputs() {
        return this.inputs.map((input) => ({ ...input }));
    }

    private applyInputsAtCurrentTime() {
        while (
            this.inputCursor < this.inputs.length
            && this.inputs[this.inputCursor].timeTicks <= this.world.timeTicks
        ) {
            const input = this.inputs[this.inputCursor];
            this.world.setDive(input.body, input.diving);
            this.inputCursor += 1;
        }
    }

    private findInputCursor(timeTicks: number) {
        let cursor = 0;
        while (cursor < this.inputs.length && this.inputs[cursor].timeTicks <= timeTicks) cursor += 1;
        return cursor;
    }

    private findRollbackSnapshot(inputTicks: number) {
        let candidate = this.initialSnapshot;
        for (const snapshot of this.history) {
            if (snapshot.timeTicks >= inputTicks) break;
            candidate = snapshot;
        }
        return cloneSnapshot(candidate);
    }

    private recordSnapshot() {
        const snapshot = this.world.snapshot();
        const last = this.history[this.history.length - 1];
        if (!last || last.timeTicks !== snapshot.timeTicks) this.history.push(snapshot);
        const oldestAllowed = snapshot.timeTicks - this.maxHistoryTicks;
        while (this.history.length > 1 && this.history[1].timeTicks < oldestAllowed) {
            this.history.shift();
        }
    }
}
