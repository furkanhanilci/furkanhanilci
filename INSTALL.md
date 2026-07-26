# Installation

Copy every file in this package to the root of the `furkanhanilci/furkanhanilci` profile repository, preserving paths.

```text
README.md
.github/assets/*.svg
.github/workflows/update-profile-stats.yml
scripts/render_profile_stats.py
```

Then open **Actions → Update profile statistics → Run workflow** once. The workflow will refresh `.github/assets/stats-panel.svg` daily using the repository's built-in `GITHUB_TOKEN`.

Required repository setting:

- **Settings → Actions → General → Workflow permissions → Read and write permissions**

The project cards in the README remain individually clickable because they are separate SVG assets wrapped in links.
