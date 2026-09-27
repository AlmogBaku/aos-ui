// Pure allocation of generated Agent icons. Every visible Agent gets a unique
// (silhouette, tone) pair, least-used silhouette first and then least-used
// tone, until visible Agents outnumber the pool; then pairs repeat
// deterministically.

import {
  avatarToken,
  silhouettes,
  tones,
  type AvatarPair,
} from "@/components/agent-icons/pool"

const S = silhouettes.length
const T = tones.length

export interface AgentAvatarInput {
  readonly id: string
  readonly avatar?: string | null
  /** The runtime can save this Agent's avatar; absent means it cannot. */
  readonly avatarEditable?: boolean
}

/**
 * - `saved`: a known token this Agent holds uncontested.
 * - `unsaved`: no token saved; the resolved one should be saved.
 * - `contested`: a known token a lower id also holds; re-save the resolved one.
 * - `unknown`: a token outside the pool; drawn from its hash, never re-saved.
 */
export type AgentIconSource = "saved" | "unsaved" | "contested" | "unknown"

export interface ResolvedAgentIcon {
  readonly pair: AvatarPair
  /** The pool token of `pair`, which is what the tile draws. */
  readonly token: string
  readonly source: AgentIconSource
}

export interface AvatarSave {
  readonly agentId: string
  readonly avatar: string
}

export type VisibilityPatch =
  | { visibility: "hidden"; avatar: null }
  | { visibility: "visible"; avatar: string }

const knownPairs = new Map<string, AvatarPair>()
for (let s = 0; s < S; s += 1) {
  for (let t = 0; t < T; t += 1) knownPairs.set(avatarToken([s, t]), [s, t])
}

