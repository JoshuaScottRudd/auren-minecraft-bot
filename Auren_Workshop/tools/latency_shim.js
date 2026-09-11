// latency_shim — puts a measured network delay between the fleet and the Minecraft server, on one machine.
//
// WHY IT EXISTS. The whole fleet was written against `localhost`, where a round trip is effectively zero,
// and the public-server plan moves the world onto a rented box 20-80 ms away. Nothing in this codebase has
// ever run under that condition, and `public_server_plan.md` §10 names it as the one unknown that can
// invalidate the rest of the plan: tick-counted waits, chat used as synchronisation, physics prediction and
// multi-bot ordering all currently get their timing for free.
//
// The obvious way to find out is to rent a server and try. This is the cheaper way and it comes FIRST: a
// TCP relay that holds every byte for a set delay before passing it on. Bots connect here instead of to the
// server; the server never knows. The answer arrives before a cent is spent, and — more useful — the delay
// is a DIAL, so the question stops being "does it work remotely" and becomes "at what latency does it stop
// working", which is a number the plan can be built on.
//
// ── ORDER IS THE WHOLE CORRECTNESS PROBLEM ───────────────────────────────────────────────────────────
// Minecraft's protocol is a stream, not messages: a chunk delayed past the chunk behind it does not arrive
// "late", it arrives CORRUPT, and the client desynchronises in a way that looks exactly like the fleet
// bug this instrument exists to hunt. Scheduling each chunk with its own `setTimeout(delay + jitter)` does
// precisely that whenever jitter makes one timer shorter than the one before it.
// So every direction keeps a queue whose release times are MONOTONIC: a chunk's release is the later of
// (now + delay ± jitter) and (the previous chunk's release). Jitter therefore adds delay and can never
// reorder — which is also how a real network behaves, since TCP itself will not deliver out of order.
//
// ── WHAT THE DELAY MEANS ─────────────────────────────────────────────────────────────────────────────
// `--delay-ms` is the ROUND TRIP, matching how latency is quoted everywhere else. Each direction is
// therefore held for half of it. Asking for 60 means a bot's action reaches the server 30 ms later and the
// world's answer comes back 30 ms after that, which is what a 60 ms ping to a rented box costs.
//
// ── WHAT IT DOES NOT SIMULATE ────────────────────────────────────────────────────────────────────────
// Packet loss, reordering, bandwidth limits and MTU behaviour. A real link drops packets and TCP recovers
// by retransmitting, which produces occasional multi-hundred-millisecond stalls that no fixed delay
// reproduces. So a fleet that survives this shim is not proven to survive the internet — it is proven to
// survive latency, which is the specific hypothesis under test (Law 25).
//
// Usage:
//   node Auren_Workshop/tools/latency_shim.js --listen=25567 --target=127.0.0.1:25565 --delay-ms=60 --jitter-ms=15
//   AUREN_SERVER_PORT=25567   → the fleet then dials the shim instead of the server (architect_config).

require('../../js_kernel/utils/developer_door').enter('Auren_Workshop/tools/latency_shim.js');
const net = require('net');

function delayedPipe(from, to, halfDelayMs, jitterMs, stats) {
  // The one piece of state that makes this correct: the release time of the chunk before this one.
  let lastRelease = 0;
  from.on('data', chunk => {
    const jitter = jitterMs > 0 ? (Math.random() * 2 - 1) * jitterMs : 0;
    const wanted = Date.now() + Math.max(0, halfDelayMs + jitter);
    const release = Math.max(wanted, lastRelease);
    lastRelease = release;
    stats.bytes += chunk.length;
    stats.chunks += 1;
    const wait = release - Date.now();
    if (wait <= 0) { if (!to.destroyed) to.write(chunk); return; }
    setTimeout(() => { if (!to.destroyed) to.write(chunk); }, wait);
  });
}

