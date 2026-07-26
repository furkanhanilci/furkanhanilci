# Profile dashboard maintenance

The GitHub profile uses one repository-hosted SVG so the composition remains
pixel-accurate in GitHub's sanitized README renderer.

## Files

```text
README.md
.github/assets/profile-dashboard-base.png
.github/assets/profile-dashboard.svg
.github/assets/profile-stats.json
.github/workflows/profile-dashboard.yml
scripts/render-profile.mjs
```

`profile-dashboard-base.png` is the immutable reference artwork.
`profile-dashboard.svg` embeds that artwork and adds the live statistics layer.

## Automatic refresh

The **Refresh profile dashboard** workflow runs daily and can also be started
manually from the Actions tab. It calculates:

- stars earned by original, non-archived public repositories
- authored commits on the default branches of those repositories
- public repository count
- language distribution by repository byte counts

The workflow uses the built-in `GITHUB_TOKEN`; no external card service or
additional secret is required.

The repository must allow GitHub Actions to write:

**Settings → Actions → General → Workflow permissions → Read and write permissions**

## Local preview

Generate a deterministic preview without network access:

```powershell
node scripts/render-profile.mjs --offline
```

Run without `--offline` and provide `GITHUB_TOKEN` to use live GitHub data.

## GitHub rendering limitation

Arbitrary CSS, JavaScript, and coordinate-based image maps are not available in
profile READMEs. The entire dashboard is therefore one linked SVG; this preserves
the exact requested layout, logos, and artwork across GitHub themes.
