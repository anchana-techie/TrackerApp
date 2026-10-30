# Architecture

## 1. The big picture

Three Google services do the work; the site itself is only static files.

```mermaid
flowchart LR
    subgraph Browser["Browser - GitHub Pages (static files)"]
        UI["index.html / app.js / style.css"]
        ACC["account.js - Firebase sign-in + Firestore reads"]
        CFG["config.js - public Firebase config + script URL"]
    end

    subgraph Firebase["Firebase (free Spark plan)"]
        AUTH["Authentication - email + password (hashed)"]
        FS[("Firestore - members, document_link, invites, usernames")]
        RULES{{"firestore.rules"}}
    end

    subgraph Google["Google account that owns everything"]
        GS["Apps Script web app - Code.gs"]
        DRIVE[("Drive - MasterFolder / UserName / Year")]
    end

    ACC -- "sign in / register / reset" --> AUTH
    ACC -- "read members, years, invites" --> FS
    RULES -. "guards every browser read/write" .-> FS
    UI -- "ID token + year + action" --> GS
    GS -- "verify token" --> AUTH
    GS -- "read as the user (rules apply)" --> FS
    GS -- "write document_link as owner" --> FS
    GS -- "create folder, convert xlsx, read/write Sheet" --> DRIVE
```

**Key idea:** the browser never sends a file link. It sends *who it is* (a Firebase token) and *which year*. The script finds the file itself.

## 2. Sign-in and registration (invite only)

```mermaid
sequenceDiagram
    actor Admin
    actor Person
    participant Site as Browser
    participant Auth as Firebase Auth
    participant DB as Firestore

    Admin->>DB: Admin tab - add invites/{email}
    Person->>Site: Register (username, gender, email, password)
    Site->>Auth: create account
    Site->>DB: invite exists for this email?
    alt not invited, or username taken
        Site->>Auth: delete the new account
        Site-->>Person: error message
    else ok
        Site->>DB: batch - usernames/{name} + members/{uid}
        Note over DB: rules check invite, role=user, gender valid,<br/>username reserved for this uid
        Site-->>Person: signed in
    end
```

Passwords are stored only by Firebase Authentication. Admin status is set by hand in the Firestore console (`members/{uid}.role = "admin"`); the site cannot grant it.

## 3. Upload a year

```mermaid
sequenceDiagram
    actor Person
    participant Site as Browser
    participant GS as Apps Script
    participant DB as Firestore
    participant Drive as Google Drive

    Person->>Site: choose year + .xlsx
    Site->>DB: list my years (client-side early check)
    Site->>GS: action=upload, year, base64 file, ID token
    GS->>GS: verify token with Firebase
    GS->>DB: read members/{uid} and document_link/{uid_year} as the user
    alt year already uploaded
        GS-->>Site: error - cannot be replaced
    else new year
        GS->>Drive: find or create MasterFolder/UserName
        GS->>Drive: convert xlsx to Google Sheet named after the year
        GS->>GS: dates inside the file must match the year
        GS->>DB: create document_link/{uid_year} as owner (409 if it exists)
        GS-->>Site: ok
        Site->>Site: select the year and load it
    end
```

If anything fails after the Sheet is created, the script moves that Sheet to the trash so no orphan files are left.

## 4. Viewing and saving a tracker

```mermaid
sequenceDiagram
    participant Site as Browser
    participant GS as Apps Script
    participant DB as Firestore
    participant Sheet as Google Sheet

    Site->>GS: action (read / saveDays / ...), year, ID token
    GS->>GS: verify token (cached 5 min)
    GS->>DB: GET document_link/{uid_year} using the user's token
    Note over DB: rules answer: yours, or you are admin, or denied
    DB-->>GS: driveFileId
    GS->>Sheet: open by id, read or write under a script lock
    GS-->>Site: JSON
```

## 5. Admin viewing someone else

The admin picks a person in the header. The browser adds `asUid` to the request.

```mermaid
flowchart TD
    A["Request with asUid"] --> B{"Caller role = admin?<br/>(members doc, read with caller token)"}
    B -- no --> X["Rejected: no access"]
    B -- yes --> C["Read document_link of that person<br/>(rules allow admin)"]
    C --> D{"Action = read?"}
    D -- no --> Y["Rejected: read-only view"]
    D -- yes --> E["Return that person's data"]
```

The browser also disables editing in this view, but the real enforcement is in the script.

## 6. Three layers of protection

```mermaid
flowchart LR
    U["Request"] --> L1["1. Firebase token<br/>who are you?"]
    L1 --> L2["2. Firestore rules<br/>is this row yours?"]
    L2 --> L3["3. Script logic<br/>read-only for admin view,<br/>only the script writes document_link"]
    L3 --> OK["Sheet data"]
```

## 7. File map

| File | Role |
|---|---|
| `index.html`, `style.css` | Pages, sign-in screen, layout and theme |
| `app.js` | UI logic: tabs, tracking, buy list, analysis, upload, admin |
| `account.js` | Wraps Firebase Auth and Firestore; the only code that touches Firebase |
| `config.js` | Public Firebase config and the Apps Script URL (safe to commit) |
| `Code.gs` | Apps Script: token check, Drive upload, Sheet read/write |
| `appsscript.json` | Script manifest: Drive v3 service, permission scopes, web-app access |
| `firestore.rules` | Security rules, pasted into the Firebase console |

## 8. Limits and design trade-offs

- **One script lock:** Apps Script serialises requests with a lock, which is fine for a handful of users; many simultaneous users would queue.
- **Apps Script quotas:** daily limits apply to Drive and URL fetch calls. Fine for a few users.
- **Upload size:** about 10 MB per file; the file travels as base64 in one request.
- **Token cache:** verified tokens are cached for 5 minutes to save a round trip; a removed account can still act for up to 5 minutes.
- **Public config:** the Firebase `apiKey` in `config.js` is public by design; protection comes from the rules and the script.
