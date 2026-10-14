---
"@telorun/studio": patch
---

Studio's top bar has a Telo products menu (the dot-grid button) listing the products accounts serves in this environment — Telo Cloud, Hub, Marketplace and Studio — each with its icon and its name in its own colour, Studio marked as the current one; it is read from `<accounts>/v1/products` once per page load, and when accounts cannot be reached or answers anything else there is no menu. The web image serves `/config.json` (`{"accountsUrl": …}`) from the `ACCOUNTS_URL` environment variable, default `https://accounts.telo.run`, set by the chart's new `accountsUrl` value (an https origin; anything else fails the render). The image now renders its nginx config from a template at start, so a deployment with a read-only root filesystem must give `/etc/nginx/conf.d` a writable volume — the chart does. The desktop build reads accounts from its build setting `VITE_TELO_ACCOUNTS_URL`.