/** 32-bit FNV-1a over UTF-16 code units. */
function hash(value: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function parseAvatar(token: string): {
  pair: AvatarPair
  known: boolean
} {
  const known = knownPairs.get(token)
  if (known) return { pair: known, known: true }
  const h = hash(token)
  return { pair: [h % S, Math.floor(h / S) % T], known: false }
}

/** Silhouette and tone use counts and taken pairs of the icons placed so far. */
class Placement {
  private readonly uses = new Array<number>(S).fill(0)
  private readonly toneUses = new Array<number>(T).fill(0)
  private readonly taken = new Set<number>()

  constructor(pairs: Iterable<AvatarPair> = []) {
    for (const pair of pairs) this.add(pair)
  }

  add([s, t]: AvatarPair) {
    this.uses[s] += 1
    this.toneUses[t] += 1
    this.taken.add(s * T + t)
  }

  isFree([s, t]: AvatarPair) {
    return !this.taken.has(s * T + t)
  }

  /** Silhouettes from least to most used, pool order breaking ties. */
  silhouetteOrder() {
    return [...this.uses.keys()].sort(
      (a, b) => this.uses[a] - this.uses[b] || a - b
    )
  }

  /**
   * The free tones of silhouette `s` that are used least across every placed
   * icon, in pool order; every tone when `s` has none free.
   */
  leastUsedTones(s: number) {
    const free = [...tones.keys()].filter((t) => this.isFree([s, t]))
    const candidates = free.length ? free : [...tones.keys()]
    const fewest = Math.min(...candidates.map((t) => this.toneUses[t]))
    return candidates.filter((t) => this.toneUses[t] === fewest)
  }

  /** The silhouette to place next: the least-used one that has a free tone. */
  nextSilhouette() {
    const order = this.silhouetteOrder()
    return (
      order.find((s) => [...tones.keys()].some((t) => this.isFree([s, t]))) ??
      order[0]
    )
  }

  /**
   * The least-used silhouette, then its least-used free tone, the first of
   * those in a rotation from `start`.
   */
  pick(start: number): AvatarPair {
    const s = this.nextSilhouette()
    const candidates = this.leastUsedTones(s)
    for (let k = 0; k < T; k += 1) {
      const t = (start + k) % T
      if (candidates.includes(t)) return [s, t]
    }
    return [s, candidates[0]]
  }

  /**
   * First free pair in pool order from `from`, wrapping. Unlike `pick`, the
   * result ignores use counts, so placing a pair it passed over earlier can
   * never move it: an Agent that is never saved keeps its icon through a
   * save pass.
   */
  scanFrom([s, t]: AvatarPair): AvatarPair {
    const start = s * T + t
    for (let k = 0; k < S * T; k += 1) {
      const index = (start + k) % (S * T)
      const pair: AvatarPair = [Math.floor(index / T), index % T]
      if (this.isFree(pair)) return pair
    }
    return [s, t]
  }
}

/**
 * The unhide rule: the least-used silhouette among `shown`, then a random one
 * of its least-used free tones. `random` returns a number in [0, 1).
 *
 * Above 34 visible Agents an unhide can shift the silhouette of an unsaved
 * Agent that is not avatarEditable, since its computed pair is no longer free;
 * no current provider reaches that many.
 */
export function nextFree(
  shown: readonly AvatarPair[],
  random: () => number
): AvatarPair {
  const placement = new Placement(shown)
  const s = placement.nextSilhouette()
  const candidates = placement.leastUsedTones(s)
  return [s, candidates[Math.floor(random() * candidates.length)]]
}

const byId = (a: AgentAvatarInput, b: AgentAvatarInput) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0

/**
 * Resolves the icon of every visible Agent. The returned map iterates in
 * resolution order, three groups each by ascending id:
 * 1. known, uncontested saved pairs;
 * 2. Agents that will be saved: editable and unsaved or contested;
 * 3. everything else: unsaved but not editable, and unknown tokens.
 * Saving the first group-2 Agent moves it into group 1 on the same pair, so
 * every Agent after it sees the same placed pairs and none moves.
 */
export function resolveAgentIcons(
  agents: readonly AgentAvatarInput[]
): Map<string, ResolvedAgentIcon> {
  const placement = new Placement()
  const resolved = new Map<string, ResolvedAgentIcon>()
  const place = (id: string, pair: AvatarPair, source: AgentIconSource) => {
    placement.add(pair)
    resolved.set(id, { pair, token: avatarToken(pair), source })
  }

  type Pending = { agent: AgentAvatarInput; source: AgentIconSource }
  const toSave: Pending[] = []
  const rest: Pending[] = []
  for (const agent of [...agents].sort(byId)) {
    let source: AgentIconSource = "unsaved"
    if (agent.avatar) {
      const { pair, known } = parseAvatar(agent.avatar)
      if (known && placement.isFree(pair)) {
        place(agent.id, pair, "saved")
        continue
      }
      source = known ? "contested" : "unknown"
    }
    const willSave = agent.avatarEditable && source !== "unknown"
    ;(willSave ? toSave : rest).push({ agent, source })
  }

  for (const { agent, source } of [...toSave, ...rest]) {
    place(
      agent.id,
      source === "unknown"
        ? placement.scanFrom(parseAvatar(agent.avatar as string).pair)
        : placement.pick(hash(agent.id) % T),
      source
    )
  }
  return resolved
}

/**
 * The saves that fix every group-2 Agent's icon to what it already shows, in
 * resolution order so no shown icon moves mid-pass.
 */
export function planAvatarSaves(
  agents: readonly AgentAvatarInput[],
  attempted: ReadonlySet<string>
): AvatarSave[] {
  const editable = new Set(
    agents.filter((agent) => agent.avatarEditable).map((agent) => agent.id)
  )
  return [...resolveAgentIcons(agents)]
    .filter(
      ([id, icon]) =>
        editable.has(id) &&
        !attempted.has(id) &&
        (icon.source === "unsaved" || icon.source === "contested")
    )
    .map(([agentId, icon]) => ({ agentId, avatar: icon.token }))
}

/**
 * The Agent update for a visibility change: hiding clears the icon, and
 * unhiding takes the next free pair among the icons every visible Agent shows
 * (see `nextFree` for the one case above 34 visible Agents).
 */
export function visibilityPatch(
  visibility: "hidden" | "visible",
  visibleAgents: readonly AgentAvatarInput[],
  random: () => number = Math.random
): VisibilityPatch {
  if (visibility === "hidden") return { visibility, avatar: null }
  const shown = [...resolveAgentIcons(visibleAgents).values()].map(
    (icon) => icon.pair
  )
  return { visibility, avatar: avatarToken(nextFree(shown, random)) }
}
