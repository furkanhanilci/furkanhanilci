import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsDirectory = path.join(root, ".github", "assets");
const modulesDirectory = path.join(assetsDirectory, "modules");
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
  if (offline) {
    try {
      return JSON.parse(await readFile(outputStatsPath, "utf8"));
    } catch {
      return fallbackStats;
    }
  }

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
`.replace(/[ \t]+$/gm, "");
}

function svgDocument({ width, height, title, description, body }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(title)}</title>
  <desc id="description">${escapeXml(description)}</desc>
  <defs>
    <linearGradient id="panel-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#020a14"/>
      <stop offset="1" stop-color="#071421"/>
    </linearGradient>
    <linearGradient id="cyan-line" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#36d6ff"/>
      <stop offset="1" stop-color="#16324a"/>
    </linearGradient>
  </defs>
  <style>
    .heading {
      fill: #36d6ff;
      font: 700 13px "Segoe UI", Inter, Arial, sans-serif;
      letter-spacing: 2.2px;
    }
    .title {
      fill: #f2f7fb;
      font: 700 18px "Segoe UI", Inter, Arial, sans-serif;
    }
    .copy {
      fill: #c7d2de;
      font: 500 13px "Segoe UI", Inter, Arial, sans-serif;
    }
    .muted {
      fill: #91a1b3;
      font: 600 11px "Segoe UI", Inter, Arial, sans-serif;
    }
    .mono {
      fill: #d8e5ef;
      font: 500 14px "Cascadia Mono", "Segoe UI Mono", Consolas, monospace;
      letter-spacing: 0.25px;
    }
  </style>
  ${body}
</svg>
`.replace(/[ \t]+$/gm, "");
}

function panelBackdrop(width, height, radius = 10) {
  return `<rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="${radius}" fill="url(#panel-bg)" stroke="#19354d"/>`;
}

function croppedArtwork(
  embeddedImage,
  { cropX, cropY, cropWidth, cropHeight, x, y, width, height, fit = "xMidYMid slice" },
) {
  return `<svg x="${x}" y="${y}" width="${width}" height="${height}" viewBox="${cropX} ${cropY} ${cropWidth} ${cropHeight}" preserveAspectRatio="${fit}" overflow="hidden">
    <image width="1200" height="630" href="${embeddedImage}"/>
  </svg>`;
}

function tagBadges(tags, color) {
  let x = 154;
  return tags
    .map((tag) => {
      const width = Math.max(50, tag.length * 7.4 + 24);
      const badge = `<g transform="translate(${x} 143)">
        <rect width="${width}" height="27" rx="13.5" fill="${color}" fill-opacity="0.12" stroke="${color}" stroke-opacity="0.62"/>
        <text x="${width / 2}" y="18" text-anchor="middle" fill="${color}" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="11" font-weight="700">${escapeXml(tag)}</text>
      </g>`;
      x += width + 10;
      return badge;
    })
    .join("");
}

function projectModule(embeddedImage, project) {
  const icon = croppedArtwork(embeddedImage, {
    ...project.icon,
    x: 26,
    y: 45,
    width: 112,
    height: 112,
    fit: "xMidYMid meet",
  });
  const lines = project.description
    .map(
      (line, index) =>
        `<text x="154" y="${82 + index * 25}" fill="#c7d2de" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="16" font-weight="500">${escapeXml(line)}</text>`,
    )
    .join("");

  return svgDocument({
    width: 928,
    height: 188,
    title: project.title,
    description: project.description.join(" "),
    body: `
      ${panelBackdrop(928, 188)}
      <rect x="1" y="1" width="926" height="5" rx="2.5" fill="${project.color}" fill-opacity="0.75"/>
      ${icon}
      <text x="154" y="46" fill="#f2f7fb" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="24" font-weight="700">${escapeXml(project.title)}</text>
      ${lines}
      ${tagBadges(project.tags, project.color)}
    `,
  });
}

