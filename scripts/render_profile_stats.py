#!/usr/bin/env python3
# Render the dynamic GitHub statistics panel used by the profile README.

from __future__ import annotations

import json
import os
import urllib.request
from collections import Counter
from pathlib import Path
from xml.sax.saxutils import escape

USERNAME = os.environ.get("PROFILE_USERNAME", "furkanhanilci")
TOKEN = os.environ["GITHUB_TOKEN"]
OUTPUT = Path(".github/assets/stats-panel.svg")


def request_json(url: str, *, method: str = "GET", payload: dict | None = None) -> dict | list:
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {TOKEN}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "profile-readme-stats",
    }
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, headers=headers, method=method, data=data)
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def get_repositories() -> list[dict]:
    repos: list[dict] = []
    page = 1
    while True:
        batch = request_json(
            f"https://api.github.com/users/{USERNAME}/repos"
            f"?type=owner&sort=updated&per_page=100&page={page}"
        )
        assert isinstance(batch, list)
        repos.extend(batch)
        if len(batch) < 100:
            return repos
        page += 1


def get_commit_contributions() -> int:
    query = '''
    query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          totalCommitContributions
        }
      }
    }
    '''
    response = request_json(
        "https://api.github.com/graphql",
        method="POST",
        payload={"query": query, "variables": {"login": USERNAME}},
    )
    return int(
        response["data"]["user"]["contributionsCollection"]["totalCommitContributions"]
    )


def language_totals(repos: list[dict]) -> Counter[str]:
    totals: Counter[str] = Counter()
    for repo in repos:
        if repo.get("fork") or repo.get("archived"):
            continue
        languages = request_json(repo["languages_url"])
        assert isinstance(languages, dict)
        for language, byte_count in languages.items():
            totals[language] += int(byte_count)
    return totals


def compact(value: int) -> str:
    if value >= 1_000_000:
        return f"{value / 1_000_000:.1f}M"
    if value >= 1_000:
        return f"{value / 1_000:.1f}K"
    return str(value)


def render_svg(stars: int, commits: int, repositories: int, languages: Counter[str]) -> str:
    palette = ["#3b82f6", "#d66bc5", "#8b5cf6", "#ff8a1f", "#52687c"]
    top = languages.most_common(5)
    total = sum(value for _, value in top) or 1

    segments: list[str] = []
    labels: list[str] = []
    x = 476.0
    bar_width = 342.0
    label_x = 480.0

    for index, (name, value) in enumerate(top):
        width = bar_width * value / total
        color = palette[index]
        segments.append(
            f'<rect x="{x:.1f}" y="65" width="{max(width, 2):.1f}" '
            f'height="11" rx="5.5" fill="{color}"/>'
        )
        safe_name = escape(name)
        labels.append(
            f'<circle cx="{label_x:.1f}" cy="92" r="4" fill="{color}"/>'
            f'<text x="{label_x + 9:.1f}" y="96" fill="#aeb9c7" '
            f'font-family="Inter,Segoe UI,Arial,sans-serif" font-size="10">{safe_name}</text>'
        )
        x += width
        label_x += min(78, 22 + len(name) * 7)

    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="860" height="124" viewBox="0 0 860 124" role="img" aria-labelledby="title desc">
  <title id="title">GitHub statistics</title>
  <desc id="desc">Automatically refreshed profile metrics and language distribution.</desc>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#020a14"/>
      <stop offset="1" stop-color="#071421"/>
    </linearGradient>
  </defs>
  <rect x="1" y="1" width="858" height="122" rx="10" fill="url(#bg)" stroke="#16324a"/>
  <text x="24" y="18" fill="#36d6ff" font-family="monospace" font-size="14" letter-spacing="2">GITHUB STATS</text>
  <line x1="150" y1="14" x2="838" y2="14" stroke="#16324a"/>

  <g font-family="Inter,Segoe UI,Arial,sans-serif">
    <g transform="translate(22 31)">
      <rect width="130" height="76" rx="8" fill="#06111e" stroke="#19354d"/>
      <text x="16" y="27" fill="#9a6bff" font-size="22">★</text>
      <text x="48" y="22" fill="#aeb9c7" font-size="11">TOTAL STARS</text>
      <text x="48" y="51" fill="#eef4fa" font-size="23" font-weight="600">{compact(stars)}</text>
    </g>
    <g transform="translate(164 31)">
      <rect width="144" height="76" rx="8" fill="#06111e" stroke="#19354d"/>
      <text x="16" y="28" fill="#3b82f6" font-size="22">⌁</text>
      <text x="49" y="22" fill="#aeb9c7" font-size="11">COMMITS / YEAR</text>
      <text x="49" y="51" fill="#eef4fa" font-size="23" font-weight="600">{compact(commits)}</text>
    </g>
    <g transform="translate(320 31)">
      <rect width="126" height="76" rx="8" fill="#06111e" stroke="#19354d"/>
      <text x="16" y="28" fill="#c16cff" font-size="22">▣</text>
      <text x="49" y="22" fill="#aeb9c7" font-size="11">REPOSITORIES</text>
      <text x="49" y="51" fill="#eef4fa" font-size="23" font-weight="600">{repositories}</text>
    </g>
    <g transform="translate(458 31)">
      <rect width="380" height="76" rx="8" fill="#06111e" stroke="#19354d"/>
      <text x="18" y="21" fill="#aeb9c7" font-size="11">TOP LANGUAGES</text>
      {''.join(segments)}
      {''.join(labels)}
    </g>
  </g>
</svg>
'''


def main() -> None:
    repos = get_repositories()
    visible = [repo for repo in repos if not repo.get("fork")]
    stars = sum(int(repo.get("stargazers_count", 0)) for repo in visible)
    commits = get_commit_contributions()
    languages = language_totals(visible)
    svg = render_svg(stars, commits, len(repos), languages)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(svg, encoding="utf-8")


if __name__ == "__main__":
    main()
