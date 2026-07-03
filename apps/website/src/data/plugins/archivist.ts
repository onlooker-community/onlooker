import type { PluginData } from './types';

export const archivist: PluginData = {
  slug: 'archivist',
  name: 'Archivist',
  version: '0.1.0',
  tagline: 'Memory that survives context truncation.',
  category: 'memory',

  hero: {
    headline: 'Your agent forgets. Archivist doesn\'t.',
    subheadline:
      'Structured session memory that persists across context compaction — so the next session picks up where the last one left off.',
  },

  problem:
    'Claude Code has a context window. When it fills and compacts, decisions made three hours ago vanish. The agent starts fresh, relitigates closed questions, and re-makes mistakes you already corrected.',

  howItWorks: [
    'On compaction (PreCompact / PostCompact) — Archivist extracts the most important items from the current context: decisions made, approaches ruled out, open questions still in flight.',
    'On session start (SessionStart) — Archivist re-injects the top-ranked items from prior sessions into the new context, ordered by recency and importance.',
  ],

  capabilities: [
    'Extracts three artifact kinds: decisions, dead ends, open questions',
    'Ranked re-injection — pinned items surface first; unpinned items sorted by recency',
    'Configurable item cap — control how much memory is re-injected per session',
    'Zero manual steps — runs automatically on every compaction and session start',
    'ULID-keyed storage — artifacts are time-ordered and project-scoped under ~/.onlooker/',
  ],

  config: `{
  "archivist": {
    "enabled": true,
    "injection": {
      "max_items": 5
    }
  }
}`,

  tags: ['memory', 'context', 'compaction', 'session', 'persistence', 'recall'],

  idealFor:
    'Teams where sessions span hours or days; projects where the agent makes consequential decisions that must not be re-litigated; anyone who has had an agent repeat a mistake it already made once.',
};
