# Changelog

Newest first. Add a line here with every feature change.

## 2026-10-30
- **Added** Documentation folder: architecture diagrams, data model and security, features.
- **Added** Gender at registration (female / male / other). **Male accounts no longer see period tracking or analysis.**
- **Fixed** First upload of a year was refused (rules denied reading a row that did not exist yet). `document_link` reads are now decided by the document id.
- **Added** "Hello, name" greeting at the top left and Sign out at the top right.
- **Added** Accounts: invite-only registration, sign in, change password, forgot password (Firebase Authentication).
- **Added** Upload of yearly `.xlsx` files, converted to Google Sheets at `MasterFolder/<UserName>/<Year>`; link stored in Firestore `document_link`. One upload per user per year.
- **Added** Year picker in the header; only the person's own years are listed.
- **Added** Admin tab and person picker: invite people, view anyone's tracker read-only, remove a wrong upload.
- **Changed** Apps Script no longer takes a passcode or sheet link. It verifies a Firebase token and finds the file itself.
- **Removed** The shared passcode, the "paste your sheet link" box and the Connection settings card.
