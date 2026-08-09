import assert from 'node:assert/strict';
import test from 'node:test';
import {
    DeterministicPhysics,
    FIXED_STEP_TICKS,
    SIMULATION_TIME_HZ,
    type PhysicsBodyConfig
} from '../src/physics/deterministicPhysics.ts';

// Reference values in this file were captured from Matter.js 0.20.0 using the
// original bblade loop: four substeps per 60 Hz render frame, with forces
// applied after every Engine.update call.
const config: PhysicsBodyConfig = {
    maxRpm: 1000,
    attack: 10,
    defense: 5,
    stamina: 1,
    speed: 60,
    weight: 1,
    criticalAttack: 20,
    restitution: 0.1,
    orbitDrag: 0.02,
    diveDrag: 0.035,
    orbitDish: 1.5,
    diveDish: 6,
    orbitCurl: 140,
    diveCurl: 1.5
};

function advanceTo(world: DeterministicPhysics, gameTime: number) {
    const targetTicks = Math.round(gameTime * SIMULATION_TIME_HZ);
    while (world.timeTicks < targetTicks) {
        world.stepTicks(Math.min(FIXED_STEP_TICKS, targetTicks - world.timeTicks), false);
    }
}

function singleBey(diving: 0 | 1) {
    const world = new DeterministicPhysics(config, config);
    world.setActive(1, false);
    world.launchBody(0, 180);
    world.setDive(0, diving);
    return world;
}

function close(actual: number, expected: number, tolerance: number, label: string) {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `${label}: expected ${expected} ± ${tolerance}, received ${actual}`
    );
}

test('Normal-speed ORBIT trajectory matches the original Matter integration', () => {
    const world = singleBey(0);
    advanceTo(world, 0.5);
    const body = world.getBody(0);
    close(body.x, -41.88442, 0.08, 'x');
    close(body.y, -136.92865, 0.08, 'y');
    close(body.vx, 9.82288, 0.02, 'vx');
    close(body.vy, -4.43935, 0.02, 'vy');
});

test('Normal-speed DIVE trajectory matches the original Matter integration', () => {
    const world = singleBey(1);
    advanceTo(world, 0.5);
    const body = world.getBody(0);
    close(body.x, 15.6049, 0.15, 'x');
    close(body.y, 37.7417, 0.15, 'y');
    close(body.vx, -2.8358, 0.02, 'vx');
    close(body.vy, 8.50568, 0.03, 'vy');
});

test('Tutorial, Normal, and Insane wall-clock speeds retain the original pacing', () => {
    const references = [
        { multiplier: 0.25, x: -95.06974, y: 8.79106 },
        { multiplier: 0.5, x: -41.88442, y: -136.92865 },
        { multiplier: 0.75, x: 113.64277, y: -73.15481 }
    ];
    references.forEach((reference) => {
        const world = singleBey(0);
        advanceTo(world, reference.multiplier);
        const body = world.getBody(0);
        close(body.x, reference.x, 0.4, `x at ${reference.multiplier}`);
        close(body.y, reference.y, 0.4, `y at ${reference.multiplier}`);
    });
});

test('head-on blade restitution matches the original Matter contact response', () => {
    const collisionConfig = {
        ...config,
        stamina: 0,
        orbitDrag: 0,
        diveDrag: 0,
        orbitDish: 0,
        diveDish: 0,
        orbitCurl: 0,
        diveCurl: 0
    };
    const world = new DeterministicPhysics(collisionConfig, collisionConfig);
    world.setPosition(0, -40, 0);
    world.setPosition(1, 40, 0);
    world.setVelocity(0, 20, 0);
    world.setVelocity(1, -20, 0);
    world.setRpm(0, 1000);
    world.setRpm(1, 1000);
    advanceTo(world, 5 / 480);
    close(world.getBody(0).vx, -1.8398, 0.02, 'player collision vx');
    close(world.getBody(1).vx, 1.8398, 0.02, 'opponent collision vx');
});

test('moving two-bey collision timing and response track the original match', () => {
    const world = new DeterministicPhysics(config, config);
    world.launchBody(0, 270);
    world.launchBody(1, 90);
    let collisionTime: number | undefined;
    const targetTicks = Math.round(0.1604166667 * SIMULATION_TIME_HZ);
    while (world.timeTicks < targetTicks) {
        const events = world.stepTicks(
            Math.min(FIXED_STEP_TICKS, targetTicks - world.timeTicks),
            true
        );
        const collision = events.find((event) => event.kind === 'blade');
        if (collision?.kind === 'blade') collisionTime ??= collision.gameTime;
    }
    assert.ok(collisionTime !== undefined);
    close(collisionTime, 0.1604166667, 0.003, 'collision time');

    const player = world.getBody(0);
    close(player.x, -23.41052, 0.25, 'collision x');
    close(player.y, 18.48137, 0.25, 'collision y');
    close(player.vx, -7.42253, 0.15, 'collision vx');
    close(player.vy, -7.85082, 0.15, 'collision vy');
});
