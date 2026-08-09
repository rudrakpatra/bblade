import assert from 'node:assert/strict';
import test from 'node:test';
import {
    checksumSnapshot,
    DeterministicPhysics,
    RollbackPhysics,
    type PhysicsBodyConfig
} from '../src/physics/deterministicPhysics.ts';

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

function launchedWorld() {
    const world = new DeterministicPhysics(config, config);
    world.launchBody(0, 180);
    world.launchBody(1, 0);
    return world;
}

test('snapshot restore and replay is bit-for-bit deterministic', () => {
    const world = launchedWorld();
    const rollback = new RollbackPhysics(world);
    rollback.scheduleInput({ id: 'p-1', body: 0, diving: 1, gameTime: 0.1375 });
    rollback.scheduleInput({ id: 'p-2', body: 0, diving: 0, gameTime: 0.44125 });
    rollback.scheduleInput({ id: 'e-1', body: 1, diving: 1, gameTime: 0.28175 });
    const start = world.snapshot();
    rollback.advanceTo(2.75, false);
    const expected = world.snapshot();

    world.restore(start);
    const replay = new RollbackPhysics(world);
    rollback.getInputs().forEach((input) => replay.scheduleInput(input));
    replay.advanceTo(2.75, false);
    assert.deepEqual(world.snapshot(), expected);
    assert.equal(checksumSnapshot(world.snapshot()), checksumSnapshot(expected));
});

test('launch direction is deterministic and quantized at cardinal angles', () => {
    const world = new DeterministicPhysics(config, config);
    world.launchBody(0, 0);
    world.launchBody(1, 90);
    assert.ok(world.getBody(0).vx > 5.99);
    assert.ok(Math.abs(world.getBody(0).vy) < 0.001);
    assert.ok(world.getBody(1).vy > 5.99);
    assert.ok(Math.abs(world.getBody(1).vx) < 0.001);
});

test('a late fractional-time input rolls back to the correct result', () => {
    const onTimeWorld = launchedWorld();
    const onTime = new RollbackPhysics(onTimeWorld);
    onTime.scheduleInput({ id: 'late', body: 1, diving: 1, gameTime: 0.33337 });
    onTime.advanceTo(2.25, false);

    const lateWorld = launchedWorld();
    const late = new RollbackPhysics(lateWorld);
    late.advanceTo(1.5, false);
    const result = late.scheduleInput({ id: 'late', body: 1, diving: 1, gameTime: 0.33337 });
    assert.equal(result.rolledBack, true);
    late.advanceTo(2.25, false);
    assert.deepEqual(lateWorld.snapshot(), onTimeWorld.snapshot());
});

test('a scheduled dive does not apply before its fractional game time', () => {
    const world = launchedWorld();
    const rollback = new RollbackPhysics(world);
    rollback.scheduleInput({ id: 'future', body: 0, diving: 1, gameTime: 0.12525 });
    rollback.advanceTo(0.125);
    assert.equal(world.getDive(0), 0);
    rollback.advanceTo(0.12525);
    assert.equal(world.getDive(0), 1);
});

test('swept collision catches blades crossing within one step', () => {
    const world = new DeterministicPhysics(config, config);
    world.setPosition(0, -40, 0);
    world.setPosition(1, 40, 0);
    world.setVelocity(0, 80, 0);
    world.setVelocity(1, -80, 0);
    world.setRpm(0, 1000);
    world.setRpm(1, 1000);
    const events = world.stepTicks(2_000);
    assert.ok(events.some((event) => event.kind === 'blade'));
    assert.ok(world.getBody(0).vx < 80);
    assert.ok(world.getBody(1).vx > -80);
});

test('swept wall collision catches a blade crossing the arena boundary', () => {
    const world = new DeterministicPhysics(config, config);
    world.setPosition(0, 200, 0);
    world.setVelocity(0, 160, 0);
    world.setRpm(0, 1000);
    const events = world.stepTicks(2_000);
    assert.ok(events.some((event) => event.kind === 'wall' && event.body === 0));
    assert.ok(world.getBody(0).x < 260);
    assert.ok(world.getBody(0).vx < 0);
});

test('an active blade pair emits one hit until Matter-style collisionEnd', () => {
    const contactConfig = {
        ...config,
        stamina: 0,
        orbitDrag: 0,
        diveDrag: 0,
        orbitDish: 0,
        diveDish: 0,
        orbitCurl: 0,
        diveCurl: 0
    };
    const world = new DeterministicPhysics(contactConfig, contactConfig);
    world.setPosition(0, -29, 0);
    world.setPosition(1, 29, 0);
    world.setRpm(0, 1000);
    world.setRpm(1, 1000);

    const firstContact = world.stepTicks(250);
    assert.equal(firstContact.filter((event) => event.kind === 'blade').length, 1);
    assert.equal(world.snapshot().touching, 1);

    for (let step = 0; step < 20; step += 1) {
        const activeContact = world.stepTicks(250);
        assert.equal(activeContact.filter((event) => event.kind === 'blade').length, 0);
        assert.equal(world.snapshot().touching, 1);
    }

    world.setPosition(0, -80, 0);
    world.setPosition(1, 80, 0);
    assert.equal(world.stepTicks(250).filter((event) => event.kind === 'blade').length, 0);
    assert.equal(world.snapshot().touching, 0);

    world.setPosition(0, -29, 0);
    world.setPosition(1, 29, 0);
    assert.equal(world.stepTicks(250).filter((event) => event.kind === 'blade').length, 1);
});

test('holding DIVE emits one collisionStart callback while the same impact settles', () => {
    const world = new DeterministicPhysics(config, config);
    world.launchBody(0, 270);
    world.launchBody(1, 90);
    world.setDive(0, 1);
    world.setDive(1, 1);

    const hitTimes: number[] = [];
    // The previous regression produced callbacks at 0.09375, 0.14375, and
    // 0.15 seconds. Count every callback so start/end/start flicker cannot hide
    // behind an assertion that only examines continuously-active frames.
    for (let step = 0; step < 96; step += 1) {
        const events = world.stepTicks(250);
        events.forEach((event) => {
            if (event.kind === 'blade') hitTimes.push(event.gameTime);
        });
    }

    assert.equal(hitTimes.length, 1, `expected one collisionStart, received hits at ${hitTimes.join(', ')}`);
    assert.equal(world.snapshot().touching, 1);
});
