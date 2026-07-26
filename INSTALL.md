# Profile dashboard maintenance

The GitHub profile uses repository-hosted SVG modules so the visual language of
the original dashboard remains intact while text stays readable inside GitHub's
fixed-width profile column.

## Files

```text
README.md
.github/assets/profile-dashboard-base.png
.github/assets/profile-dashboard.svg
.github/assets/profile-stats.json
.github/assets/modules/*.svg
.github/workflows/profile-dashboard.yml
scripts/render-profile.mjs
```

`profile-dashboard-base.png` is the immutable reference artwork.
`profile-dashboard.svg` remains the full-size fallback. The `modules` directory
contains the readable layout used by `README.md`: a full-width banner, larger
profile copy, two-column project cards, a full-width technology panel, and a
full-width live statistics panel. The title uses a neon pulse, the role strip
slides continuously, and GitHub/LinkedIn are separate linked modules.

## Automatic refresh

The **Refresh profile dashboard** workflow runs every six hours and can also be
started manually from the Actions tab. It calculates:

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
profile READMEs. The design therefore uses separate linked SVG modules. This
preserves the artwork and logos, makes each project card clickable, removes
unused side margins, and prevents GitHub from shrinking all copy into one image.
