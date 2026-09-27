import { describe, expect, it } from "vitest"

import {
  nextFree,
  parseAvatar,
  planAvatarSaves,
  resolveAgentIcons,
  visibilityPatch,
  type AgentAvatarInput,
} from "@/components/agent-icons/allocation"
import {
  avatarToken,
  silhouettes,
  tones,
  type AvatarPair,
} from "@/components/agent-icons/pool"

const S = silhouettes.length
const T = tones.length
const UNKNOWN = "future-shape/ultraviolet"

function roster(count: number, prefix = "agent"): AgentAvatarInput[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${String(index).padStart(3, "0")}`,
  }))
}

function pairOf(silhouette: string, tone: string): AvatarPair {
  return [
    silhouettes.findIndex((entry) => entry.slug === silhouette),
    tones.findIndex((entry) => entry.slug === tone),
  ]
}

function tokens(agents: readonly AgentAvatarInput[]) {
  return new Map(
    [...resolveAgentIcons(agents)].map(([id, icon]) => [id, icon.token])
  )
}

function distinctPairs(agents: readonly AgentAvatarInput[]) {
  return new Set([...resolveAgentIcons(agents).values()].map((i) => i.token))
    .size
}

function editable(agents: readonly AgentAvatarInput[]) {
  return agents.map((agent) => ({ ...agent, avatarEditable: true }))
}

describe("the pool", () => {
  it("holds 34 silhouettes and 8 tones with unique slugs", () => {
    expect(new Set(silhouettes.map((s) => s.slug)).size).toBe(34)
    expect(new Set(tones.map((t) => t.slug)).size).toBe(8)
  })
})

describe("parseAvatar", () => {
  it("returns the known pair of a pool token", () => {
    expect(parseAvatar("ring/blue")).toEqual({
      pair: pairOf("ring", "blue"),
      known: true,
    })
  })

  it("round-trips every one of the 272 pool tokens", () => {
    for (let s = 0; s < S; s += 1) {
      for (let t = 0; t < T; t += 1) {
        expect(parseAvatar(avatarToken([s, t]))).toEqual({
          pair: [s, t],
          known: true,
        })
      }
    }
  })

  it("hashes an unknown token to a stable in-pool pair", () => {
    const first = parseAvatar(UNKNOWN)
    expect(first.known).toBe(false)
    expect(parseAvatar(UNKNOWN)).toEqual(first)
    const [s, t] = first.pair
    expect(s).toBeGreaterThanOrEqual(0)
    expect(s).toBeLessThan(S)
    expect(t).toBeGreaterThanOrEqual(0)
    expect(t).toBeLessThan(T)
  })

  it("treats a known silhouette with an unknown tone as unknown", () => {
    expect(parseAvatar("ring/ultraviolet").known).toBe(false)
  })
})

describe("nextFree", () => {
  it("starts with the first silhouette of an empty workspace", () => {
    expect(nextFree([], () => 0)).toEqual([0, 0])
    expect(nextFree([], () => 0.999)).toEqual([0, T - 1])
  })

  it("takes the least-used silhouette, pool order breaking ties", () => {
    expect(nextFree([[0, 3]], () => 0)[0]).toBe(1)
    expect(
      nextFree(
        [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
        () => 0
      )[0]
    ).toBe(2)
  })

  it("picks a random tone among the free tones no shown Agent uses more", () => {
    const shown: AvatarPair[] = [
      [0, 0],
      [1, 1],
    ]
    // Silhouette 2 is least used; tones 2 to 7 are unused anywhere.
    expect(nextFree(shown, () => 0)).toEqual([2, 2])
    expect(nextFree(shown, () => 0.999)).toEqual([2, 7])
  })

  it("prefers the least-used tone among a silhouette's free tones", () => {
    const shown: AvatarPair[] = []
    for (let s = 0; s < S; s += 1) {
      for (let t = 0; t < T - 1; t += 1) {
        if (s === 0 && t === 2) continue
        shown.push([s, t])
      }
    }
    // Silhouette 0 is least used, with tones 2 and 7 free; 7 is used least.
    expect(nextFree(shown, () => 0)).toEqual([0, 7])
  })

  it("allows a duplicate of the least-used silhouette once all 272 are shown", () => {
    const shown: AvatarPair[] = [[0, 0]]
    for (let s = 0; s < S; s += 1) {
      for (let t = 0; t < T; t += 1) shown.push([s, t])
    }
    expect(nextFree(shown, () => 0.5)).toEqual([1, 4])
  })
})

describe("resolveAgentIcons", () => {
  it("gives the first 34 visible Agents 34 different silhouettes", () => {
    const icons = [...resolveAgentIcons(roster(34)).values()]
    expect(new Set(icons.map((icon) => icon.pair[0])).size).toBe(34)
    expect(icons.every((icon) => icon.source === "unsaved")).toBe(true)
  })

  it("gives the first 8 visible Agents 8 different tones", () => {
    const icons = [...resolveAgentIcons(roster(8)).values()]
    expect(new Set(icons.map((icon) => icon.pair[1])).size).toBe(8)
  })

  it("spreads tones evenly while silhouettes stay unique", () => {
    const icons = [...resolveAgentIcons(roster(34)).values()]
    const uses = new Array<number>(T).fill(0)
    for (const icon of icons) uses[icon.pair[1]] += 1
    expect(Math.max(...uses) - Math.min(...uses)).toBeLessThanOrEqual(1)
  })

  it("gives an unsaved Agent a tone the saved Agents do not use", () => {
    const saved = tones.slice(0, T - 1).map((tone, index) => ({
      id: `saved-${index}`,
      avatar: avatarToken(pairOf(silhouettes[index].slug, tone.slug)),
    }))
    const icons = resolveAgentIcons([...saved, { id: "new" }])
    expect(icons.get("new")?.pair[1]).toBe(T - 1)
  })

  it("fills silhouettes evenly: no silhouette holds a second pair before all hold one", () => {
    const icons = [...resolveAgentIcons(roster(68)).values()]
    const uses = new Array<number>(S).fill(0)
    for (const icon of icons) uses[icon.pair[0]] += 1
    expect(uses.every((count) => count === 2)).toBe(true)
  })

  it("keeps every pair unique up to 272 and duplicates only past it", () => {
    expect(distinctPairs(roster(272))).toBe(272)
    const crowded = resolveAgentIcons(roster(273))
    expect(crowded.size).toBe(273)
    expect(distinctPairs(roster(273))).toBe(272)
  })

  it("keeps a saved pair and places unsaved Agents on free pairs after it", () => {
    const agents: AgentAvatarInput[] = [
      { id: "aaa-unsaved" },
      { id: "zzz-saved", avatar: avatarToken([0, 4]) },
    ]
    const icons = resolveAgentIcons(agents)
    expect(icons.get("zzz-saved")).toEqual({
      pair: [0, 4],
      token: avatarToken([0, 4]),
      source: "saved",
    })
    // Silhouette 0 is already used by the saved Agent, so the unsaved one,
    // though first by id, takes the next least-used silhouette.
    expect(icons.get("aaa-unsaved")?.pair[0]).toBe(1)
    expect(icons.get("aaa-unsaved")?.source).toBe("unsaved")
  })

  it("orders the result saved first, then by ascending id", () => {
    const agents: AgentAvatarInput[] = [
      { id: "c" },
      { id: "z", avatar: "block/red" },
      { id: "a" },
      { id: "b", avatar: UNKNOWN },
    ]
    expect([...resolveAgentIcons(agents).keys()]).toEqual(["z", "a", "b", "c"])
  })

  it("resolves Agents that will be saved before those that never will", () => {
    const agents: AgentAvatarInput[] = [
      { id: "a-readonly" },
      { id: "b-unknown", avatar: UNKNOWN, avatarEditable: true },
      { id: "c-editable", avatarEditable: true },
      { id: "d-saved", avatar: "ring/blue" },
      { id: "e-contested", avatar: "ring/blue", avatarEditable: true },
    ]
    expect([...resolveAgentIcons(agents).keys()]).toEqual([
      "d-saved",
      "c-editable",
      "e-contested",
      "a-readonly",
      "b-unknown",
    ])
  })

  it("is stable for the same roster in any input order", () => {
    const agents = [
      ...roster(40),
      { id: "saved-1", avatar: "ring/blue" },
      { id: "unknown-1", avatar: UNKNOWN },
    ]
    expect(tokens([...agents].reverse())).toEqual(tokens(agents))
  })

  it("keeps a contested saved pair for the lowest id and treats the other as unsaved", () => {
    const icons = resolveAgentIcons([
      { id: "beta", avatar: "ring/blue" },
      { id: "alpha", avatar: "ring/blue" },
    ])
    expect(icons.get("alpha")).toMatchObject({
      token: "ring/blue",
      source: "saved",
    })
    expect(icons.get("beta")?.source).toBe("contested")
    expect(icons.get("beta")?.token).not.toBe("ring/blue")
  })

  it("resolves an unknown token deterministically from the token itself", () => {
    const hashed = parseAvatar(UNKNOWN).pair
    for (const id of ["one", "another"]) {
      expect(resolveAgentIcons([{ id, avatar: UNKNOWN }]).get(id)).toEqual({
        pair: hashed,
        token: avatarToken(hashed),
        source: "unknown",
      })
    }
  })

  it("moves an unknown token off a known saved pair its hash lands on", () => {
    const hashed = parseAvatar(UNKNOWN).pair
    const icons = resolveAgentIcons([
      { id: "zzz-owner", avatar: avatarToken(hashed) },
      { id: "aaa-unknown", avatar: UNKNOWN },
    ])
    expect(icons.get("zzz-owner")?.source).toBe("saved")
    expect(icons.get("aaa-unknown")?.source).toBe("unknown")
    expect(icons.get("aaa-unknown")?.token).not.toBe(avatarToken(hashed))
    expect(
      resolveAgentIcons([
        { id: "zzz-owner", avatar: avatarToken(hashed) },
        { id: "other-unknown", avatar: UNKNOWN },
      ]).get("other-unknown")?.token
    ).toBe(icons.get("aaa-unknown")?.token)
  })
})

describe("saving in resolution order", () => {
  function expectStablePass(roster: readonly AgentAvatarInput[]) {
    let agents = roster
    const shown = tokens(agents)
    const plan = planAvatarSaves(agents, new Set())
    expect(plan.length).toBeGreaterThan(34)

    for (const save of plan) {
      agents = agents.map((agent) =>
        agent.id === save.agentId ? { ...agent, avatar: save.avatar } : agent
      )
      expect(tokens(agents)).toEqual(shown)
    }
    expect(planAvatarSaves(agents, new Set())).toEqual([])
  }

  // Two unknown tokens lead the id order, the last Agent holds the pair the
  // first one hashes to, and two Agents contest ring/blue.
  const saved: Record<string, string> = {
    "agent-003": UNKNOWN,
    "agent-004": "future-shape/infrared",
    "agent-010": "ring/blue",
    "agent-011": "ring/blue",
    "agent-040": "block/red",
    "agent-089": avatarToken(parseAvatar(UNKNOWN).pair),
  }

  it("leaves every shown token unchanged through the whole pass", () => {
    expectStablePass(
      editable(roster(90)).map((agent) => ({
        ...agent,
        avatar: saved[agent.id],
      }))
    )
  })

  it("stays stable when non-editable Agents sort before editable ones", () => {
    expectStablePass(
      roster(90).map((agent, index) => ({
        ...agent,
        avatar: saved[agent.id],
        avatarEditable: index >= 3,
      }))
    )
  })
})

describe("planAvatarSaves", () => {
  it("plans exactly the resolved tokens of editable unsaved and contested Agents", () => {
    const agents: AgentAvatarInput[] = [
      { id: "d-unsaved", avatarEditable: true },
      { id: "c-readonly", avatarEditable: false },
      { id: "b-contested", avatar: "ring/blue", avatarEditable: true },
      { id: "a-saved", avatar: "ring/blue", avatarEditable: true },
      { id: "e-unknown", avatar: UNKNOWN, avatarEditable: true },
      { id: "f-attempted", avatarEditable: true },
    ]
    const icons = resolveAgentIcons(agents)
    expect(planAvatarSaves(agents, new Set(["f-attempted"]))).toEqual([
      { agentId: "b-contested", avatar: icons.get("b-contested")?.token },
      { agentId: "d-unsaved", avatar: icons.get("d-unsaved")?.token },
    ])
  })

  it("counts a non-editable Agent's saved pair as held against an editable one", () => {
    const agents: AgentAvatarInput[] = [
      { id: "a-readonly", avatar: "ring/blue", avatarEditable: false },
      { id: "b-editable", avatar: "ring/blue", avatarEditable: true },
    ]
    const icons = resolveAgentIcons(agents)
    expect(icons.get("a-readonly")).toMatchObject({
      token: "ring/blue",
      source: "saved",
    })
    expect(icons.get("b-editable")?.source).toBe("contested")
    const saves = planAvatarSaves(agents, new Set())
    expect(saves).toEqual([
      { agentId: "b-editable", avatar: icons.get("b-editable")?.token },
    ])
    expect(saves[0].avatar).not.toBe("ring/blue")
  })
})

describe("visibilityPatch", () => {
  it("clears the icon on hide", () => {
    expect(visibilityPatch("hidden", roster(3), () => 0)).toEqual({
      visibility: "hidden",
      avatar: null,
    })
  })

  it("never picks a pair an unsaved Agent is showing on unhide", () => {
    const visible = roster(40)
    const shown = new Set(tokens(visible).values())
    for (const draw of [0, 0.3, 0.6, 0.999]) {
      const patch = visibilityPatch("visible", visible, () => draw)
      expect(patch.visibility).toBe("visible")
      expect(shown.has(patch.avatar as string)).toBe(false)
      expect(parseAvatar(patch.avatar as string).known).toBe(true)
    }
  })

  it("takes the only free pair when 271 are shown", () => {
    const visible = roster(271)
    const shown = new Set(tokens(visible).values())
    const patch = visibilityPatch("visible", visible, () => 0.5)
    expect(shown.has(patch.avatar as string)).toBe(false)
    expect(shown.size + 1).toBe(S * T)
  })
})
