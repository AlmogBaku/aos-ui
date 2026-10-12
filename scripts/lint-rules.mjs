import { readdirSync } from "node:fs"
import { dirname, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sourceRoot = resolve(projectRoot, "src")
const runtimeRoot = resolve(sourceRoot, "runtime-adapters")
const packages = new Set(
  readdirSync(runtimeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
)
const portable = (path) => path.split(sep).join("/")

// These existing UI/acceptance fixtures need deterministic native state controls.
// Exempt only the named fixture modules in these exact test-only consumers.
const fixtureTestImports = new Map([
  [
    "src/components/aos-ui-workspace.test-helpers.tsx",
    new Set(["fixture-runtime", "fixture-workspace", "composition"]),
  ],
  [
    "src/components/test-utils/controlled-workspace-fixture.tsx",
    new Set(["fixture-runtime", "fixture-workspace"]),
  ],
  [
    "src/components/workspace/manage-agents.test.tsx",
    new Set(["fixture-workspace"]),
  ],
  [
    "src/components/workspace/activity.test.tsx",
    new Set(["fixture-workspace"]),
  ],
  [
    "e2e/notifications.desktop.workspace.spec.ts",
    new Set(["fixture-activity"]),
  ],
])

function runtimePackage(filename) {
  const [name, ...rest] = portable(relative(runtimeRoot, filename)).split("/")
  return packages.has(name) ? { name, module: rest.join("/") } : undefined
}

const runtimePackageBoundaries = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      private:
        "Import {{provider}} only through its package index; provider implementations are private.",
      crossProvider:
        "Runtime provider packages must not import one another ({{from}} → {{to}}). Use shared contracts instead.",
    },
  },
  create(context) {
    const filename = context.filename
    const owner = runtimePackage(filename)
    const consumer = portable(relative(projectRoot, filename))
    function check(source, node) {
      const specifier =
        source?.type === "Literal"
          ? source.value
          : source?.type === "TemplateLiteral" &&
              source.expressions.length === 0
            ? source.quasis[0]?.value.cooked
            : undefined
      if (typeof specifier !== "string") return
      const clean = specifier.split(/[?#]/u)[0]
      const target = clean.startsWith("@/")
        ? resolve(sourceRoot, clean.slice(2))
        : clean.startsWith(".")
          ? resolve(dirname(filename), clean)
          : clean.startsWith("/src/")
            ? resolve(projectRoot, clean.slice(1))
            : undefined
      if (!target) return
      const provider = runtimePackage(target)
      if (!provider || owner?.name === provider.name) return
      if (owner) {
        context.report({
          node,
          messageId: "crossProvider",
          data: { from: owner.name, to: provider.name },
        })
        return
      }
      const module = provider.module.replace(/\.[cm]?[jt]sx?$/u, "")
      if (!module || module === "index") return
      if (
        provider.name === "fixture" &&
        fixtureTestImports.get(consumer)?.has(module)
      )
        return
      context.report({
        node,
        messageId: "private",
        data: { provider: provider.name },
      })
    }
    return {
      ImportDeclaration: (node) => check(node.source, node),
      ExportNamedDeclaration: (node) => check(node.source, node),
      ExportAllDeclaration: (node) => check(node.source, node),
      ImportExpression: (node) => check(node.source, node),
      TSImportType: (node) =>
        check(node.source ?? node.argument?.literal ?? node.argument, node),
      TSExternalModuleReference: (node) => check(node.expression, node),
      CallExpression: (node) => {
        if (node.callee.type === "Identifier" && node.callee.name === "require")
          check(node.arguments[0], node)
      },
    }
  },
}

// Tests assert behavior, never styling. Geometry and computed styles stay
// available for driving the page (pointer coordinates, finding the scroller);
// only asserting on them is banned.

/** A read of styling or geometry, banned as the subject of an `expect`. */
const styleRead =
  ":matches(CallExpression[callee.name='getComputedStyle'], CallExpression[callee.property.name=/^(getComputedStyle|boundingBox|getBoundingClientRect)$/], MemberExpression[property.name=/^(className|classList|style|offsetWidth|offsetHeight|clientWidth|clientHeight)$/])"

const styleAssertions = [
  "CallExpression[callee.property.name=/^(toHaveClass|toHaveStyle|toHaveCSS|toHaveScreenshot)$/]",
  "CallExpression[callee.property.name='toHaveAttribute'] > Literal.arguments:first-child[value=/^(class|style|data-slot)$/]",
  `CallExpression[callee.name='expect'] > ${styleRead}`,
  `CallExpression[callee.name='expect'] > * ${styleRead}`,
]

const noStyleAssertions = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      style:
        "Tests never assert styling (classes, data-slot, computed styles, geometry, screenshots); look at the rendered app instead. See AGENTS.md › Writing tests.",
    },
  },
  create(context) {
    const report = (node) => context.report({ node, messageId: "style" })
    return Object.fromEntries(
      styleAssertions.map((selector) => [selector, report])
    )
  },
}

export default {
  meta: { name: "aos" },
  rules: {
    "runtime-package-boundaries": runtimePackageBoundaries,
    "no-style-assertions": noStyleAssertions,
  },
}
