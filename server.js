const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ── Skill Match Scorer ────────────────────────────────────────────────────────
function scoreMatch(userSkills, jobText) {
  if (!userSkills || userSkills.length === 0) return { score: 50, matched: [], missing: [] };
  const lower = jobText.toLowerCase();
  const matched = userSkills.filter((s) => lower.includes(s.toLowerCase()));
  const score = Math.round((matched.length / userSkills.length) * 100);
  const missing = userSkills.filter((s) => !lower.includes(s.toLowerCase())).slice(0, 3);
  return { score, matched, missing };
}

// ── Normalize a result ────────────────────────────────────────────────────────
function normalize({ title, company, location, salary, description, url, source, type, skills }) {
  const match = scoreMatch(skills, `${title} ${description}`);
  return {
    title: title || "Untitled",
    company: company || "Unknown",
    location: location || "Remote",
    salary: salary || "Not specified",
    description: (description || "").slice(0, 300),
    url: url || "#",
    source,
    type,
    matchScore: match.score,
    matchedSkills: match.matched,
    missingSkills: match.missing,
  };
}

// ── RemoteOK (public API) ─────────────────────────────────────────────────────
async function scrapeRemoteOK({ skills, position }) {
  try {
    const res = await axios.get("https://remoteok.com/api", {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 8000,
    });
    const jobs = res.data.filter((j) => j.position);
    const query = (position || skills.join(" ")).toLowerCase();
    return jobs
      .filter((j) => {
        const text = `${j.position} ${j.tags?.join(" ")} ${j.description}`.toLowerCase();
        return skills.some((s) => text.includes(s.toLowerCase())) || text.includes(query);
      })
      .slice(0, 8)
      .map((j) =>
        normalize({
          title: j.position,
          company: j.company,
          location: "Remote",
          salary: j.salary || "",
          description: j.description || j.tags?.join(", ") || "",
          url: j.url || `https://remoteok.com/l/${j.slug}`,
          source: "RemoteOK",
          type: "job",
          skills,
        })
      );
  } catch {
    return [];
  }
}

// ── Arbeitnow (free jobs API) ─────────────────────────────────────────────────
async function scrapeArbeitnow({ skills, position, location }) {
  try {
    const query = encodeURIComponent(position || skills.join(" "));
    const loc = encodeURIComponent(location || "");
    const url = `https://www.arbeitnow.com/api/job-board-api?search=${query}&location=${loc}`;
    const res = await axios.get(url, { timeout: 8000 });
    return (res.data.data || []).slice(0, 8).map((j) =>
      normalize({
        title: j.title,
        company: j.company_name,
        location: j.location || "Remote",
        salary: "",
        description: j.description?.replace(/<[^>]+>/g, "").slice(0, 300) || "",
        url: j.url,
        source: "Arbeitnow",
        type: j.remote ? "job" : "job",
        skills,
      })
    );
  } catch {
    return [];
  }
}

// ── Reddit (public JSON API) ──────────────────────────────────────────────────
async function scrapeReddit({ skills, position, type }) {
  try {
    const subs =
      type === "Gigs Only"
        ? ["forhire", "freelance"]
        : type === "Jobs Only"
        ? ["jobsearch", "remotework", "jobopenings"]
        : ["forhire", "freelance", "jobsearch", "remotework"];

    const query = encodeURIComponent(position || skills.join(" "));
    const results = [];

    for (const sub of subs.slice(0, 2)) {
      const url = `https://www.reddit.com/r/${sub}/search.json?q=${query}&restrict_sr=1&sort=new&limit=5`;
      const res = await axios.get(url, {
        headers: { "User-Agent": "SakuraJobFinder/1.0" },
        timeout: 8000,
      });
      const posts = res.data?.data?.children || [];
      posts.forEach((p) => {
        const d = p.data;
        results.push(
          normalize({
            title: d.title,
            company: `r/${sub}`,
            location: "Remote / Various",
            salary: "",
            description: d.selftext?.slice(0, 300) || d.title,
            url: `https://reddit.com${d.permalink}`,
            source: "Reddit",
            type: sub === "forhire" || sub === "freelance" ? "gig" : "job",
            skills,
          })
        );
      });
    }
    return results;
  } catch {
    return [];
  }
}

