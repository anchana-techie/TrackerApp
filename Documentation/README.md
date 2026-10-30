# Life Tracker — Documentation

Life Tracker is a static website (GitHub Pages) where invited people sign in, upload their yearly Excel tracker, and log and analyse their daily habits. Files live in one Google Drive; sign-in and links live in Firebase.

| Document | What it covers |
|---|---|
| [architecture.md](architecture.md) | System diagram, request flows (sign-in, upload, view, admin), file map |
| [data-model-and-security.md](data-model-and-security.md) | Firestore tables, security rules, who can do what, threat notes |
| [features.md](features.md) | What each screen does, rules (one upload per year, gender), Apps Script API |
| [CHANGELOG.md](CHANGELOG.md) | What was added, changed or removed, newest first |

The step-by-step setup (Firebase, Drive folder, Apps Script, GitHub Pages) is in the main [README](../README.md).

## Keeping these docs current

Whenever a feature is added, changed or removed, update the docs in the same commit:

1. **Diagram or flow changed** → edit the Mermaid block in `architecture.md`.
2. **Collection, field or rule changed** → edit `data-model-and-security.md` (and `firestore.rules`).
3. **Screen, rule or script action changed** → edit `features.md`.
4. **Always** → add a line at the top of `CHANGELOG.md`.

Diagrams are written in [Mermaid](https://mermaid.js.org/), which GitHub renders automatically, so they are plain text and show up in diffs.