function moduleLanguageArtwork(languages) {
  const palette = ["#3aa5eb", "#e94b9a", "#8d60d8", "#f29a38", "#96a1ad"];
  const displayNames = {
    "Jupyter Notebook": "Jupyter",
    JavaScript: "JS",
    TypeScript: "TS",
    "Objective-C": "Obj-C",
    "Objective-C++": "Obj-C++",
  };
  const total =
    languages.reduce((sum, language) => sum + Number(language.bytes), 0) || 1;
  const barX = 48;
  const barY = 72;
  const barWidth = 832;
  let segmentX = barX;

  const segments = languages
    .map((language, index) => {
      const width =
        index === languages.length - 1
          ? barX + barWidth - segmentX
          : Math.max(3, (Number(language.bytes) / total) * barWidth);
      const segment = `<rect x="${segmentX.toFixed(2)}" y="${barY}" width="${width.toFixed(2)}" height="14" rx="7" fill="${palette[index]}"/>`;
      segmentX += width;
      return segment;
    })
    .join("");

  let legendX = 52;
  const legend = languages
    .map((language, index) => {
      const shortName =
        displayNames[language.name] ||
        (language.name.length > 10
          ? `${language.name.slice(0, 9)}…`
          : language.name);
      const item = `<circle cx="${legendX}" cy="119" r="5" fill="${palette[index]}"/>
        <text x="${legendX + 13}" y="124" fill="#aeb8c5" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="14" font-weight="600">${escapeXml(shortName)}</text>`;
      legendX += Math.max(105, shortName.length * 9 + 34);
      return item;
    })
    .join("");

  return `${segments}${legend}`;
}

