// /game/board_engine.js
/**
 * Triangular-lattice (axial) fog-of-war board engine.
 *
 * Design goals:
 * - Visibility is the resource (not score, not capture).
 * - PAUSE is first-class: legal, no penalty, no "turn consumption" here.
 * - Markers stabilize visibility as memory (not territory conquest).
 *
 * Coordinates:
 * - Axial (q, r) with 6 neighbors:
 *   (±1,0), (0,±1), (±1,∓1)
 *
 * Exports:
 * - BoardEngine: main API
 * - ActionError: thrown for invalid actions
 * - PlayerState: enum-like
 */

export class ActionError extends Error {
  constructor(message) {
    super(message);
    this.name = "ActionError";
  }
}

export const PlayerState = Object.freeze({
  ACTIVE: "ACTIVE",
  PAUSED: "PAUSED",
});

export const AXIAL_DELTAS = Object.freeze([
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, -1],
  [-1, 1],
]);

/**
 * @typedef {[number, number]} Axial
 */

function keyOf(qr) {
  return `${qr[0]},${qr[1]}`;
}

function parseKey(k) {
  const [q, r] = k.split(",").map((x) => Number(x));
  return [q, r];
}

export function add(a, b) {
  return [a[0] + b[0], a[1] + b[1]];
}

export function axialDistance(a, b) {
  // cube: x=q, z=r, y=-x-z
  const ax = a[0];
  const az = a[1];
  const ay = -ax - az;

  const bx = b[0];
  const bz = b[1];
  const by = -bx - bz;

  return Math.max(Math.abs(ax - bx), Math.abs(ay - by), Math.abs(az - bz));
}

export function neighbors(coord) {
  return AXIAL_DELTAS.map((d) => add(coord, d));
}

export class Node {
  /**
   * @param {Axial} pos
   */
  constructor(pos) {
    this.q = pos[0];
    this.r = pos[1];
    /** @type {string|null} */
    this.occupiedBy = null;
    /** @type {Set<string>} */
    this.visibleTo = new Set();
  }

  /** @returns {Axial} */
  get pos() {
    return [this.q, this.r];
  }
}

export class Marker {
  /**
   * @param {string} ownerId
   * @param {Axial} position
   * @param {number} stabilizeRadius
   */
  constructor(ownerId, position, stabilizeRadius) {
    this.ownerId = ownerId;
    this.position = position;
    this.stabilizeRadius = stabilizeRadius;
  }
}

export class Player {
  /**
   * @param {object} args
   * @param {string} args.id
   * @param {Axial} args.position
   * @param {number} [args.visibilityRadius=1]
   */
  constructor({ id, position, visibilityRadius = 1 }) {
    this.id = id;
    this.position = position;
    this.visibilityRadius = visibilityRadius;
    this.moveCount = 0;
    this.state = PlayerState.ACTIVE;
  }
}

export class BoardConfig {
  constructor({
    boardRadius = 6,
    moveVisibilityGrowth = 1,
    markerStabilizeRadius = 2,
  } = {}) {
    this.boardRadius = boardRadius;
    this.moveVisibilityGrowth = moveVisibilityGrowth;
    this.markerStabilizeRadius = markerStabilizeRadius;
  }
}

export class BoardEngine {
  /**
   * @param {object} args
   * @param {BoardConfig} [args.config]
   * @param {Axial} [args.origin]
   * @param {Player} [args.player] - optional; will be created if omitted
   */
  constructor({ config = new BoardConfig(), origin = [0, 0], player } = {}) {
    this.config = config;
    this.origin = origin;

    /** @type {Map<string, Node>} */
    this.nodes = new Map();
    /** @type {Marker[]} */
    this.markers = [];

    /** @type {Map<string, Player>} */
    this.players = new Map();

    this._initNodes();

    const p = player ?? new Player({ id: "P1", position: origin, visibilityRadius: 1 });
    this.addPlayer(p);

    // Occupy starting node
    this.getNode(p.position).occupiedBy = p.id;

    this._recomputeVisibilityFor(p.id);

    /** @type {Array<{type:string, playerId:string, payload:object, at:number}>} */
    this.log = [];
    this._tick = 0; // monotonic event clock; PAUSE does not advance any counters besides log time
  }

  // ---------- Setup / Access ----------

  _initNodes() {
    const r = this.config.boardRadius;
    for (let q = -r; q <= r; q += 1) {
      for (let rr = -r; rr <= r; rr += 1) {
        if (axialDistance(this.origin, [q, rr]) <= r) {
          this.nodes.set(keyOf([q, rr]), new Node([q, rr]));
        }
      }
    }
  }

