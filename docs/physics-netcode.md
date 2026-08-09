# Deterministic physics and rollback netcode

## Simulation model

The game uses a purpose-built two-circle simulation in
`src/physics/deterministicPhysics.ts`. Matter.js is not part of the runtime.

- All authoritative positions, velocities, RPM values, angles, counters, dive
  states, and simulation times are integers.
- World values use fixed-point units with a scale of 16,384.
- Simulation time uses 120,000 integer ticks per second.
- The integration boundary is 480 Hz, matching the four Matter.js substeps
  used by the original Normal-speed 60 Hz game loop.
- A dive event may occur between boundaries. Its fractional `gameTime` is
  quantized to the simulation clock, the current step is split at that exact
  tick, and the input is applied before the remainder of the step.
- Circle-circle and circle-wall impacts use swept segment/circle intersection.
  The quadratic discriminant and square root use integer `bigint` operations,
  so a fast blade cannot tunnel through another blade or the wall.
- Contact pairs follow Matter.js's `Pairs.update` lifecycle. A geometric
  overlap activates a pair once, subsequent solver steps keep it active, and
  only a detector-confirmed separation ends it. Combat and wall damage are
  emitted only for the inactive-to-active (`collisionStart`) transition.
- Each body pair is resolved once per fixed step, with Matter-compatible
  restitution selection and collision slop. Holding DIVE therefore maintains
  a contact constraint instead of generating a new damage event every frame.
- Because the custom solver uses exact circles instead of Matter's polygon
  contact manifold, a small deterministic exit margin keeps the pair active
  while an impact settles. A new `collisionStart` is armed only after clear
  separation, eliminating numerical start/end/start callback flicker.

`DeterministicPhysics.snapshot()` returns the complete game-affecting state.
Restoring that snapshot and replaying the same inputs to the same game time
produces the same integer snapshot and checksum.

Rendering, particles, audio, and camera shake are deliberately excluded from
the snapshot because they cannot change a match result.

## Online authority

The host is the only authority:

1. Pressing **Online** immediately creates the host peer. Once PeerJS assigns
   its ID, the lobby enables a copy button for
   `domain/path?invite=<host-peer-id>`; the raw link is not displayed.
2. Opening an invite URL immediately creates a guest peer and connects to the
   supplied host ID as soon as the guest receives its own PeerJS ID.
3. On connection, the host performs eight timestamp exchanges.
4. The median one-way latency becomes `inputDelayMs`.
5. The same exchange estimates the guest-to-host monotonic-clock offset.
6. A match receives a future host start timestamp and an authoritative initial
   physics snapshot.
7. Both peers derive simulation time from the host clock.
8. Pressing or releasing DIVE sends one change event:

   ```ts
   {
     type: "dive",
     id: string,
     action: "dive_on" | "dive_off",
     gameTime: number
   }
   ```

9. `gameTime` is the current deterministic simulation time plus the negotiated
   input delay, converted through the selected game-speed multiplier.
10. An on-time event waits in the rollback controller until its simulation tick.
11. A late event restores the most recent snapshot strictly before the event,
   inserts the event, and replays to the prior present time.
12. The host periodically sends an authoritative snapshot and checksum. The
    guest restores it and replays any newer inputs; peers never average states.

PeerJS is only the reliable transport. No server-side simulation is required.

## Tests

Run:

```sh
npm test
```

The tests cover exact snapshot replay, late fractional input rollback, delayed
input application, swept collisions, active-contact hit suppression, held-DIVE
contacts, timestamp-based latency negotiation, happy-path host/guest
synchronization, late-packet host rollback, authoritative correction of a
divergent guest, and duplicate event idempotency.