function renderModules(baseImage, stats) {
  const embeddedImage = `data:image/png;base64,${baseImage.toString("base64")}`;
  const stars = escapeXml(compactNumber(stats.stars));
  const commits = escapeXml(compactNumber(stats.commits));
  const repositories = escapeXml(compactNumber(stats.repositories));

  const banner = svgDocument({
    width: 928,
    height: 161,
    title: "Autonomous vehicle visual",
    description: "Futuristic autonomous vehicle artwork.",
    body: `
      ${croppedArtwork(embeddedImage, {
        cropX: 450,
        cropY: 9,
        cropWidth: 620,
        cropHeight: 161,
        x: 0,
        y: 0,
        width: 928,
        height: 161,
      })}
    `,
  });

  const roleStrip = svgDocument({
    width: 928,
    height: 60,
    title: "Professional roles",
    description:
      "Autonomous Vehicle Development Engineer, Technical Lead, AI Researcher and Lecturer.",
    body: `
      ${panelBackdrop(928, 60)}
      <clipPath id="role-clip">
        <rect x="48" y="8" width="832" height="44" rx="8"/>
      </clipPath>
      <path d="M28 30l8-8m-8 8l8 8M900 30l-8-8m8 8l-8 8" fill="none" stroke="#36d6ff" stroke-width="2" stroke-linecap="round"/>
      <g clip-path="url(#role-clip)">
        <text x="70" y="36" class="mono" font-size="16">
          Autonomous Vehicle Development Engineer  •  Technical Lead  •  AI Researcher  •  Lecturer
          <animate attributeName="x" values="70;170;70" dur="8s" repeatCount="indefinite"/>
          <animate attributeName="opacity" values="1;0.62;1" dur="2.2s" repeatCount="indefinite"/>
        </text>
      </g>
    `,
  });

  const profileIntro = svgDocument({
    width: 928,
    height: 224,
    title: "Profile introduction",
    description:
      "Autonomous systems engineer building intelligent and reliable real-world vehicle solutions.",
    body: `
      ${panelBackdrop(928, 224)}
      ${croppedArtwork(embeddedImage, {
        cropX: 156,
        cropY: 238,
        cropWidth: 112,
        cropHeight: 110,
        x: 28,
        y: 46,
        width: 140,
        height: 140,
        fit: "xMidYMid meet",
      })}
      ${croppedArtwork(embeddedImage, {
        cropX: 815,
        cropY: 244,
        cropWidth: 235,
        cropHeight: 108,
        x: 700,
        y: 54,
        width: 205,
        height: 130,
        fit: "xMidYMid meet",
      })}
      <text x="192" y="58" fill="#f2f7fb" font-family="Cascadia Mono,Consolas,monospace" font-size="20" font-weight="700">I build autonomous systems</text>
      <text x="192" y="88" fill="#36d6ff" font-family="Cascadia Mono,Consolas,monospace" font-size="20" font-weight="700">from simulation to the real world.</text>
      <line x1="192" y1="108" x2="650" y2="108" stroke="url(#cyan-line)"/>
      <text x="192" y="137" fill="#c7d2de" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="16">My work combines artificial intelligence, planning, control</text>
      <text x="192" y="163" fill="#c7d2de" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="16">and vehicle integration to create intelligent, reliable</text>
      <text x="192" y="189" fill="#c7d2de" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="16">autonomous solutions for complex real-world environments.</text>
    `,
  });

  const focusAreas = svgDocument({
    width: 928,
    height: 168,
    title: "Focus areas",
    description:
      "Autonomous driving, reinforcement learning, VLM systems, explainable AI, robotics, applied neural networks and robot applications.",
    body: `
      ${panelBackdrop(928, 168)}
      <text x="18" y="27" class="heading">FOCUS AREAS</text>
      <line x1="148" y1="22" x2="910" y2="22" stroke="url(#cyan-line)"/>

      <g transform="translate(30 51)">
        <rect width="202" height="96" rx="9" fill="#06111e" stroke="#19354d"/>
        <circle cx="28" cy="31" r="11" fill="none" stroke="#3aa5eb" stroke-width="3"/>
        <text x="52" y="29" fill="#3aa5eb" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="13" font-weight="700">AUTONOMOUS DRIVING</text>
        <text x="52" y="55" fill="#d4dee8" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="14">Motion planning</text>
        <text x="52" y="77" fill="#d4dee8" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="14">Reinforcement learning</text>
      </g>
      <g transform="translate(252 51)">
        <rect width="202" height="96" rx="9" fill="#06111e" stroke="#19354d"/>
        <circle cx="28" cy="31" r="11" fill="none" stroke="#9a6bff" stroke-width="3"/>
        <text x="52" y="29" fill="#9a6bff" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="13" font-weight="700">VLM / VLA SYSTEMS</text>
        <text x="52" y="55" fill="#d4dee8" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="14">Multimodal agents</text>
        <text x="52" y="77" fill="#d4dee8" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="14">Explainable AI</text>
      </g>
      <g transform="translate(474 51)">
        <rect width="202" height="96" rx="9" fill="#06111e" stroke="#19354d"/>
        <circle cx="28" cy="31" r="11" fill="none" stroke="#27d9a0" stroke-width="3"/>
        <text x="52" y="29" fill="#27d9a0" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="13" font-weight="700">ROBOTICS</text>
        <text x="52" y="55" fill="#d4dee8" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="14">Control systems</text>
        <text x="52" y="77" fill="#d4dee8" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="14">Intelligent systems</text>
      </g>
      <g transform="translate(696 51)">
        <rect width="202" height="96" rx="9" fill="#06111e" stroke="#19354d"/>
        <rect x="17" y="20" width="22" height="22" rx="4" fill="none" stroke="#f29a38" stroke-width="3"/>
        <text x="52" y="29" fill="#f29a38" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="13" font-weight="700">ACADEMIC</text>
        <text x="52" y="55" fill="#d4dee8" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="14">Applied neural nets</text>
        <text x="52" y="77" fill="#d4dee8" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="14">Robot applications</text>
      </g>
    `,
  });

  const projectsHeading = svgDocument({
    width: 928,
    height: 38,
    title: "Selected projects",
    description: "Selected GitHub projects.",
    body: `
      <rect width="928" height="38" fill="#020810"/>
      <text x="18" y="25" class="heading">SELECTED PROJECTS</text>
      <line x1="190" y1="20" x2="910" y2="20" stroke="url(#cyan-line)"/>
    `,
  });

  const projects = [
    {
      filename: "project-neovlm.svg",
      title: "NeoVLM",
      description: [
        "Closed-loop VLM-based autonomous driving",
        "with RL, imitation learning and CARLA.",
      ],
      tags: ["VLM", "RL", "CARLA", "AUTONOMY"],
      color: "#36d6ff",
      icon: { cropX: 154, cropY: 400, cropWidth: 62, cropHeight: 62 },
    },
    {
      filename: "project-morpheus.svg",
      title: "Morpheus AI",
      description: [
        "Multimodal, agentic AI assistant with",
        "memory, tools and workflow automation.",
      ],
      tags: ["AGENTIC AI", "LLM", "MULTIMODAL"],
      color: "#a36bff",
      icon: { cropX: 382, cropY: 400, cropWidth: 64, cropHeight: 62 },
    },
    {
      filename: "project-ann.svg",
      title: "Applied Neural Networks",
      description: [
        "Practical neural-network implementations,",
        "course material and deep-learning projects.",
      ],
      tags: ["DEEP LEARNING", "PYTHON", "EDUCATION"],
      color: "#27d9a0",
      icon: { cropX: 610, cropY: 400, cropWidth: 62, cropHeight: 62 },
    },
    {
      filename: "project-robot.svg",
      title: "Robot Design & Applications",
      description: [
        "Educational robotics, control systems and",
        "intelligent robot application studies.",
      ],
      tags: ["ROBOTICS", "CONTROL", "EDUCATION"],
      color: "#f29a38",
      icon: { cropX: 835, cropY: 400, cropWidth: 62, cropHeight: 62 },
    },
  ];

  const techLogos = svgDocument({
    width: 928,
    height: 166,
    title: "Technology logos",
    description:
      "Python, C++, ROS, MATLAB, Docker, Git, Linux and Ubuntu technology logos.",
    body: `
      ${panelBackdrop(928, 166)}
      <text x="18" y="25" class="heading">TECH STACK</text>
      <line x1="142" y1="20" x2="910" y2="20" stroke="url(#cyan-line)"/>
      ${croppedArtwork(embeddedImage, {
        cropX: 145,
        cropY: 520,
        cropWidth: 360,
        cropHeight: 56,
        x: 70,
        y: 43,
        width: 788,
        height: 108,
        fit: "xMidYMid meet",
      })}
    `,
  });

  const toolingDetails = svgDocument({
    width: 928,
    height: 134,
    title: "Core tooling",
    description:
      "Programming languages, autonomous systems tools, simulation environments and development platforms.",
    body: `
      ${panelBackdrop(928, 134)}
      <text x="18" y="25" class="heading">CORE TOOLING</text>
      <line x1="162" y1="20" x2="910" y2="20" stroke="url(#cyan-line)"/>
      <g transform="translate(24 45)">
        <rect width="276" height="70" rx="9" fill="#06111e" stroke="#19354d"/>
        <text x="20" y="26" fill="#36d6ff" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="13" font-weight="700">LANGUAGES</text>
        <text x="20" y="53" fill="#e0e8ef" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="15">Python  •  C++  •  C  •  Bash</text>
      </g>
      <g transform="translate(326 45)">
        <rect width="276" height="70" rx="9" fill="#06111e" stroke="#19354d"/>
        <text x="20" y="26" fill="#9a6bff" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="13" font-weight="700">AUTONOMY &amp; SIMULATION</text>
        <text x="20" y="53" fill="#e0e8ef" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="15">ROS  •  CARLA  •  MATLAB</text>
      </g>
      <g transform="translate(628 45)">
        <rect width="276" height="70" rx="9" fill="#06111e" stroke="#19354d"/>
        <text x="20" y="26" fill="#27d9a0" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="13" font-weight="700">PLATFORM</text>
        <text x="20" y="53" fill="#e0e8ef" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="15">Docker  •  Git  •  Linux  •  Ubuntu</text>
      </g>
    `,
  });

  const statsMetrics = svgDocument({
    width: 928,
    height: 190,
    title: "Live GitHub metrics",
    description: `${stats.stars} stars, ${stats.commits} authored commits and ${stats.repositories} public repositories.`,
    body: `
      ${panelBackdrop(928, 190)}
      <text x="18" y="27" class="heading">LIVE GITHUB METRICS</text>
      <line x1="224" y1="22" x2="910" y2="22" stroke="url(#cyan-line)"/>
      <g transform="translate(18 50)">
        <rect width="285" height="116" rx="10" fill="#06111e" stroke="#19354d"/>
        <text x="28" y="48" fill="#9a6bff" font-size="34">★</text>
        <text x="78" y="38" fill="#aeb8c5" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="14" font-weight="700">TOTAL STARS</text>
        <text x="78" y="89" fill="#f2f7fb" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="43" font-weight="700">${stars}</text>
      </g>
      <g transform="translate(322 50)">
        <rect width="285" height="116" rx="10" fill="#06111e" stroke="#19354d"/>
        <text x="28" y="48" fill="#3aa5eb" font-size="34">⌁</text>
        <text x="78" y="38" fill="#aeb8c5" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="14" font-weight="700">TOTAL COMMITS</text>
        <text x="78" y="89" fill="#f2f7fb" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="43" font-weight="700">${commits}</text>
      </g>
      <g transform="translate(626 50)">
        <rect width="284" height="116" rx="10" fill="#06111e" stroke="#19354d"/>
        <text x="28" y="48" fill="#c16cff" font-size="34">▣</text>
        <text x="78" y="38" fill="#aeb8c5" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="14" font-weight="700">REPOSITORIES</text>
        <text x="78" y="89" fill="#f2f7fb" font-family="Segoe UI,Inter,Arial,sans-serif" font-size="43" font-weight="700">${repositories}</text>
      </g>
    `,
  });

  const languageStats = svgDocument({
    width: 928,
    height: 150,
    title: "Live GitHub language distribution",
    description: "Top programming languages calculated from public repository byte counts.",
    body: `
      ${panelBackdrop(928, 150)}
      <text x="18" y="27" class="heading">TOP LANGUAGES</text>
      <line x1="174" y1="22" x2="910" y2="22" stroke="url(#cyan-line)"/>
      ${moduleLanguageArtwork(stats.languages)}
    `,
  });

  const footerGithub = svgDocument({
    width: 288,
    height: 62,
    title: "Furkan Hanilçi on GitHub",
    description: "Open the GitHub profile.",
    body: `
      ${panelBackdrop(288, 62)}
      <circle cx="30" cy="31" r="13" fill="#f2f7fb"/>
      <text x="30" y="36" text-anchor="middle" fill="#07111c" font-family="Segoe UI,Arial,sans-serif" font-size="12" font-weight="800">GH</text>
      <text x="54" y="36" class="copy">github.com/furkanhanilci</text>
    `,
  });

  const footerLinkedin = svgDocument({
    width: 316,
    height: 62,
    title: "Furkan Hanilçi on LinkedIn",
    description: "Open the LinkedIn profile.",
    body: `
      ${panelBackdrop(316, 62)}
      <rect x="18" y="18" width="26" height="26" rx="4" fill="#2b8ac6"/>
      <text x="31" y="37" text-anchor="middle" fill="#ffffff" font-family="Arial,sans-serif" font-size="14" font-weight="700">in</text>
      <text x="56" y="36" class="copy">linkedin.com/in/furkanhanilci</text>
    `,
  });

  const footerTagline = svgDocument({
    width: 306,
    height: 62,
    title: "Engineering tagline",
    description: "Engineering intelligent systems for a better future.",
    body: `
      ${panelBackdrop(306, 62)}
      <text x="153" y="27" text-anchor="middle" fill="#aeb8c5" font-family="Cascadia Mono,Consolas,monospace" font-size="11">Engineering intelligent systems</text>
      <text x="153" y="44" text-anchor="middle" fill="#aeb8c5" font-family="Cascadia Mono,Consolas,monospace" font-size="11">for a <tspan fill="#36d6ff">better future.</tspan></text>
    `,
  });

  return new Map([
    ["banner.svg", banner],
    ["role-strip.svg", roleStrip],
    ["profile-intro.svg", profileIntro],
    ["focus-areas.svg", focusAreas],
    ["projects-heading.svg", projectsHeading],
    ...projects.map((project) => [
      project.filename,
      projectModule(embeddedImage, project),
    ]),
    ["tech-logos.svg", techLogos],
    ["tooling-details.svg", toolingDetails],
    ["stats-metrics.svg", statsMetrics],
    ["language-stats.svg", languageStats],
    ["footer-github.svg", footerGithub],
    ["footer-linkedin.svg", footerLinkedin],
    ["footer-tagline.svg", footerTagline],
  ]);
}

await mkdir(modulesDirectory, { recursive: true });
const [baseImage, stats] = await Promise.all([
  readFile(baseImagePath),
  collectStats(),
]);
const modules = renderModules(baseImage, stats);

await Promise.all([
  writeFile(outputSvgPath, renderSvg(baseImage, stats), "utf8"),
  writeFile(outputStatsPath, `${JSON.stringify(stats, null, 2)}\n`, "utf8"),
  ...[...modules.entries()].map(([filename, contents]) =>
    writeFile(path.join(modulesDirectory, filename), contents, "utf8"),
  ),
]);

console.log(
  `Rendered ${modules.size} readable modules for @${username}: ` +
    `${stats.stars} stars, ${stats.commits} commits, ` +
    `${stats.repositories} public repositories.`,
);
