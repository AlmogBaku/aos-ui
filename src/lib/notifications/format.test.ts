import { expect, it } from "vitest"

import { formatNotification, type NotificationContent } from "./format"

/** U+2068 … U+2069: how every embedded piece is isolated. */
const iso = (text: string) => `\u2068${text}\u2069`
const named = {
  agentName: "Travel Planner",
  sessionTitle: "Lisbon trip in May",
  locale: "en",
} as const

it.each<[string, NotificationContent, { title: string; body: string }]>([
  [
    "an input request leads with its phrase and the Session",
    { ...named, category: "input" },
    {
      title: "Travel Planner",
      body: `Needs your input · ${iso("Lisbon trip in May")}`,
    },
  ],
  [
    "a failure",
    { ...named, category: "failure" },
    {
      title: "Travel Planner",
      body: `Turn failed · ${iso("Lisbon trip in May")}`,
    },
  ],
  [
    "a completion",
    { ...named, category: "completion" },
    {
      title: "Travel Planner",
      body: `Finished · ${iso("Lisbon trip in May")}`,
    },
  ],
  [
    "the Session as the title when the Agent is unnamed, never twice",
    { category: "input", sessionTitle: "Lisbon trip in May", locale: "en" },
    { title: "Lisbon trip in May", body: "Needs your input" },
  ],
  [
    "the product as the title when neither is named",
    { category: "failure", locale: "en" },
    { title: "AOS", body: "Turn failed" },
  ],
  [
    "what is asked on a second line, with how many follow",
    {
      ...named,
      category: "input",
      requestText: "Which dates work for you?",
      requestMore: 2,
    },
    {
      title: "Travel Planner",
      body: `Needs your input · ${iso("Lisbon trip in May")}\n${iso("Which dates work for you?")} +2 more`,
    },
  ],
  [
    "Hebrew around English and Hebrew pieces, each isolated",
    {
      category: "input",
      agentName: "Travel Planner",
      sessionTitle: "טיול לליסבון",
      requestText: "Book the refundable fare?",
      requestMore: 1,
      locale: "he",
    },
    {
      title: "Travel Planner",
      body: `נדרשת תשובה שלכם · ${iso("טיול לליסבון")}\n${iso("Book the refundable fare?")} ועוד 1`,
    },
  ],
  [
    "dollar patterns kept as written",
    {
      ...named,
      category: "input",
      sessionTitle: "Budget $' and $&",
      requestText: "Spend $1 or $`?",
      requestMore: 3,
    },
    {
      title: "Travel Planner",
      body: `Needs your input · ${iso("Budget $' and $&")}\n${iso("Spend $1 or $`?")} +3 more`,
    },
  ],
  [
    "names flattened to one line",
    {
      category: "completion",
      agentName: "Travel\nPlanner",
      sessionTitle: "Lisbon\t\ttrip",
      locale: "en",
    },
    { title: "Travel Planner", body: `Finished · ${iso("Lisbon trip")}` },
  ],
  [
    "a malformed piece dropping its line, and a malformed count only itself",
    {
      category: "input",
      agentName: "Travel Planner",
      sessionTitle: " \u0007 ",
      requestText: "Proceed?\u2069\u202E",
      requestMore: 0.5,
      locale: "en",
    },
    { title: "Travel Planner", body: `Needs your input\n${iso("Proceed?")}` },
  ],
])("formats %s", (_rule, content, expected) => {
  expect(formatNotification(content)).toEqual(expected)
})
