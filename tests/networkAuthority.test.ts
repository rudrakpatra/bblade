import assert from 'node:assert/strict';
import test from 'node:test';
import {
    checksumSnapshot,
    DeterministicPhysics,
    RollbackPhysics,
    type BodyIndex,
    type DiveInput,
    type PhysicsBodyConfig,
    type PhysicsSnapshot
} from '../src/physics/deterministicPhysics.ts';
import {
    calculateLatencySample,
    summarizeLatency
} from '../src/netcode/latency.ts';

const bodyConfig: PhysicsBodyConfig = {
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

type DiveMessage = {
    type: 'dive';
    id: string;
    body: BodyIndex;
    diving: 0 | 1;
    gameTime: number;
};

type AuthorityMessage = {
    type: 'authority';
    snapshot: PhysicsSnapshot;
    checksum: string;
};

type NetworkMessage = DiveMessage | AuthorityMessage;
type PeerName = 'host' | 'guest';

class TestPeer {
    readonly world: DeterministicPhysics;
    readonly rollback: RollbackPhysics;
    private diveSequence = 0;
    private lastLocalDive: [0 | 1, 0 | 1] = [0, 0];

    constructor(initialSnapshot: PhysicsSnapshot) {
        this.world = new DeterministicPhysics(bodyConfig, bodyConfig);
        this.world.restore(initialSnapshot);
        this.rollback = new RollbackPhysics(this.world);
    }

    changeDive(body: BodyIndex, diving: 0 | 1, inputDelaySeconds: number): DiveMessage | null {
        if (this.lastLocalDive[body] === diving) return null;
        this.lastLocalDive[body] = diving;
        const message: DiveMessage = {
            type: 'dive',
            id: `body-${body}-${++this.diveSequence}`,
            body,
            diving,
            gameTime: this.world.gameTime + inputDelaySeconds
        };
        this.receive(message);
        return message;
    }

    receive(message: NetworkMessage) {
        if (message.type === 'dive') {
            const input: DiveInput = {
                id: message.id,
                body: message.body,
                diving: message.diving,
                gameTime: message.gameTime
            };
            return this.rollback.scheduleInput(input);
        }
        assert.equal(checksumSnapshot(message.snapshot), message.checksum);
        this.rollback.applyAuthoritativeSnapshot(message.snapshot);
        return undefined;
    }

    authorityMessage(): AuthorityMessage {
        const snapshot = this.world.snapshot();
        return {
            type: 'authority',
            snapshot,
            checksum: checksumSnapshot(snapshot)
        };
    }

    advanceTo(gameTime: number) {
        this.rollback.advanceTo(gameTime, false);
    }
}

type QueuedMessage = {
    sequence: number;
    deliverAt: number;
    target: PeerName;
    message: NetworkMessage;
};

class VirtualReliableNetwork {
    now = 0;
    private sequence = 0;
    private queue: QueuedMessage[] = [];
    private peers: Record<PeerName, TestPeer>;

    constructor(host: TestPeer, guest: TestPeer) {
        this.peers = { host, guest };
    }

    send(target: PeerName, message: NetworkMessage, delaySeconds: number) {
        this.queue.push({
            sequence: ++this.sequence,
            deliverAt: this.now + delaySeconds,
            target,
            message
        });
        this.queue.sort((left, right) => left.deliverAt - right.deliverAt || left.sequence - right.sequence);
    }

    advanceTo(gameTime: number) {
        while (this.queue.length && this.queue[0].deliverAt <= gameTime) {
            const next = this.queue.shift();
            if (!next) break;
            this.peers.host.advanceTo(next.deliverAt);
            this.peers.guest.advanceTo(next.deliverAt);
            this.now = next.deliverAt;
            this.peers[next.target].receive(next.message);
        }
        this.peers.host.advanceTo(gameTime);
        this.peers.guest.advanceTo(gameTime);
        this.now = gameTime;
    }
}

function initialSnapshot() {
    const world = new DeterministicPhysics(bodyConfig, bodyConfig);
    world.launchBody(0, 180);
    world.launchBody(1, 0);
    return world.snapshot();
}

function connectedPeers() {
    const snapshot = initialSnapshot();
    const host = new TestPeer(snapshot);
    const guest = new TestPeer(snapshot);
    return { host, guest, network: new VirtualReliableNetwork(host, guest) };
}

test('latency negotiation derives one-way delay and host clock offset', () => {
    const samples = Array.from({ length: 8 }, (_, index) => {
        const outboundMs = 46 + index % 3;
        const inboundMs = 52 - index % 2;
        const guestClockAheadMs = 1_250;
        const hostSentAt = index * 200;
        const guestReceivedAt = hostSentAt + outboundMs + guestClockAheadMs;
        const guestSentAt = guestReceivedAt + 2;
        const hostReceivedAt = hostSentAt + outboundMs + inboundMs + 2;
        return calculateLatencySample(hostSentAt, guestReceivedAt, guestSentAt, hostReceivedAt);
    });
    const summary = summarizeLatency(samples);
    assert.equal(summary.inputDelayMs, 49);
    assert.equal(summary.hostMinusGuestMs, -1247.75);
});

test('happy path applies a dive after the negotiated delay and stays synchronized', () => {
    const { host, guest, network } = connectedPeers();
    network.advanceTo(0.2);
    const message = host.changeDive(0, 1, 0.1);
    assert.ok(message);
    network.send('guest', message, 0.05);
    network.advanceTo(0.299);
    assert.equal(host.world.getDive(0), 0);
    assert.equal(guest.world.getDive(0), 0);
    network.advanceTo(0.3);
    assert.equal(host.world.getDive(0), 1);
    assert.equal(guest.world.getDive(0), 1);
    network.advanceTo(2);
    assert.deepEqual(guest.world.snapshot(), host.world.snapshot());
});

test('a late guest input makes the host roll back to the on-time result', () => {
    const snapshot = initialSnapshot();
    const baseline = new TestPeer(snapshot);
    const host = new TestPeer(snapshot);
    const guestInput: DiveMessage = {
        type: 'dive',
        id: 'guest-late-1',
        body: 1,
        diving: 1,
        gameTime: 0.375125
    };
    baseline.receive(guestInput);
    baseline.advanceTo(2);

    host.advanceTo(1.25);
    const result = host.receive(guestInput);
    assert.equal(result?.rolledBack, true);
    host.advanceTo(2);
    assert.deepEqual(host.world.snapshot(), baseline.world.snapshot());
});

test('an authoritative host snapshot repairs a divergent guest and replays newer inputs', () => {
    const { host, guest } = connectedPeers();
    const first: DiveMessage = {
        type: 'dive',
        id: 'host-1',
        body: 0,
        diving: 1,
        gameTime: 0.4
    };
    host.receive(first);
    guest.receive(first);
    host.advanceTo(1);
    guest.advanceTo(1);

    guest.world.setVelocity(0, 120, -80);
    guest.advanceTo(1.2);
    assert.notEqual(checksumSnapshot(guest.world.snapshot()), checksumSnapshot(host.world.snapshot()));

    const newer: DiveMessage = {
        type: 'dive',
        id: 'guest-newer',
        body: 1,
        diving: 1,
        gameTime: 1.1
    };
    guest.receive(newer);
    host.receive(newer);
    host.advanceTo(1.2);
    guest.receive(host.authorityMessage());
    assert.deepEqual(guest.world.snapshot(), host.world.snapshot());
});

test('duplicate dive packets are idempotent and unchanged input is not emitted', () => {
    const { host } = connectedPeers();
    host.advanceTo(0.1);
    const message = host.changeDive(0, 1, 0.05);
    assert.ok(message);
    assert.equal(host.changeDive(0, 1, 0.05), null);
    const duplicate = host.receive(message);
    assert.equal(duplicate?.accepted, false);
    host.advanceTo(1);

    const baseline = new TestPeer(initialSnapshot());
    baseline.receive(message);
    baseline.advanceTo(1);
    assert.deepEqual(host.world.snapshot(), baseline.world.snapshot());
});
