// fragment: exploration_executor (action)
// purpose: Signal-bus entry point for the `explore` job. A thin wrapper over exploration_api.seek()
//          (the Law 15 mover): read the planner's material-driven candidate biomes from HQ, call seek
//          to walk one step toward the best target, publish the chosen target to shared state, and
//          route to recursive_judge. The biome-choice + movement live in the API (Law 16); this
//          fragment only does the I/O the API does not — HQ writes (Law 6) and signal routing.
//
// MOVEMENT is seek()'s domain (goTo abandonment, Law 15): a hard emergency give-up never resolves, so
// the chair-write + route below simply don't run and the chain is discarded. We add no movement retry.
//
// Shared-state note: the target publishes to the 'biome_seeker' chair in exploration_confrence_room as
// the inspectable "biome being sought" record (Law 6). It is NOT a gate feed — find_buildingspot gates
// build centers on the ACCEPTABLE_BIOMES set directly (one settle-able set, Law 16), not on whatever
// this cycle happened to head toward. The chair remains for observability of exploration's intent.

const watcher = require('@kernel/watcher');
const hq      = require('@kernel/corporate_headquarters');
const exploration = require('@api/exploration_api');
const { routeToJudge } = require('@utils/signal_utils');

const TAG = 'exploration_executor';

module.exports = {
    receive: watcher.track(TAG, async function (signalType, payload) {
        if (signalType !== TAG) return;

        const bot = global.bot;
        if (!bot) throw new Error(`[${TAG}] CODING VIOLATION: global.bot not set.`);

        const refX = Math.floor(bot.entity.position.x);
        const refY = Math.floor(bot.entity.position.y);
        const refZ = Math.floor(bot.entity.position.z);

        const targetBiomes = hq.readConfRoomFlag('exploration_confrence_room', 'exploration_planner_target_biomes', {});
        const result = await exploration.seek(bot, { targetBiomes });

        // Hold-position cycle: nothing usable in biome_scanner (chunks not loaded, or the only
        // detected biome is the one we're in). Publish the hold and route a benign success.
        if (result.mode === 'none_detected') {
            hq.writeConfRoomFlag('exploration_confrence_room', 'biome_seeker', {
                meta:          { written_by: `${TAG}.js` },
                mode:          'none_detected',
                current_biome: result.current_biome,
                current_rank:  result.current_rank,
                target_biome:  null,
                scanned_at:    new Date().toISOString(),
            });
            watcher.summary(TAG, `Current biome '${result.current_biome}' (rank ${result.current_rank}) — no alternative biome detected near (${refX},${refY},${refZ}); holding position this cycle.`);
            return routeToJudge(TAG, {
                ...payload,
                success: true,
                readable: `${TAG}: none_detected`,
                biome_seeker: { mode: 'none_detected', current_biome: result.current_biome, current_rank: result.current_rank, success: true },
            });
        }

        // Moved toward a target biome (seek walked the bot; arrived_at is where it ended up).
        hq.writeConfRoomFlag('exploration_confrence_room', 'biome_seeker', {
            meta:            { written_by: `${TAG}.js` },
            mode:            result.mode,
            current_biome:   result.current_biome,
            current_rank:    result.current_rank,
            target_biome:    result.target_biome,
            target_position: result.target_position,
            target_distance: result.target_distance,
            for_item:        result.for_item,
            arrived_at:      result.arrived_at,
            scanned_at:      new Date().toISOString(),
        });

        const forItemText = result.for_item ? ` (for ${result.for_item})` : '';
        watcher.summary(TAG, `🏞️ [${result.mode}] heading toward '${result.target_biome}'${forItemText} — arrived near (${result.arrived_at?.x},${result.arrived_at?.y},${result.arrived_at?.z}).`);

        const forItemSuffix = result.for_item ? `_for_${result.for_item}` : '';
        routeToJudge(TAG, {
            ...payload,
            success: true,
            readable: `${TAG}: ${result.mode}_toward_${result.target_biome}${forItemSuffix}`,
            biome_seeker: {
                mode:            result.mode,
                current_biome:   result.current_biome,
                current_rank:    result.current_rank,
                target_biome:    result.target_biome,
                target_position: result.target_position,
                for_item:        result.for_item,
                arrived_at:      result.arrived_at,
                success:         true,
            },
        });
    }),
};
