// node --experimental-strip-types web/scripts/sync-agent-registry.mjs [--check]
// Native defaults are compiled Swift, generated from the same registry as web/server/CLI.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AGENTS, AGENT_IDS } from '../src/shared/agents.ts';

const root = new URL('../../', import.meta.url);
const quoted = (s) => JSON.stringify(s);
const targets = [
  ['mac/Untether/Core/Services/ConfigManager.swift', 8, AGENT_IDS.map((id) => `QuickStartCommand(name: ${quoted(AGENTS[id].label)}, command: ${quoted(AGENTS[id].executable)}),`)],
  ['ios/Untether/Views/Sessions/SessionCreateView.swift', 12, AGENT_IDS.map((id) => `QuickStartItem(title: ${quoted(AGENTS[id].label)}, command: ${quoted(AGENTS[id].executable)}, icon: "sparkle"),`)],
  ['mac/Untether/Core/Models/SessionDisplay.swift', 4, [
    'static let agentIds: [String: String] = [',
    ...AGENT_IDS.map((id) => `    ${quoted(AGENTS[id].executable)}: ${quoted(id)},`),
    ']',
  ]],
];
for (const [file, spaces, lines] of targets) {
  const p = fileURLToPath(new URL(file, root));
  const before = fs.readFileSync(p, 'utf8');
  const indent = ' '.repeat(spaces);
  const block = `${indent}// BEGIN GENERATED AGENTS\n${indent}// web/src/shared/agents.ts — run web/scripts/sync-agent-registry.mjs\n${lines.map((line) => indent + line).join('\n')}\n${indent}// END GENERATED AGENTS`;
  const after = before.replace(/^ *\/\/ BEGIN GENERATED AGENTS[\s\S]*?^ *\/\/ END GENERATED AGENTS/m, block);
  if (!before.includes('// BEGIN GENERATED AGENTS')) throw new Error(`Missing marker: ${file}`);
  if (process.argv.includes('--check')) {
    if (after !== before) throw new Error(`Agent registry mirror is stale: ${file}`);
  } else if (before !== after) fs.writeFileSync(p, after);
}
console.log('Agent registry: native mirrors match');