  /**
   * @param {Axial} coord
   * @returns {boolean}
   */
  inBounds(coord) {
    return this.nodes.has(keyOf(coord));
  }

  /**
   * @param {Axial} coord
   * @returns {Node}
   */
  getNode(coord) {
    const k = keyOf(coord);
    const n = this.nodes.get(k);
    if (!n) throw new ActionError(`Out of bounds: ${k}`);
    return n;
  }

  /**
   * @param {Player} player
   */
  addPlayer(player) {
    if (!this.inBounds(player.position)) {
      throw new ActionError(`Player start out of bounds: ${player.position}`);
    }
    if (this.players.has(player.id)) {
      throw new ActionError(`Player already exists: ${player.id}`);
    }
    this.players.set(player.id, player);
  }

  /**
   * @param {string} playerId
   * @returns {Player}
   */
  getPlayer(playerId = "P1") {
    const p = this.players.get(playerId);
    if (!p) throw new ActionError(`Unknown player: ${playerId}`);
    return p;
  }

  // ---------- Visibility ----------

  /**
   * Brute-force within distance for MVP correctness.
   * @param {Axial} center
   * @param {number} dist
   * @returns {Set<string>} set of node keys
   */
  nodesWithinDistanceKeys(center, dist) {
    const out = new Set();
    for (const [k] of this.nodes) {
      const coord = parseKey(k);
      if (axialDistance(center, coord) <= dist) out.add(k);
    }
    return out;
  }

  /**
   * @param {string} playerId
   * @returns {Set<string>}
   */
  stabilizedKeys(playerId) {
    const out = new Set();
    for (const m of this.markers) {
      if (m.ownerId !== playerId) continue;
      const keys = this.nodesWithinDistanceKeys(m.position, m.stabilizeRadius);
      for (const k of keys) out.add(k);
    }
    return out;
  }

  /**
   * @param {string} playerId
   * @returns {Set<string>}
   */
  visibleKeys(playerId) {
    const p = this.getPlayer(playerId);
    const dynamic = this.nodesWithinDistanceKeys(p.position, p.visibilityRadius);
    const stabilized = this.stabilizedKeys(playerId);
    for (const k of stabilized) dynamic.add(k);
    return dynamic;
  }

  /**
   * Recompute visibility for a single player, writing into Node.visibleTo.
   * @param {string} playerId
   */
  _recomputeVisibilityFor(playerId) {
    // clear current
    for (const [, node] of this.nodes) node.visibleTo.delete(playerId);

    const vis = this.visibleKeys(playerId);
    for (const k of vis) {
      const node = this.nodes.get(k);
      if (node) node.visibleTo.add(playerId);
    }
  }

  /**
   * @param {Axial} coord
   * @param {string} playerId
   * @returns {boolean}
   */
  isVisible(coord, playerId = "P1") {
    if (!this.inBounds(coord)) return false;
    return this.getNode(coord).visibleTo.has(playerId);
  }

  // ---------- Actions ----------

  /**
   * PAUSE: legal action, no penalty, no counters, no visibility growth.
   * It also does not change visibility by itself.
   * @param {string} playerId
   */
  pause(playerId = "P1") {
    const p = this.getPlayer(playerId);
    p.state = PlayerState.PAUSED;
    this._log("PAUSE", playerId, {});
  }

  /**
   * Resume to ACTIVE.
   * @param {string} playerId
   */
  resume(playerId = "P1") {
    const p = this.getPlayer(playerId);
    p.state = PlayerState.ACTIVE;
    this._log("RESUME", playerId, {});
  }

  /**
   * PLACE marker: stabilizes visibility. Does not grow visibility radius.
   * MVP rule: marker must be on a visible node (prevents "omniscient placing").
   * @param {object} args
   * @param {string} [args.playerId]
   * @param {Axial} [args.at] - default: player's current position
   */
  placeMarker({ playerId = "P1", at } = {}) {
    const p = this.getPlayer(playerId);
    if (p.state !== PlayerState.ACTIVE) throw new ActionError("Cannot PLACE while PAUSED.");

    const pos = at ?? p.position;
    if (!this.inBounds(pos)) throw new ActionError(`Cannot PLACE out of bounds: ${pos}`);

    if (!this.isVisible(pos, playerId)) {
      throw new ActionError(`Cannot PLACE on hidden node: ${pos}`);
    }

    // No stacking same-owner markers on same node (MVP safety)
    for (const m of this.markers) {
      if (m.ownerId === playerId && keyOf(m.position) === keyOf(pos)) {
        throw new ActionError(`Marker already present at ${pos}`);
      }
    }

    this.markers.push(new Marker(playerId, pos, this.config.markerStabilizeRadius));
    this._recomputeVisibilityFor(playerId);
    this._log("PLACE", playerId, { at: pos });
  }