// ── The Muse (free jobs API) ──────────────────────────────────────────────────
async function scrapeTheMuse({ skills, position, location }) {
  try {
    const query = encodeURIComponent(position || skills[0] || "developer");
    const loc = location ? `&location=${encodeURIComponent(location)}` : "";
    const url = `https://www.themuse.com/api/public/jobs?category=${query}${loc}&page=1&descended=true`;
    const res = await axios.get(url, { timeout: 8000 });
    return (res.data.results || []).slice(0, 6).map((j) =>
      normalize({
        title: j.name,
        company: j.company?.name || "",
        location: j.locations?.map((l) => l.name).join(", ") || "Remote",
        salary: "",
        description: j.contents?.replace(/<[^>]+>/g, "").slice(0, 300) || "",
        url: j.refs?.landing_page || "#",
        source: "The Muse",
        type: "job",
        skills,
      })
    );
  } catch {
    return [];
  }
}

// ── Google Jobs scrape (search results) ──────────────────────────────────────
async function scrapeGoogleJobs({ skills, position, location }) {
  try {
    const query = encodeURIComponent(
      `${position || skills.join(" ")} jobs ${location || ""}`
    );
    const url = `https://www.google.com/search?q=${query}&ibp=htl;jobs`;
    const res = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 10000,
    });
    const $ = cheerio.load(res.data);
    const results = [];
    $("[class*='job']").each((_, el) => {
      const title = $(el).find("h2, h3, [class*='title']").first().text().trim();
      const company = $(el).find("[class*='company'], [class*='employer']").first().text().trim();
      const loc = $(el).find("[class*='location']").first().text().trim();
      const desc = $(el).find("[class*='desc'], p").first().text().trim();
      if (title) {
        results.push(
          normalize({
            title,
            company: company || "Via Google",
            location: loc || location || "Remote",
            salary: "",
            description: desc,
            url: `https://www.google.com/search?q=${encodeURIComponent(title + " " + company)}`,
            source: "Google Jobs",
            type: "job",
            skills,
          })
        );
      }
    });
    return results.slice(0, 6);
  } catch {
    return [];
  }
}

// ── Freelancer public search ──────────────────────────────────────────────────
async function scrapeFreelancer({ skills, position }) {
  try {
    const query = encodeURIComponent(position || skills.join(" "));
    const url = `https://www.freelancer.com/api/projects/0.1/projects/active/?query=${query}&limit=6&full_description=true`;
    const res = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 8000,
    });
    const projects = res.data?.result?.projects || [];
    return projects.slice(0, 6).map((p) =>
      normalize({
        title: p.title,
        company: "Freelancer.com",
        location: "Remote",
        salary: p.budget
          ? `$${p.budget.minimum}–$${p.budget.maximum}`
          : "Negotiable",
        description: p.preview_description || p.description?.slice(0, 300) || "",
        url: `https://www.freelancer.com/projects/${p.seo_url}`,
        source: "Freelancer",
        type: "gig",
        skills,
      })
    );
  } catch {
    return [];
  }
}

// ── Main search endpoint ──────────────────────────────────────────────────────
app.post("/search", async (req, res) => {
  const { skills = [], position = "", location = "", type = "Both" } = req.body;

  if (!skills.length && !position) {
    return res.status(400).json({ error: "Provide skills or position" });
  }

  const params = { skills, position, location, type };

  // Run all scrapers in parallel
  const [remoteOK, arbeitnow, reddit, muse, google, freelancer] =
    await Promise.allSettled([
      scrapeRemoteOK(params),
      scrapeArbeitnow(params),
      scrapeReddit(params),
      scrapeTheMuse(params),
      scrapeGoogleJobs(params),
      scrapeFreelancer(params),
    ]);

  let all = [
    ...(remoteOK.value || []),
    ...(arbeitnow.value || []),
    ...(reddit.value || []),
    ...(muse.value || []),
    ...(google.value || []),
    ...(freelancer.value || []),
  ];

  // Filter by type
  if (type === "Jobs Only") all = all.filter((j) => j.type === "job");
  if (type === "Gigs Only") all = all.filter((j) => j.type === "gig");

  // Remove duplicates by title+company
  const seen = new Set();
  all = all.filter((j) => {
    const key = `${j.title}-${j.company}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by match score
  all.sort((a, b) => b.matchScore - a.matchScore);

  // Return top 5
  res.json({ results: all.slice(0, 5), total: all.length });
});

app.get("/health", (_, res) => res.json({ status: "ok", service: "Sakura Job Finder" }));

app.listen(PORT, () => console.log(`🌸 Sakura server running on port ${PORT}`));
