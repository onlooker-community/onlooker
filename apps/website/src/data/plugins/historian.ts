import type { PluginData } from './types';

export const historian: PluginData = {
  slug: 'historian',
  name: 'Historian',
  version: '0.1.0',
  tagline: 'Recalls past sessions when they matter.',
  category: 'memory',

  hero: {
    headline: 'We\'ve solved this before. Historian can prove it.',
    subheadline:
      'At session end, Historian chunks the transcript at turn boundaries, redacts secret-shaped substrings, and persists the chunks as append-only JSONL — so future sessions can retrieve the verbatim shape of a past conversation when the user starts a similar problem.',
  },

  problem:
    'A user hits a flaky test. The agent debugs from scratch. Three months ago the same flake was investigated, the root cause was identified, and the fix landed — all in a session whose transcript is gone. Librarian distills durable conclusions; archivist preserves session-level decisions. Neither preserves the verbatim shape of a past discussion. Without that, the dead-ends, the rejected approaches, and the actual rationale evaporate the moment the session ends.',

  howItWorks: [
    'SessionEnd — reads the full transcript at transcript_path; drops tool calls and tool results to keep semantically focused content',
    'Skips short sessions — under min_transcript_chars_to_index (default: 1200) is too short to plausibly produce a useful precedent',
    'Chunks at turn boundaries — accumulates turns up to chunk_target_chars (default: 2400) with chunk_overlap_chars (default: 400); never splits mid-turn',
    'Sanitizes — redacts secret-shaped substrings (AWS keys, bearer tokens, GitHub PATs, .env-style assignments), drops chunks tagged [historian:skip], drops chunks referencing never_index_paths',
    'Persists — one chunk per JSONL line under ~/.onlooker/historian/<project-key>/sessions/<session-id>.jsonl; append-only, so adding embeddings later is a column-add, not a re-index',
    'Emits historian.indexing.* and historian.chunk.* events along the way for downstream observability',
    'Retrieval and surfacer — UserPromptSubmit rate gate, query embedding, ANN lookup, and additionalContext injection of the top match — deferred to a follow-up landing alongside the first embedder backend',
  ],

  tables: [
    {
      title: 'What ships today vs. deferred',
      headers: ['Capability', 'Status'],
      rows: [
        ['SessionEnd indexing pipeline', 'Ships now — transcript reader, chunker, sanitizer, JSONL store'],
        ['Append-only JSONL chunk records', 'Ships now — bodies stored without vectors; adding embeddings later is a column-add'],
        ['Secret redaction + [historian:skip] markers + path-deny list', 'Ships now'],
        ['Retrieval and additionalContext surfacer', 'Deferred — UserPromptSubmit hook currently no-ops'],
        ['Embedder backends (ollama, fastembed, remote)', 'Deferred — chunks indexed without vectors until the first backend lands'],
        ['/historian recall, setup, stats, purge', 'Deferred — slash commands ship with retrieval'],
        ['Prune and purge retention sweeps', 'Deferred'],
      ],
    },
    {
      title: 'Three failure modes Historian addresses',
      headers: ['Pattern', 'What Historian recovers'],
      rows: [
        ['"We\'ve solved this exact bug before"', 'The past session\'s investigation chunks — root cause, fix, and rejected hypotheses'],
        ['"I tried X already and it didn\'t work"', 'The dead-end discussion, not just a feedback-store conclusion — the why behind the rejection'],
        ['"What was the rationale we settled on?"', 'The 40-turn tradeoff weighing that became a one-line commit message'],
      ],
    },
  ],

  capabilities: [
    'Local-first by design — ADR-001 commits to local embeddings by default; transcript content stays off the wire',
    'Turn-boundary chunking — chunks never split mid-turn; cross-chunk concepts stay intact via configurable overlap',
    'Layered sanitizer — secret pattern redaction, [historian:skip] in-band escape, and a path-deny list for "this directory should never be indexed"',
    'Append-only storage — JSONL chunk records mean adding embeddings later is a non-destructive column-add, not a full re-index',
    'Per-project scoping — each project\'s chunks live under ~/.onlooker/historian/<project-key>/sessions/',
    'Disabled by default — opt-in via historian.enabled: true',
    'Parallel to librarian — librarian distills the conclusion into the typed memory store; historian preserves the verbatim conversation shape',
  ],

  events: [
    {
      type: 'historian.indexing.complete',
      when: 'The SessionEnd indexing pipeline finishes a session',
      keyFields: 'session_id, chunks_written, redaction_count, body_chars_total',
    },
    {
      type: 'historian.indexing.skipped',
      when: 'A session is skipped — too short, disabled, or no transcript',
      keyFields: 'session_id, reason',
    },
    {
      type: 'historian.chunk.sanitized',
      when: 'A chunk had secret-shaped substrings redacted before persistence',
      keyFields: 'chunk_id, redaction_count',
    },
    {
      type: 'historian.chunk.dropped',
      when: 'A chunk was dropped entirely — [historian:skip] marker or path-deny match',
      keyFields: 'chunk_id, reason',
    },
  ],

  config: `{
  "historian": {
    "enabled": false,
    "indexing": {
      "trigger": "SessionEnd",
      "min_transcript_chars_to_index": 1200,
      "chunk_target_chars": 2400,
      "chunk_overlap_chars": 400,
      "retention_days": 365
    },
    "sanitization": {
      "redact_secret_patterns": true,
      "drop_skip_marker": true,
      "never_index_paths": []
    },
    "embedder": {
      "backend": "none"
    }
  }
}`,

  tags: [
    'memory',
    'episodic',
    'transcript',
    'recall',
    'precedent',
    'local-first',
    'embeddings',
    'session',
  ],

  idealFor:
    'Repos where the same class of problem recurs — flaky tests, gnarly migrations, perf hotspots — and a past session likely already explored the answer; teams that want precedent recall without sending transcripts to a remote API; anyone who has watched the agent re-explore a dead-end the user already ruled out three weeks ago.',
};