  /**
   * MOVE to an adjacent visible node. This is the ONLY action that grows visibility radius.
   * @param {object} args
   * @param {string} [args.playerId]
   * @param {Axial} args.to
   */
  move({ playerId = "P1", to }) {
    const p = this.getPlayer(playerId);
    if (p.state !== PlayerState.ACTIVE) throw new ActionError("Cannot MOVE while PAUSED.");
    if (!to) throw new ActionError("MOVE requires {to:[q,r]}");

    if (!this.inBounds(to)) throw new ActionError(`Cannot MOVE out of bounds: ${to}`);
    if (axialDistance(p.position, to) !== 1) throw new ActionError(`MOVE target not adjacent: ${to}`);
    if (!this.isVisible(to, playerId)) throw new ActionError(`MOVE target not visible: ${to}`);

    const target = this.getNode(to);
    if (target.occupiedBy && target.occupiedBy !== playerId) {
      throw new ActionError(`MOVE blocked: occupied by ${target.occupiedBy}`);
    }

    // update occupancy
    this.getNode(p.position).occupiedBy = null;
    target.occupiedBy = playerId;
    p.position = to;

    // visibility grows ONLY on MOVE
    p.moveCount += 1;
    p.visibilityRadius += this.config.moveVisibilityGrowth;

    this._recomputeVisibilityFor(playerId);
    this._log("MOVE", playerId, { to });
  }

  /**
   * Convenience move by direction name.
   * @param {object} args
   * @param {string} [args.playerId]
   * @param {"e"|"w"|"ne"|"nw"|"se"|"sw"} args.dir
   */
  moveDir({ playerId = "P1", dir }) {
    const dirs = {
      e: [1, 0],
      w: [-1, 0],
      se: [0, 1],
      nw: [0, -1],
      ne: [1, -1],
      sw: [-1, 1],
    };
    const delta = dirs[dir];
    if (!delta) throw new ActionError(`Unknown dir "${dir}". Use e w ne nw se sw.`);
    const p = this.getPlayer(playerId);
    this.move({ playerId, to: add(p.position, delta) });
  }

  // ---------- Read APIs (for UI layer) ----------

  /**
   * @param {string} playerId
   * @returns {{
   *   id:string, position:Axial, visibilityRadius:number, moveCount:number, state:string
   * }}
   */
  playerSnapshot(playerId = "P1") {
    const p = this.getPlayer(playerId);
    return {
      id: p.id,
      position: p.position,
      visibilityRadius: p.visibilityRadius,
      moveCount: p.moveCount,
      state: p.state,
    };
  }

  /**
   * Visible nodes as axial coords.
   * @param {string} playerId
   * @returns {Axial[]}
   */
  visibleNodes(playerId = "P1") {
    return [...this.visibleKeys(playerId)].map(parseKey);
  }

  /**
   * Stabilized nodes (marker-memory) as axial coords.
   * @param {string} playerId
   * @returns {Axial[]}
   */
  stabilizedNodes(playerId = "P1") {
    return [...this.stabilizedKeys(playerId)].map(parseKey);
  }

  /**
   * @param {string} playerId
   * @returns {{position:Axial, radius:number}[]}
   */
  markerSnapshot(playerId = "P1") {
    return this.markers
      .filter((m) => m.ownerId === playerId)
      .map((m) => ({ position: m.position, radius: m.stabilizeRadius }));
  }

  /**
   * Node view relative to player (hidden is derived).
   * @param {Axial} coord
   * @param {string} playerId
   * @returns {{position:Axial, occupiedBy:string|null, visibleTo:string[], hidden:boolean}}
   */
  nodeView(coord, playerId = "P1") {
    const node = this.getNode(coord);
    const visible = node.visibleTo.has(playerId);
    return {
      position: node.pos,
      occupiedBy: node.occupiedBy,
      visibleTo: [...node.visibleTo],
      hidden: !visible,
    };
  }

  _log(type, playerId, payload) {
    this.log.push({ type, playerId, payload, at: this._tick });
    this._tick += 1;
  }
}
