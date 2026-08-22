# Profile dashboard maintenance

The GitHub profile uses repository-hosted SVG modules so the visual language of
the original dashboard remains intact while text stays readable inside GitHub's
fixed-width profile column.

## Files

```text
README.md
.github/assets/profile-dashboard-base.png
.github/assets/profile-banner-hq.png
.github/assets/aethrion-logo.png
.github/assets/profile-dashboard.svg
.github/assets/profile-stats.json
.github/assets/modules/*.svg
.github/workflows/profile-dashboard.yml
scripts/render-profile.mjs
```

`profile-dashboard-base.png` is the immutable reference artwork.
`aethrion-logo.png` is a **derivative**: the AETHRION project logo, trimmed of
its transparent margin and resized to 320 px wide for the project card. The
canonical logo lives in the AETHRION repository at
`docs/assets/branding/aethrion-logo.png` and is not edited here; if it changes,
regenerate this derivative rather than editing it.
`profile-dashboard.svg` remains the full-size fallback. The `modules` directory
contains the readable layout used by `README.md`: a full-width banner, larger
profile copy, a separate focus-area grid, full-width project cards, separate
technology-logo and tooling panels, and separate live metrics and language
panels. The title uses a neon pulse, the role strip slides continuously, and
GitHub/LinkedIn are separate linked modules.

## Project cards

Cards are generated from the `projects` array in `scripts/render-profile.mjs`.
Each entry supplies a title, two description lines, tag pills and an accent
colour, and gets its 112×112 icon one of two ways:

- `icon: { cropX, cropY, cropWidth, cropHeight }` — crop the icon out of the
  shared dashboard artwork, which is how the original cards work.
- `logoKey: "<name>"` — draw a standalone logo whole, from the map built in
  `renderModules`. Used by the AETHRION card so its identity is the real logo
  rather than a rectangle sampled from someone else's picture.

**Do not edit `modules/project-*.svg` by hand.** The refresh workflow rewrites
every module from the generator, so a hand edit survives at most six hours.
Change the generator, then run the local preview below.

## Automatic refresh

> **Known gap.** The workflow rebuilds on changes to
> `profile-dashboard-base.png` and `render-profile.mjs`, but **not** on
> `aethrion-logo.png`, so replacing that logo does not rebuild the card it
> appears in. Add `- ".github/assets/aethrion-logo.png"` to the workflow's
> `paths:` list to close it; until then, trigger **Refresh profile dashboard**
> manually from the Actions tab after changing the logo.

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
