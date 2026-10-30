# 🌸 Life Tracker

A static website (HTML + CSS + JS, no build step) that reads and writes your Google Sheet tracker and shows in-depth analysis. It runs on **GitHub Pages**; a small **Google Apps Script** acts as the bridge to your sheet.

```
GitHub Pages site  ──(sheet link + passcode)──▶  Apps Script web app  ──▶  your Google Sheet
   docs/                                           apps-script/Code.gs
```

## What's in the folder

| Path | What it is |
|---|---|
| `docs/index.html`, `docs/style.css`, `docs/app.js` | The website. GitHub Pages serves this folder. |
| `apps-script/Code.gs` | The bridge. Paste into Google Apps Script. |
| `2027 Tracker.xlsx` | Next year's workbook, same layout as 2026 plus the **Buy Settings** sheet. |

---

## One-time setup (≈10 minutes)

### 1. Create the Apps Script bridge

1. Go to **script.google.com → New project**. Name it `Tracker bridge`.
2. Delete the sample code and paste the whole of `apps-script/Code.gs`. Save.
3. **Project Settings (⚙️) → Script properties → Add script property**
   - Property: `PASSCODE` Value: a secret of your choice (e.g. a long random phrase).
4. Back in the editor, pick `doGet` in the function dropdown and click **Run** once. Google asks you to authorise:
   *Review permissions → your account → Advanced → Go to Tracker bridge (unsafe) → Allow.*
   ("Unsafe" just means Google hasn't reviewed your personal script — it's your own code.)
5. **Deploy → New deployment → ⚙️ Select type → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy** and copy the **Web app URL** (ends in `/exec`).

> One script works for **every** tracker file you own — 2026, 2027, … — because the page sends the sheet link with each request.

**When you change `Code.gs` later:** Deploy → Manage deployments → ✏️ Edit → Version: *New version* → Deploy. This keeps the same URL.

### 2. Publish the site on GitHub Pages

1. Create a repo, e.g. `anchana-techie/life-tracker`.
2. Upload this whole folder (or at least `docs/`) to the `main` branch.
3. Repo **Settings → Pages → Build and deployment**
   Source: *Deploy from a branch* · Branch: `main` · Folder: `/docs` → **Save**.
4. After a minute the site is live at `https://anchana-techie.github.io/life-tracker/`.

### 3. Connect the site

1. Open the site → **Settings** tab.
2. Paste the **Web app URL** and your **PASSCODE** → **Save & test**. You should see ✓ Connected.
   (These are stored only in that browser. Use *Forget on this device* on a shared computer.)

---

## Everyday use

1. Paste your Google Sheet link (the normal `https://docs.google.com/spreadsheets/d/…/edit` link) at the top → **Load**.
   Recent links are remembered in the dropdown. You can also bookmark `…/life-tracker/?sheet=<your sheet link>`.
2. **📝 Log a day** — pick a date, tick Daily Dos, Habits and products bought, toggle a period day, type your weight → **Save to sheet**. Only the cells you changed are written (`X` under that date, the weight in its row).
   New products typed in "Bought today" are added as a new row at the bottom of the Products sheet.
3. **🛒 Buy list** — choose a month, add products (suggestions come from your Products list, or type a new one), approx cost, and a monthly budget → **Save list**.
   - Items fill `Product-1 / Cost`, `Product-2 / Cost`, … in that month's row. If you add more than 11, new `Product-12 / Cost` columns are added automatically.
   - **Mark bought** puts an `X` in Products on the date you choose. "Bought" status is read back from Products, so ticking it on the Log page counts too.
   - The budget is saved in a small **Buy Settings** sheet (created automatically the first time you set one).
   - Items from earlier months that were never bought show up as "Not bought from earlier months" with a one-click **+ Add**.
4. **📊 Analysis** — choose a view and a period (All tracked, last 30/7 days, or a month):
   - **Overview:** completion vs previous period, best streak, next period, weight change, this month's spend, and the main things that stand out.
   - **Daily Dos / Habits:** completion over time with a 7-day average, day-of-week pattern, per-item rate / streaks / trend / best day / last done, a day-by-day heat map, *keystone* items (days you do X, you do more of everything else), weekend vs weekday, and period-day effect.
   - **Period cycle:** detected periods and cycle lengths, spotting kept separate from new cycles, next-period prediction with a ± window, estimated fertile window, today's cycle day and phase, irregularity flags, how habits and weight change by phase.
   - **Weight:** trend line with 7-day average, weekly rate from a best-fit line, range, weigh-in consistency, 30-day projection, and which items go with lower/higher weight the next morning.
   - **Spending & restock:** budget vs planned vs bought per month, over-budget warnings, unplanned purchases, repeat items, biggest planned items, and a restock tracker (average gap between purchases → next expected date → overdue / due soon).

**Try it first:** Settings → *Load demo data* shows every screen with made-up numbers. Nothing is sent anywhere.

### How "logged days" work
A day with nothing ticked on a sheet is treated as **not logged**, not as "all missed", so forgetting to fill a day doesn't drag your percentages down. The heat map shows those days with a dashed outline.

---

## Sheet layout the script expects
Sheets are found by name prefix, so the year in the name can change:

| Sheet (name starts with) | Layout |
|---|---|
| `Products…`, `Daily Dos…`, `Habit…` | Row of dates (row 2), item names in column A from row 4, `X` under a date = done/bought |
| `Period…` | Calendar blocks; `X` in the cell directly under a date |
| `Weight…` | Header row with `Date` and `Weight (kg)` columns |
| `Month List…` | Header row `Product-1`, `Product - 1 Cost Approx`, …; one row per month name in column A |
| `Buy Settings` | `Month · Budget (₹) · Notes` (auto-created) |

You can rename items, reorder them, or add new rows in the sheet itself — the site picks them up on the next **Load**.

## 2027
`2027 Tracker.xlsx` has the same layout and colours for Jan–Dec 2027 (your item lists carried over) plus the Buy Settings sheet. Upload it to Google Drive, open it with Google Sheets, then **File → Save as Google Sheets**, and paste that new link into the site. No code changes needed.

## Privacy
- Your data lives only in your Google Sheet. The site stores nothing on GitHub.
- The script refuses any request without the right passcode. To change it, edit `PASSCODE` in Script properties, then update it in the site's Settings.
- The Web app URL + passcode together give access to any sheet your Google account owns, so keep both private.

## Troubleshooting
| Message | Fix |
|---|---|
| *Wrong passcode* | Match the site's passcode with Script properties → `PASSCODE`. |
| *The script did not return JSON* | Use the `/exec` URL, and make sure the deployment's access is **Anyone**. |
| *… is not a column in "…"* | That date isn't in the sheet (e.g. a 2027 date on the 2026 file). |
| *You do not have permission / Unexpected error … openById* | The sheet belongs to a different Google account from the one that deployed the script. |
| Changes in `Code.gs` not taking effect | Deploy a **New version** (see step 1). |