function run({ listenPort, targetHost, targetPort, delayMs, jitterMs }) {
  const half = delayMs / 2;
  const stats = { connections: 0, live: 0, up: { bytes: 0, chunks: 0 }, down: { bytes: 0, chunks: 0 } };

  const server = net.createServer(client => {
    stats.connections += 1; stats.live += 1;
    const upstream = net.connect({ host: targetHost, port: targetPort });

    // Nagle would coalesce small packets and add its own delay on top of the one being measured, which
    // would make the dial read low. Both ends off, so the shim contributes only what it was asked for.
    client.setNoDelay(true);
    upstream.setNoDelay(true);

    delayedPipe(client, upstream, half, jitterMs, stats.up);
    delayedPipe(upstream, client, half, jitterMs, stats.down);

    // A half-closed relay is a hung bot: whichever side ends, the other is torn down with it rather than
    // left holding a socket nothing will ever write to again (Law 13 — default stopped).
    const close = () => {
      if (!client.destroyed) client.destroy();
      if (!upstream.destroyed) upstream.destroy();
      stats.live = Math.max(0, stats.live - 1);
    };
    client.on('end', close); client.on('error', close); client.on('close', close);
    upstream.on('end', close); upstream.on('error', close); upstream.on('close', close);
  });

  server.on('error', err => {
    console.error(`latency_shim: cannot listen on ${listenPort} — ${err.message}`);
    process.exit(1);
  });

  server.listen(listenPort, '127.0.0.1', () => {
    console.log(`latency_shim: listening on 127.0.0.1:${listenPort} -> ${targetHost}:${targetPort}`);
    console.log(`              round trip ${delayMs} ms (${half} ms each way), jitter +/-${jitterMs} ms.`);
    console.log(`              point the fleet at it with AUREN_SERVER_PORT=${listenPort}.`);
  });

  const report = setInterval(() => {
    console.log(`latency_shim: ${stats.live} live / ${stats.connections} total   ` +
                `up ${(stats.up.bytes / 1048576).toFixed(1)} MB in ${stats.up.chunks} chunks   ` +
                `down ${(stats.down.bytes / 1048576).toFixed(1)} MB in ${stats.down.chunks} chunks`);
  }, 30000);
  report.unref?.();

  const finish = () => {
    console.log(`latency_shim: closing after ${stats.connections} connection(s), ` +
                `${((stats.up.bytes + stats.down.bytes) / 1048576).toFixed(1)} MB relayed.`);
    process.exit(0);
  };
  process.on('SIGTERM', finish);
  process.on('SIGINT', finish);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (key, fallback) => {
    const hit = args.find(a => a.startsWith(`--${key}=`));
    return hit ? hit.slice(key.length + 3) : fallback;
  };
  const target = opt('target', '127.0.0.1:25565');
  const [targetHost, targetPortRaw] = target.split(':');
  const listenPort = parseInt(opt('listen', '25567'), 10);
  const targetPort = parseInt(targetPortRaw, 10);
  const delayMs = parseFloat(opt('delay-ms', '60'));
  const jitterMs = parseFloat(opt('jitter-ms', '0'));

  // Refused rather than defaulted: a shim that silently relays to the wrong port would produce a clean run
  // at zero latency and be read as the fleet passing the test it never took (Law 25).
  if (!Number.isFinite(listenPort) || !Number.isFinite(targetPort) || !targetHost) {
    console.error('latency_shim: --listen and --target=host:port must both be valid.');
    process.exit(1);
  }
  if (listenPort === targetPort && (targetHost === '127.0.0.1' || targetHost === 'localhost')) {
    console.error('latency_shim: --listen and --target are the same socket — that is a loop, not a relay.');
    process.exit(1);
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) { console.error('latency_shim: --delay-ms must be >= 0.'); process.exit(1); }

  run({ listenPort, targetHost, targetPort, delayMs, jitterMs: Number.isFinite(jitterMs) ? Math.abs(jitterMs) : 0 });
}
