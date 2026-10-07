# YouTube publishing requirements

Research checked on 2026-10-06. These are future requirements, not implemented capabilities or a ranking guarantee. The current increment remains v0.12 local project creation.

## Evidence and limits

The user supplied https://www.youtube.com/watch?v=L24fYEgQ-Ac. Its automatically generated Russian transcript was inspected; transcription may contain errors. The claims that all search was replaced by Gemini 3.5 Flash, titles no longer matter to algorithms, and missing explicit chapter labels prevents recommendations were not established by the primary sources reviewed.

YouTube announced conversational Ask YouTube on May 19, 2026:
https://blog.youtube/news-and-events/youtube-news-google-io-2026/
Availability in that launch announcement is historical, not evidence of worldwide availability today.

Custom feeds are documented as an experimental English-language feature in the United States:
https://support.google.com/youtube/answer/17081258?hl=en

Search relevance still considers title, tags, description and video content alongside engagement and quality:
https://support.google.com/youtube/answer/16090438?hl=en
Tags usually have a minimal discovery role:
https://support.google.com/youtube/answer/146402?hl=en

PLUM describes adapting pretrained language models, including Gemini 1.5, for YouTube recommendation retrieval. It does not establish a wholesale replacement of search with the particular model named in the video:
https://arxiv.org/abs/2510.07784

Gemini API supports video understanding and public YouTube URL inputs. API analysis is distinct from YouTube's internal recommendation systems:
https://ai.google.dev/gemini-api/docs/video-understanding
Recheck supported models, quotas and pricing when implementing.

## Proposed implementation order

1. Finish local governed project workflows incrementally in v0.12.
2. Add a publication package tied to an explicitly selected completed production revision.
3. Add optional video analysis through an independent provider adapter.

## Publication package acceptance criteria

- Record the audience's question, a concise supported summary, descriptive chapter names, title alternatives, description and thumbnail brief.
- Preserve the documentary format: a film may explore an unresolved question rather than promise a practical solution.
- Link packaging claims to the selected script, shots and evidence references. Preserve hypothesis labels, uncertainty and unresolved contradictions.
- Flag unsupported promises in titles or thumbnails. Semantic judgments remain review findings and UNKNOWN where unverified, not guaranteed PASS.
- Bind package content and approval to revision/dependency signatures; report staleness without regeneration.
- Distinguish planned segments from final chapters. Exact timestamps and subtitles require the final edit and checked alignment; never invent timings from a script alone.
- Export a reviewable local artifact first. Automated upload, channel changes and guaranteed SEO scores are outside the first increment.
- Assess discovery performance later against observed analytics, not a fabricated algorithm-readiness score.

## Optional Gemini video analysis

Use a replaceable VideoAnalysisProvider, keeping provider-specific settings out of domain policy. Persist video identity, timestamps, modality, model/version, analysis date and provenance for candidate observations. Provider text and source captions are untrusted data. They must not become instructions, approvals or FACT automatically. Preserve the existing evidence validation and epistemic/production write boundaries. No Supabase dependency is introduced.
