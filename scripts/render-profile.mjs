import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsDirectory = path.join(root, ".github", "assets");
const baseImagePath = path.join(assetsDirectory, "profile-dashboard-base.png");
const outputSvgPath = path.join(assetsDirectory, "profile-dashboard.svg");
const outputStatsPath = path.join(assetsDirectory, "profile-stats.json");

const username =
  process.env.PROFILE_USERNAME ||
  process.env.GITHUB_REPOSITORY_OWNER ||
  "furkanhanilci";
const token = process.env.GITHUB_TOKEN;
const offline = process.argv.includes("--offline");

const API_ROOT = "https://api.github.com";
const requestHeaders = {
  Accept: "application/vnd.github+json",
  "User-Agent": `${username}-profile-dashboard`,
  "X-GitHub-Api-Version": "2022-11-28",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

const fallbackStats = {
  username,
  stars: 150,
  commits: 1200,
  repositories: 23,
  languages: [
    { name: "Python", bytes: 47 },
    { name: "C++", bytes: 25 },
    { name: "C", bytes: 10 },
    { name: "MATLAB", bytes: 9 },
    { name: "Others", bytes: 9 },
  ],
};

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function compactNumber(value) {
  const number = Number(value) || 0;
  if (number < 1_000) return String(number);

  const divisor = number >= 1_000_000 ? 1_000_000 : 1_000;
  const suffix = divisor === 1_000_000 ? "M" : "K";
  const roundedDown = Math.floor((number / divisor) * 10) / 10;
  const formatted = Number.isInteger(roundedDown)
    ? roundedDown.toFixed(0)
    : roundedDown.toFixed(1);
  return `${formatted}${suffix}+`;
}

async function apiResponse(route, { allowEmptyRepository = false } = {}) {
  const response = await fetch(`${API_ROOT}${route}`, {
    headers: requestHeaders,
  });

  if (allowEmptyRepository && response.status === 409) {
    return null;
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub API ${response.status} for ${route}: ${body.slice(0, 300)}`,
    );
  }

  return response;
}

async function apiJson(route, options) {
  const response = await apiResponse(route, options);
  return response ? response.json() : null;
}

async function listOwnedRepositories() {
  const repositories = [];

  for (let page = 1; ; page += 1) {
    const batch = await apiJson(
      `/users/${encodeURIComponent(username)}/repos?type=owner&sort=full_name&per_page=100&page=${page}`,
    );
    repositories.push(...batch);
    if (batch.length < 100) break;
  }

  return repositories;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, runWorker),
  );
  return results;
}

function lastPageFromLink(linkHeader) {
  if (!linkHeader) return null;
  const lastLink = linkHeader
    .split(",")
    .find((entry) => entry.includes('rel="last"'));
  if (!lastLink) return null;
  const match = lastLink.match(/[?&]page=(\d+)>/);
  return match ? Number(match[1]) : null;
}

async function repositoryMetrics(repository) {
  const fullName = repository.full_name
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  const [languages, commitResponse] = await Promise.all([
    apiJson(`/repos/${fullName}/languages`),
    apiResponse(
      `/repos/${fullName}/commits?author=${encodeURIComponent(username)}&per_page=1`,
      { allowEmptyRepository: true },
    ),
  ]);

  let commits = 0;
  if (commitResponse) {
    const body = await commitResponse.json();
    commits =
      lastPageFromLink(commitResponse.headers.get("link")) ?? body.length;
  }

  return { languages, commits };
}

function aggregateLanguages(metrics) {
  const totals = new Map();

  for (const { languages } of metrics) {
    for (const [name, bytes] of Object.entries(languages || {})) {
      totals.set(name, (totals.get(name) || 0) + Number(bytes));
    }
  }

  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 4).map(([name, bytes]) => ({ name, bytes }));
  const otherBytes = sorted
    .slice(4)
    .reduce((sum, [, bytes]) => sum + bytes, 0);

  if (otherBytes > 0) {
    top.push({ name: "Others", bytes: otherBytes });
  }

  return top.length ? top : fallbackStats.languages;
}

async function collectStats() {
  if (offline) return fallbackStats;

  const [user, allRepositories] = await Promise.all([
    apiJson(`/users/${encodeURIComponent(username)}`),
    listOwnedRepositories(),
  ]);
  const originalRepositories = allRepositories.filter(
    (repository) => !repository.fork && !repository.archived,
  );
  const metrics = await mapWithConcurrency(
    originalRepositories,
    6,
    repositoryMetrics,
  );

  return {
    username,
    stars: originalRepositories.reduce(
      (sum, repository) => sum + repository.stargazers_count,
      0,
    ),
    commits: metrics.reduce((sum, item) => sum + item.commits, 0),
    repositories: user.public_repos,
    languages: aggregateLanguages(metrics),
  };
}

function languageArtwork(languages) {
  const palette = ["#3aa5eb", "#e94b9a", "#8d60d8", "#f29a38", "#96a1ad"];
  const displayNames = {
    "Jupyter Notebook": "Jupyter",
    JavaScript: "JS",
    TypeScript: "TS",
    "Objective-C": "Obj-C",
    "Objective-C++": "Obj-C++",
  };
  const total = languages.reduce((sum, language) => sum + language.bytes, 0);
  const barX = 832;
  const barY = 547;
  const barWidth = 204;
  let cursor = barX;

  const segments = languages
    .map((language, index) => {
      const width =
        index === languages.length - 1
          ? barX + barWidth - cursor
          : Math.max(2, (language.bytes / total) * barWidth);
      const segment = `<rect x="${cursor.toFixed(2)}" y="${barY}" width="${width.toFixed(2)}" height="5" rx="2.5" fill="${palette[index]}"/>`;
      cursor += width;
      return segment;
    })
    .join("");

  let legendX = 834;
  const legend = languages
    .map((language, index) => {
      const shortName =
        displayNames[language.name] ||
        (language.name.length > 8
          ? `${language.name.slice(0, 7)}…`
          : language.name);
      const label = escapeXml(shortName);
      const item = [
        `<circle cx="${legendX}" cy="567" r="2.5" fill="${palette[index]}"/>`,
        `<text x="${legendX + 7}" y="570" class="legend">${label}</text>`,
      ].join("");
      legendX += Math.max(34, shortName.length * 4.7 + 15);
      return item;
    })
    .join("");

  return `${segments}${legend}`;
}

function renderSvg(baseImage, stats) {
  const embeddedImage = `data:image/png;base64,${baseImage.toString("base64")}`;
  const stars = escapeXml(compactNumber(stats.stars));
  const commits = escapeXml(compactNumber(stats.commits));
  const repositories = escapeXml(compactNumber(stats.repositories));

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-labelledby="title description">
  <title id="title">Furkan Hanilçi — Autonomous Systems</title>
  <desc id="description">Autonomous vehicle development, artificial intelligence, robotics, selected projects, technology stack and live GitHub statistics.</desc>
  <image width="1200" height="630" href="${embeddedImage}"/>
  <style>
    .value {
      fill: #eef5fb;
      font: 700 15px "Segoe UI", Inter, Arial, sans-serif;
      letter-spacing: 0.2px;
    }
    .legend {
      fill: #aeb8c5;
      font: 600 7px "Segoe UI", Inter, Arial, sans-serif;
    }
  </style>

  <!-- Live values are painted over the matching cells in the base artwork. -->
  <g id="live-github-stats">
    <rect x="562" y="546" width="48" height="21" rx="2" fill="#07111c"/>
    <text x="566" y="562" class="value">${stars}</text>

    <rect x="656" y="546" width="51" height="21" rx="2" fill="#07111c"/>
    <text x="660" y="562" class="value">${commits}</text>

    <rect x="750" y="546" width="53" height="21" rx="2" fill="#07111c"/>
    <text x="754" y="562" class="value">${repositories}</text>

    <rect x="829" y="543" width="216" height="31" rx="3" fill="#07111c"/>
    ${languageArtwork(stats.languages)}
  </g>
</svg>
`;
}

await mkdir(assetsDirectory, { recursive: true });
const [baseImage, stats] = await Promise.all([
  readFile(baseImagePath),
  collectStats(),
]);

await Promise.all([
  writeFile(outputSvgPath, renderSvg(baseImage, stats), "utf8"),
  writeFile(outputStatsPath, `${JSON.stringify(stats, null, 2)}\n`, "utf8"),
]);

console.log(
  `Rendered ${path.relative(root, outputSvgPath)} for @${username}: ` +
    `${stats.stars} stars, ${stats.commits} commits, ` +
    `${stats.repositories} public repositories.`,
);
