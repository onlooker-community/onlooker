import type { PluginData } from './types';

export const cartographer: PluginData = {
  slug: 'cartographer',
  name: 'Cartographer',
  version: '0.2.0',
  tagline: 'Your instruction files are a codebase. Audit them like one.',
  category: 'analysis',

  hero: {
    headline: 'Your CLAUDE.md files are contradicting each other.',
    subheadline:
      'Cartographer audits every instruction file in your project and surfaces contradictions, dead rules, stale references, and scope collisions — before they cause expensive agent misbehavior.',
  },

  problem:
    'You have a CLAUDE.md at the root, more in subdirectories, AGENTS.md files, and .claude/rules/. They\'ve grown organically. A rule written last year shadows a more specific rule you wrote last week. Two rules silently contradict each other. A reference points to a file that no longer exists. Nobody knows — until the agent does something wrong.',

  howItWorks: [
    'Collect — discovers every instruction file in the repo',
    'Extract — builds a semantic map of each file\'s rules using Haiku',
    'Synthesize — compares maps across files, identifies conflicts and gaps',
    'Surface — findings available via /cartographer or the event log',
  ],

  tables: [
    {
      title: 'Finding types',
      headers: ['Finding', 'What it means'],
      rows: [
        ['contradiction', 'Two rules that cannot both be satisfied simultaneously'],
        ['dead_rule', 'A rule fully subsumed by a more specific rule elsewhere'],
        ['stale_ref', 'A reference to a file path, tool, or command that no longer exists'],
        [
          'scope_collision',
          'A project rule that silently overrides a global ~/.claude/CLAUDE.md rule',
        ],
      ],
    },
  ],

  capabilities: [
    'Background audit — runs detached; your session is never blocked',
    'On-demand via /cartographer — full audit, scoped audit, or single-phase',
    '24-hour interval — configurable; force-run anytime',
    'Scope filtering — audit just src/ or any subdirectory',
    'Event log integration — findings emit cartographer.issue.found events',
  ],

  events: [
    {
      type: 'cartographer.issue.found',
      when: 'A finding is detected during audit',
      keyFields: 'finding_type, file, description, severity',
    },
  ],

  tags: ['instructions', 'CLAUDE.md', 'AGENTS.md', 'audit', 'rules', 'contradictions', 'drift'],

  skillCommands: `/cartographer              # full audit, foreground
/cartographer --scope=src/ # scoped to a subdirectory
/cartographer --status     # last run time + running state
/cartographer --force      # restart a running audit`,
};
