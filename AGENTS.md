# Pumpkin Kitchen

Read README.md and AI-START-HERE.md. This repository has two explicit modes: a browser-only rule-driven demo, and a full local game with MCP.

Reuse src/game engine and room logic. In the full local mode the Node server is authoritative. In the static demo a dedicated Worker owns the isolated room; the UI only sends ordinary semantic messages and renders snapshots. Do not add external AI control to the static worker.

Keep the demonstration visibly labeled. Keep local MCP credentials, private conversations and machine configuration out of source and artifacts. Use the actual exposed tool schemas; connect and observe before playing, and let the human start the round.

Use focused tests for changed behavior. The browser demo must work below a repository subpath, without WebSocket calls or a backend. Preserve the Node security operations and controller lease semantics in the full local version.
