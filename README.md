# Querença-Silves seasonal head forecasts — dashboard

Generated output. This directory is published to <https://github.com/rhugman/qs-forecast-site> by
`.github/workflows/weekly.yml`, which force-pushes a single commit: **anything committed to the site repo by
hand is destroyed on the next issue.** Edit the pages here.

- `index.html`, `site.html`, `weather.html`, `skill.html`, `hindcast.html`, `methods.html`, `app.js`,
  `style.css`, `favicon.svg` — the static dashboard, no build step.
- `data/*.json` — rewritten weekly by `scripts/08_forecast.py` and `scripts/08b_site_skill.py`; gitignored
  here, because the record they render is `runs/<issue-date>/`.
- `data/hindcast/*.json` — written by `scripts/07b_site_hindcast.py` on a machine holding the 90 MB hindcast
  cache, so these are committed and republished unchanged.
- `methods.md` — copied from `docs/methods.md` at issue time; gitignored here.

Serve locally with `python -m http.server` from this directory; `file://` will not do, the pages fetch JSON.

Research demonstration, non-commercial and unofficial. Not a decision product.
