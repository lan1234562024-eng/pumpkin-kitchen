import type { CommandReceipt, GameSnapshot, SeatId } from '../shared/contracts';
interface Context {
    snapshot?: GameSnapshot;
    connected: boolean;
    seat_id: SeatId;
}
/** Semantic moves wait for confirmed cancellation; keyboard direction replaces movement atomically in the room. */
export function createMovementGate(options: {
    getContext(): Context;
    sendCancel(seat: SeatId): string | false;
}) {
    let pending: {
        id: string;
        seat: SeatId;
        round: number;
        generation: number;
        version: number;
        accepted: boolean;
        resume: () => void;
    } | undefined;
    const update = () => {
        if (!pending)
            return;
        const { snapshot: s, connected, seat_id } = options.getContext(), p = pending;
        if (!connected || !s || seat_id !== p.seat || s.phase !== 'playing' || s.round_id !== p.round || s.seats[p.seat].generation !== p.generation || s.seats[p.seat].controller !== 'human') {
            pending = undefined;
            return;
        }
        if (p.accepted && s.state_version > p.version && !s.seats[p.seat].active_action) {
            pending = undefined;
            p.resume();
        }
    };
    return { update, reset() { pending = undefined; }, request(seat: SeatId, resume: () => void, source: 'command' | 'keyboard' = 'command') {
            if (source === 'keyboard') {
                const { snapshot: s, connected, seat_id } = options.getContext();
                if (!connected || !s || seat !== seat_id || s.phase !== 'playing' || s.seats[seat].controller !== 'human') {
                    pending = undefined;
                    return;
                }
                if (s.seats[seat].active_action?.type !== 'chop') {
                    // Retire an older click before its late cancel receipt can resume it.
                    pending = undefined;
                    resume();
                    return;
                }
                // Cutting still needs the existing cancel barrier, with the newest intent.
                if (pending) pending.resume = resume;
            }
            update();
            const { snapshot: s, connected, seat_id } = options.getContext();
            if (!connected || !s || seat !== seat_id || s.phase !== 'playing' || s.seats[seat].controller !== 'human')
                return;
            if (pending) {
                pending.resume = resume;
                return;
            }
            if (!s.seats[seat].active_action) {
                resume();
                return;
            }
            const id = options.sendCancel(seat);
            if (id)
                pending = { id, seat, round: s.round_id, generation: s.seats[seat].generation, version: s.state_version, accepted: false, resume };
        }, receipt(receipt: CommandReceipt) { if (!pending || receipt.action_id !== pending.id)
            return; if (receipt.status === 'rejected')
            pending = undefined;
        else {
            pending.accepted = true;
            update();
        } } };
}

