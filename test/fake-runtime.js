/**
 * In-memory stand-in for the claude.ai Artifact runtime's `db`, `room` and
 * `user` capabilities (contract 0.2.52), covering the subset net.js uses.
 *
 * One runtime is one artifact; `viewer()` opens it as one person in one tab.
 * Deliveries are asynchronous, as they are in the real runtime, so tests must
 * `await settle()` before asserting. Lease expiry reads `Date.now()`, which
 * tests can drive with node:test's mock timers.
 */

/** Let queued deliveries and the promise chains they start run to completion. */
export async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i++) await new Promise((res) => setImmediate(res));
}

/**
 * @param {object} [options]
 * @param {boolean} [options.cachedFirst=false] Deliver a non-definitive,
 *   empty `fromCache` snapshot before the real one on every subscription —
 *   what a subscription may do before the server answers.
 */
export function createFakeRuntime({ cachedFirst = false } = {}) {
  /** @type {Map<string, object>} */
  const docs = new Map();
  /** @type {Map<string, Set<(snap: any) => void>>} */
  const docListeners = new Map();
  /** @type {Map<string, { holder: string, expiresAt: number }>} */
  const leases = new Map();
  /** @type {Array<{ peer: string, presence: object, updatedAt: number, listeners: Set<Function>, tab: object }>} */
  const peers = [];
  let peerSeq = 0;
  let writes = 0;
  /** Most `set` calls ever in flight at once on one document. */
  let maxConcurrentWrites = 0;
  /** @type {Map<string, number>} */
  const inflight = new Map();

  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const deepFreeze = (o) => {
    if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); }
    return o;
  };

  function snapshot(path, { fromCache = false } = {}) {
    const body = fromCache ? undefined : docs.get(path);
    return Object.freeze({
      id: path.split('/').pop(),
      exists: body !== undefined,
      data: () => body,
      metadata: Object.freeze({ fromCache, hasPendingWrites: false }),
    });
  }

  function notifyDoc(path) {
    for (const fn of docListeners.get(path) ?? []) queueMicrotask(() => fn(snapshot(path)));
  }

  function checkPath(path) {
    const segs = path.split('/');
    if (segs.length % 2 !== 0 || segs.some((s) => !/^[\w.~:@+-]+$/.test(s))) {
      throw new TypeError(`bad document path: ${path}`);
    }
  }

  function notifyPeers() {
    for (const p of peers) {
      for (const fn of p.listeners) {
        setImmediate(() => fn({ peers: p.tab.room.peers(), joined: [], left: [], updated: [] }));
      }
    }
  }

  return {
    /** Raw store access for assertions and for seeding. */
    docs,
    get writeCount() { return writes; },
    get maxConcurrentWrites() { return maxConcurrentWrites; },

    /**
     * Open the artifact as one viewer in one tab.
     * @param {object} [options]
     * @param {string | null} [options.uid='u_1']
     * @param {boolean | null} [options.canWrite=true] What `user.can('data.write')`
     *   answers (`null`: the platform said nothing).
     * @param {boolean} [options.writable] Whether the server accepts this
     *   viewer's shared writes; defaults to `canWrite !== false`.
     * @param {boolean} [options.withRoom=true]
     */
    viewer({ uid = 'u_1', canWrite = true, writable = canWrite !== false, withRoom = true } = {}) {
      const tab = {};

      const refuse = () => Promise.reject({ code: 'invalid_argument', message: 'write not permitted' });

      tab.db = Object.freeze({
        doc(path) {
          checkPath(path);
          return Object.freeze({
            id: path.split('/').pop(),
            path,
            async get() { return snapshot(path); },
            async set(data) {
              if (!writable) return refuse();
              const n = (inflight.get(path) ?? 0) + 1;
              inflight.set(path, n);
              maxConcurrentWrites = Math.max(maxConcurrentWrites, n);
              // A write takes a round trip; overlapping ones are visible here.
              await new Promise((res) => setImmediate(res));
              inflight.set(path, inflight.get(path) - 1);
              writes++;
              docs.set(path, deepFreeze(clone(data)));
              notifyDoc(path);
            },
            async update(data) {
              if (!writable) return refuse();
              if (!docs.has(path)) return Promise.reject({ code: 'invalid_argument', message: 'no document' });
              writes++;
              docs.set(path, deepFreeze({ ...clone(docs.get(path)), ...clone(data) }));
              notifyDoc(path);
            },
            async delete() {
              if (!writable) return refuse();
              docs.delete(path);
              notifyDoc(path);
            },
            async acquire({ holder, ttlMs = 30000 }) {
              const now = Date.now();
              const held = leases.get(path);
              if (held && held.expiresAt > now && held.holder !== holder) {
                return { acquired: false, expiresAt: new Date(held.expiresAt).toISOString() };
              }
              const expiresAt = now + Math.min(600000, Math.max(1000, ttlMs || 30000));
              leases.set(path, { holder, expiresAt });
              return { acquired: true, holder, version: writes, expiresAt: new Date(expiresAt).toISOString() };
            },
            onSnapshot(next) {
              const set = docListeners.get(path) ?? new Set();
              docListeners.set(path, set);
              let live = true;
              const fn = (snap) => { if (live) next(snap); };
              if (cachedFirst) queueMicrotask(() => fn(snapshot(path, { fromCache: true })));
              // The definitive first snapshot comes back from the server a
              // little later than the call that asked for it.
              setImmediate(() => { set.add(fn); fn(snapshot(path)); });
              return () => { live = false; set.delete(fn); };
            },
          });
        },
      });

      tab.user = Object.freeze({
        id: async () => uid,
        can: async (name) => (name === 'data.write' ? canWrite : false),
        canEdit: async () => false,
        isOwner: async () => false,
      });

      if (withRoom) {
        const self = { peer: 'p' + ++peerSeq, uid, presence: Object.freeze({}), updatedAt: Date.now(), listeners: new Set(), tab };
        peers.push(self);
        tab.room = Object.freeze({
          async presence(patch) {
            const next = { ...self.presence };
            for (const [k, v] of Object.entries(patch)) {
              if (v === null) delete next[k];
              else next[k] = clone(v);
            }
            self.presence = deepFreeze(next);
            self.updatedAt = Date.now();
            notifyPeers();
          },
          peers: () => Object.freeze(peers.map((p) => Object.freeze({
            peer: p.peer,
            by: null,
            isMe: p.uid === uid,
            sameTab: p === self,
            kind: 'viewer',
            presence: p.presence,
            updatedAt: p.updatedAt,
          }))),
          onPeers(fn) {
            self.listeners.add(fn);
            setImmediate(() => fn({ peers: tab.room.peers(), joined: tab.room.peers(), left: [], updated: [] }));
            return () => self.listeners.delete(fn);
          },
          onConnection(fn) {
            setImmediate(() => fn(true));
            return () => {};
          },
          connected: () => true,
        });
        tab.leave = () => {
          peers.splice(peers.indexOf(self), 1);
          notifyPeers();
        };
      } else {
        tab.room = null;
        tab.leave = () => {};
      }

      return tab;
    },
  };
}
