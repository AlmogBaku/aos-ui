from pathlib import Path
import markdown

base = Path(__file__).parent
source = base / "2026-09-07_130401-hermes-runtime-and-harness-inbound-sessions.md"
svg = base / "2026-09-07_130401-hermes-runtime-and-harness-inbound-sessions.architecture.svg"
out = base / "2026-09-07_130401-hermes-runtime-and-harness-inbound-sessions.html"

md = source.read_text(encoding="utf-8")
# The executive opening below renders the source's title, execution instruction,
# goal, architecture, and stack in a more scannable form; retain every later plan section verbatim.
start = md.index("## Decisions locked before implementation")
plan_md = md[start:]
# The canonical source intentionally keeps its task labels tight. Markdown needs
# a blank separator before its following list to retain the actual list structure.
for label in ("**Files:**", "**Steps:**", "**Tests:**"):
    plan_md = plan_md.replace(label + "\n", label + "\n\n")
body = markdown.markdown(plan_md, extensions=["fenced_code", "tables", "sane_lists"])
diagram = svg.read_text(encoding="utf-8").replace("\n", "")

html = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hermes Runtime + Harness-Initiated Sessions — Implementation Plan</title>
<style>
@page {{ size: A4; margin: 13mm 13mm 15mm 13mm; }}
* {{ box-sizing:border-box }} html {{ color:#172033; font-family:Inter,Arial,sans-serif; font-size:10.2pt; }}
body {{ margin:0; line-height:1.48; }}
header {{ border-bottom:4px solid #001F5C; padding:0 0 13px; margin:0 0 18px; }}
.eyebrow {{ color:#42618f; font-size:8.3pt; font-weight:800; letter-spacing:1.4px; text-transform:uppercase; margin:0 0 6px; }}
h1 {{ color:#001F5C; font-size:25pt; line-height:1.08; margin:0; letter-spacing:-.5px; }}
.subtitle {{ color:#536277; font-size:11.5pt; margin:8px 0 0; }}
.exec {{ background:#f4f7fb; border-left:5px solid #001F5C; padding:14px 16px 13px; margin:0 0 18px; break-inside:avoid; }}
.exec h2 {{ border:0; color:#001F5C; font-size:13.4pt; margin:0 0 8px; padding:0; }}
.exec p {{ margin:6px 0; }} .exec strong {{ color:#001F5C; }}
.diagram-wrap {{ margin:18px 0 20px; break-inside:avoid; }}
.diagram-wrap svg {{ display:block; width:100%; height:auto; border-radius:10px; }}
.caption {{ color:#536277; font-size:8.8pt; margin:6px 0 0; }}
h2 {{ color:#001F5C; font-size:15.5pt; line-height:1.2; border-bottom:1.5px solid #b8c9df; padding:12px 0 6px; margin:24px 0 11px; break-after:avoid; }}
h3 {{ color:#173b70; font-size:11.5pt; margin:16px 0 7px; break-after:avoid; }}
p {{ margin:7px 0 9px; }} ul,ol {{ padding-left:20px; margin:7px 0 11px; }} li {{ margin:4px 0; }}
li::marker {{ color:#28558f; font-weight:700; }}
strong {{ color:#162e55; }} blockquote {{ margin:9px 0 14px; padding:9px 13px; background:#fff8e6; border-left:4px solid #c8890a; color:#594619; }}
code {{ font-family:"SFMono-Regular",Consolas,monospace; font-size:8.8pt; color:#182b45; background:#eef2f7; padding:1px 3px; border-radius:3px; }}
pre {{ background:#081525; color:#e5edf8; padding:11px 13px; border-radius:6px; overflow-wrap:anywhere; white-space:pre-wrap; font-size:8.4pt; line-height:1.38; break-inside:avoid; }} pre code {{ color:inherit; background:transparent; padding:0; }}
h2 + ul, h2 + ol, h3 + ul, h3 + ol {{ break-before:avoid; }}
hr {{ border:0; border-top:1px solid #d4dfed; margin:18px 0; }}
.footer {{ color:#607088; border-top:1px solid #cbd7e6; margin-top:20px; padding-top:8px; font-size:8.2pt; }}
@media print {{ a {{ color:inherit; text-decoration:none; }} }}
</style></head><body>
<header><p class="eyebrow">Internal product &amp; architecture plan</p><h1>Hermes Runtime + Harness-Initiated Sessions</h1><p class="subtitle">Implementation plan · canonical source preserved · 7 September 2026</p></header>
<section class="exec"><h2>Executive opening</h2><p><strong>Goal.</strong> Add Hermes as a fourth, production-capable AOS runtime and let a trusted harness create real persisted Hermes conversations that appear in AOS without fabricating ownership or browser state.</p><p><strong>Agent model.</strong> Hermes Profiles—not personas—are isolated agents: each allowlisted Profile has its own config, skills, memory, state, credentials, and sessions. AOS maps each stable Profile slug to one immutable AOS Agent ID; it never collapses them into a fabricated default agent.</p><p><strong>Architecture.</strong> Hermes is authoritative for sessions, transcript, runs, and cancellation. AOS resolves the selected Agent to exactly one Profile, profile-scoped API route, and server-only key; the protected inbound endpoint creates and confirms a session under that Profile, then returns its opaque ID and AOS route. The browser discovers it from the provider-owned catalog.</p><p><strong>Locked execution instruction.</strong> Use <code>subagent-driven-development</code> task-by-task; preserve the three existing runtimes.</p><p><strong>Stack.</strong> Next.js 16 · React 19 · Assistant UI React 0.15.18/Core 0.3.17 · Hermes API Server v0.21 · Zod · Vitest · Testing Library · Playwright.</p></section>
<section class="diagram-wrap">{diagram}<p class="caption">Figure 1. The authenticated ingress and proxy meet Hermes on the server; provider list/get responses are the evidence a new session belongs in AOS.</p></section>
{body}
<div class="footer">Canonical implementation plan · Internal architecture artifact · Source: 2026-09-07_130401-hermes-runtime-and-harness-inbound-sessions.md</div>
</body></html>'''
out.write_text(html, encoding="utf-8")
print(out)
