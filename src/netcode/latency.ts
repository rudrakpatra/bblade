export type LatencySample = {
    roundTripMs: number;
    guestMinusHostMs: number;
};

export type LatencySummary = {
    oneWayMs: number;
    inputDelayMs: number;
    hostMinusGuestMs: number;
};

function median(values: number[]) {
    const sorted = [...values].sort((left, right) => left - right);
    if (!sorted.length) throw new Error('at least one latency sample is required');
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
}

export function calculateLatencySample(
    hostSentAt: number,
    guestReceivedAt: number,
    guestSentAt: number,
    hostReceivedAt: number
): LatencySample {
    const guestProcessingMs = Math.max(0, guestSentAt - guestReceivedAt);
    const roundTripMs = Math.max(0, (hostReceivedAt - hostSentAt) - guestProcessingMs);
    const guestMinusHostMs = (
        (guestReceivedAt - hostSentAt)
        + (guestSentAt - hostReceivedAt)
    ) / 2;
    return { roundTripMs, guestMinusHostMs };
}

export function summarizeLatency(samples: LatencySample[]): LatencySummary {
    const oneWayMs = median(samples.map((sample) => sample.roundTripMs / 2));
    const guestMinusHostMs = median(samples.map((sample) => sample.guestMinusHostMs));
    return {
        oneWayMs,
        inputDelayMs: Math.max(1, Math.ceil(oneWayMs)),
        hostMinusGuestMs: -guestMinusHostMs
    };
}
