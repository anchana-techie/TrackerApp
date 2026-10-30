# Features

## Screens

| Screen | Who | What it does |
|---|---|---|
| Sign in / Register | Everyone | Email + password sign-in, "Forgot password" email, invite-only registration with username, gender, email, password. |
| Header | Signed in | "Hello, name" on the left, **Sign out** on the right. Year picker; admins also get a person picker. |
| Today | Person | Tap tiles to mark Daily Dos, Habits, products bought, period day (not for male accounts) and weight. Day or Week view. Changes are collected and saved together. |
| Buy list | Person | Plan products and budget per month, mark items bought. |
| Insights | Person | Overview, Daily Dos, Habits, Period cycle (hidden for male accounts), Weight, Spending and restock; for All tracked, last 30 / 7 days or a month. |
| Upload | Person | Choose a year and an `.xlsx`; lists the years already uploaded. |
| Admin | Admin only | Invite emails, see members and their years, open any person's tracker (read-only), remove a wrong upload. |
| Settings | Person | Change password, sign out, Daily Dos groups, demo data. |

## Rules of the system

- **Invite-only.** Only emails added under Admin → Invite can register.
- **Username** is chosen at registration, unique (case-insensitive), 3-30 letters, numbers, `_` or `-`, and cannot be changed. It is also the person's Drive folder name.
- **Gender** is chosen at registration (female / male / other) and cannot be changed. For **male** accounts all period features are removed: the Today tile and cycle pills, the Week-view row, the Insights "Period cycle" tab and the period lines in the Overview. For everyone else they are shown.
- **One upload per year.** If 2026 exists for a person it cannot be uploaded again; another year is accepted. The year chosen must match the dates inside the file. The admin can remove a wrong row so the year can be uploaded again (the old Sheet stays in Drive).
- **Privacy.** Nobody can see another person's files. The admin can view anyone's data but not change it.
- **Files** are converted to Google Sheets and stored at `MasterFolder/<UserName>/<Year>` in the owner's Drive.

## Apps Script API

One web-app URL, `POST`, body is JSON sent as `text/plain` (avoids a CORS preflight). Every request carries `idToken` and, for file actions, `year`.

| `action` | Extra fields | Result |
|---|---|---|
| `ping` | - | `{ uid }` - confirms the token is valid |
| `upload` | `year`, `data` (base64 .xlsx) | Creates the folder and Sheet, writes `document_link`; returns `{ year, link }` |
| `read` | `asUid` (admin only) | The whole tracker as JSON |
| `saveDay` / `saveDays` | `date` / `days[]` with grid, period, weight changes | `{ changed }` |
| `saveBuyList` | `month`, `items`, `budget` | `{ saved }` |
| `markBought` | `product`, `date`, `bought` | `{ ok }` |

Responses are `{ ok: true, data }` or `{ ok: false, error }`. With `asUid` set (admin viewing someone), every action except `read` is refused.

## Expected Excel layout

Sheets are found by the start of their name, so the year in the name can change. The first date in the Daily Dos, Habits or Products sheet decides which year the file is for.

| Sheet (name starts with) | Layout |
|---|---|
| `Products`, `Daily Dos`, `Habit` | Row of dates (row 2), item names in column A from row 4, `X` under a date = done / bought |
| `Period` | Calendar blocks; `X` in the cell under a date |
| `Weight` | Header row with `Date` and `Weight (kg)` |
| `Month List` | Header row `Product-1`, `Product - 1 Cost Approx`, ...; one row per month in column A |
| `Buy Settings` | `Month`, `Budget`, `Notes` (created automatically) |

## Ideas not built yet

- Download of the original `.xlsx` (only the converted Google Sheet is kept).
- Letting a person change their own gender or username.
- Email notification when an invite is created.
