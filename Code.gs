/**
 * Life Tracker bridge — Google Apps Script
 * ------------------------------------------------------------
 * Sits between the GitHub Pages site, Firebase and Google Drive.
 *
 *  - The page sends the signed-in user's Firebase ID token (never a sheet link).
 *  - This script verifies the token, then reads Firestore *as that user*, so the
 *    Firestore security rules decide who may see which year file.
 *  - Only this script writes document_link rows (as the project owner); browsers cannot.
 *  - Uploaded .xlsx files are converted to Google Sheets inside
 *      MASTER_FOLDER / <UserName> / <Year>
 *    and the file id + link are written to Firestore (collection document_link).
 *
 * Script properties (Project Settings -> Script properties):
 *   MASTER_FOLDER_ID     id of the Drive folder that holds one sub-folder per user
 *   FIREBASE_PROJECT_ID  Firebase project id
 *   FIREBASE_API_KEY     Firebase web API key (same one as in config.js)
 *
 * Needs the Advanced Drive service (Services -> Drive API, v3). See README.
 */

var BUY_SETTINGS = 'Buy Settings';
var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
var XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
var MAX_UPLOAD_B64 = 14000000;   // ~10 MB of file

// ---------- entry points ----------

function doGet() {
  return json_({ ok: true, message: 'Tracker bridge is running. Use the website to talk to it.' });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Bad request body.' });
  }

  try {
    var auth = authenticate_(req.idToken);
    if (req.action === 'ping') return json_({ ok: true, data: { uid: auth.uid } });

    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var result;
      if (req.action === 'upload') {
        result = upload_(auth, req);
      } else {
        var target = resolveFile_(auth, req);
        if (target.readOnly && req.action !== 'read') throw new Error('This is a read-only view.');
        var ss = SpreadsheetApp.openById(target.fileId);
        switch (req.action) {
          case 'read':         result = readAll_(ss); break;
          case 'saveDay':      result = saveDay_(ss, req); break;
          case 'saveDays':     result = saveDays_(ss, req); break;
          case 'saveBuyList':  result = saveBuyList_(ss, req); break;
          case 'markBought':   result = markBought_(ss, req); break;
          default: throw new Error('Unknown action: ' + req.action);
        }
        SpreadsheetApp.flush();
      }
      return json_({ ok: true, data: result });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// ---------- helpers ----------

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function prop_(name) {
  var v = PropertiesService.getScriptProperties().getProperty(name);
  if (!v) throw new Error(name + ' is not set in Script properties.');
  return v;
}

// ---------- Firebase: sign-in check + Firestore (as the signed-in user) ----------

/** Verifies the Firebase ID token with Google and returns { uid, token }. */
function authenticate_(token) {
  token = String(token || '');
  if (!token) throw new Error('Please sign in.');
  var cache = CacheService.getScriptCache();
  var key = 'a_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  var uid = cache.get(key);
  if (!uid) {
    var res = UrlFetchApp.fetch(
      'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(prop_('FIREBASE_API_KEY')), {
        method: 'post', contentType: 'application/json',
        payload: JSON.stringify({ idToken: token }), muteHttpExceptions: true
      });
    var body = JSON.parse(res.getContentText() || '{}');
    if (res.getResponseCode() !== 200 || !body.users || !body.users.length) {
      throw new Error('Your session has expired. Please sign in again.');
    }
    uid = body.users[0].localId;
    cache.put(key, uid, 300);
  }
  return { uid: uid, token: token };
}

function fsBase_() {
  return 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(prop_('FIREBASE_PROJECT_ID')) +
    '/databases/(default)/documents/';
}

/** GET a Firestore document with the user's own token, so security rules apply. null when missing. */
function fsGet_(path, token) {
  var res = UrlFetchApp.fetch(fsBase_() + path, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  var code = res.getResponseCode();
  if (code === 404) return null;
  if (code === 401 || code === 403) throw new Error('You do not have access to that.');
  if (code !== 200) throw new Error('Database error (' + code + ').');
  return JSON.parse(res.getContentText());
}

/**
 * Creates a document as the script owner (project owner access, which bypasses the security rules).
 * Only this script may write document_link rows — browsers cannot — so nobody can point their row at
 * someone else's file. Fails if the id already exists, which is what blocks re-uploading a year.
 */
function fsCreate_(collection, docId, fields) {
  var res = UrlFetchApp.fetch(fsBase_() + collection + '?documentId=' + encodeURIComponent(docId), {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'X-Goog-User-Project': prop_('FIREBASE_PROJECT_ID') },
    payload: JSON.stringify({ fields: fields }), muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code === 409) throw new Error('That year has already been uploaded.');
  if (code !== 200) throw new Error('Could not save the file link (' + code + '). Check the setup steps in the README.');
}

function fsStr_(doc, name) {
  var f = doc && doc.fields && doc.fields[name];
  return f && f.stringValue !== undefined ? f.stringValue : '';
}

function getMember_(auth) {
  var doc = fsGet_('members/' + auth.uid, auth.token);
  if (!doc) throw new Error('Your account is not set up. Please sign out and register again.');
  return { userName: fsStr_(doc, 'userName'), role: fsStr_(doc, 'role') };
}

function parseYear_(v) {
  var y = Number(v);
  if (!isFinite(y) || y !== Math.floor(y) || y < 2000 || y > 2100) throw new Error('Choose a valid year.');
  return y;
}

/**
 * Finds the Drive file for the request. Own file by default; an admin may pass asUid
 * to look at someone else's file (read-only). The link is read from Firestore with the
 * caller's token, so the rules — not this code — are the final gate.
 */
function resolveFile_(auth, req) {
  var year = parseYear_(req.year);
  var target = auth.uid, readOnly = false;
  if (req.asUid && String(req.asUid) !== auth.uid) {
    if (getMember_(auth).role !== 'admin') throw new Error('You do not have access to that.');
    target = String(req.asUid);
    if (!/^[A-Za-z0-9]{10,40}$/.test(target)) throw new Error('Bad user.');
    readOnly = true;
  }
  var doc = fsGet_('document_link/' + target + '_' + year, auth.token);
  if (!doc) throw new Error('No file has been uploaded for ' + year + '.');
  var fileId = fsStr_(doc, 'driveFileId');
  if (!fileId) throw new Error('The file link is incomplete.');
  return { fileId: fileId, readOnly: readOnly };
}

// ---------- upload: xlsx -> Google Sheet in MASTER / UserName ----------

function userFolder_(userName) {
  var master = DriveApp.getFolderById(prop_('MASTER_FOLDER_ID'));
  var it = master.getFoldersByName(userName);
  return it.hasNext() ? it.next() : master.createFolder(userName);
}

function detectYear_(ss) {
  var tz = ss.getSpreadsheetTimeZone();
  var keys = ['dos', 'habits', 'products'];
  for (var i = 0; i < keys.length; i++) {
    var sh = findSheet_(ss, SHEETS[keys[i]]);
    if (!sh) continue;
    try {
      var g = parseGrid_(sh, tz);
      if (g.dates.length) return Number(g.dates[0].slice(0, 4));
    } catch (err) { /* try the next sheet */ }
  }
  throw new Error('This does not look like a tracker file (no Daily Dos / Habits / Products sheet with dates).');
}

/** req: { year, data: base64 of the .xlsx } */
function upload_(auth, req) {
  var year = parseYear_(req.year);
  var member = getMember_(auth);
  var linkId = auth.uid + '_' + year;
  if (fsGet_('document_link/' + linkId, auth.token)) {
    throw new Error(year + ' has already been uploaded and cannot be replaced.');
  }

  var b64 = String(req.data || '');
  if (!b64) throw new Error('No file received.');
  if (b64.length > MAX_UPLOAD_B64) throw new Error('That file is too large (limit about 10 MB).');
  var bytes = Utilities.base64Decode(b64);
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4B) throw new Error('Please upload an Excel .xlsx file.');

  var folder = userFolder_(member.userName);
  var blob = Utilities.newBlob(bytes, XLSX_MIME, String(year) + '.xlsx');
  var created = Drive.Files.create({
    name: String(year), mimeType: 'application/vnd.google-apps.spreadsheet', parents: [folder.getId()]
  }, blob);

  try {
    var detected = detectYear_(SpreadsheetApp.openById(created.id));
    if (detected !== year) throw new Error('The dates in this file are for ' + detected + ', not ' + year + '.');
    var link = 'https://docs.google.com/spreadsheets/d/' + created.id + '/edit';
    fsCreate_('document_link', linkId, {
      userId: { stringValue: auth.uid },
      userName: { stringValue: member.userName },
      year: { integerValue: String(year) },
      driveFileId: { stringValue: created.id },
      driveLink: { stringValue: link },
      uploadedAt: { timestampValue: new Date().toISOString() }
    });
    return { year: year, link: link };
  } catch (err) {
    DriveApp.getFileById(created.id).setTrashed(true);   // do not leave an orphan file behind
    throw err;
  }
}

function findSheet_(ss, regex) {
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (regex.test(sheets[i].getName().trim())) return sheets[i];
  }
  return null;
}

var SHEETS = {
  products: /^products/i,
  dos: /^daily\s*dos/i,
  habits: /^habit/i,
  period: /^period/i,
  weight: /^weight/i,
  buy: /^month\s*list/i
};

function norm_(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

function isX_(v) {
  return String(v == null ? '' : v).trim().toUpperCase() === 'X';
}

function fmt_(d, tz) {
  return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
}

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
}

// ---------- grid sheets (Products / Daily Dos / Habits) ----------

var HEADER_LABELS = ['products', 'product', 'dos', 'habits', 'habit', 'items'];

function parseGrid_(sh, tz) {
  var values = sh.getDataRange().getValues();
  var dateRow = -1, best = 0;
  for (var r = 0; r < Math.min(10, values.length); r++) {
    var n = 0;
    for (var c = 0; c < values[r].length; c++) if (isDate_(values[r][c])) n++;
    if (n > best) { best = n; dateRow = r; }
  }
  if (dateRow < 0) throw new Error('No date row found in "' + sh.getName() + '".');

  var dateCols = {}, dates = [];
  for (var c2 = 0; c2 < values[dateRow].length; c2++) {
    var v = values[dateRow][c2];
    if (isDate_(v)) { var k = fmt_(v, tz); dateCols[k] = c2; dates.push(k); }
  }

  var items = [];
  for (var r2 = dateRow + 1; r2 < values.length; r2++) {
    var name = String(values[r2][0] == null ? '' : values[r2][0]).trim();
    if (!name) continue;
    if (HEADER_LABELS.indexOf(norm_(name)) >= 0) continue;
    var marked = [];
    for (var i = 0; i < dates.length; i++) {
      if (isX_(values[r2][dateCols[dates[i]]])) marked.push(dates[i]);
    }
    items.push({ name: name, row: r2, marked: marked });
  }
  return { sheet: sh, dateRow: dateRow, dateCols: dateCols, dates: dates, items: items };
}

function gridToJson_(g) {
  return {
    sheetName: g.sheet.getName(),
    dates: g.dates,
    items: g.items.map(function (it) { return { name: it.name, marked: it.marked }; })
  };
}

function setGridMark_(g, itemName, date, on, allowAppend) {
  var col = g.dateCols[date];
  if (col === undefined) throw new Error(date + ' is not a column in "' + g.sheet.getName() + '".');
  var item = null;
  for (var i = 0; i < g.items.length; i++) {
    if (norm_(g.items[i].name) === norm_(itemName)) { item = g.items[i]; break; }
  }
  if (!item) {
    if (!on) return;
    if (!allowAppend) throw new Error('"' + itemName + '" is not in "' + g.sheet.getName() + '".');
    var last = g.items.length ? g.items[g.items.length - 1].row : g.dateRow + 1;
    g.sheet.insertRowAfter(last + 1);           // 1-based: row after the last item
    g.sheet.getRange(last + 2, 1).setValue(itemName.trim());
    item = { name: itemName.trim(), row: last + 1, marked: [] };
    g.items.push(item);
  }
  g.sheet.getRange(item.row + 1, col + 1).setValue(on ? 'X' : '');
}

// ---------- period calendar ----------

function parsePeriod_(sh, tz) {
  var values = sh.getDataRange().getValues();
  var cells = {}, dates = [], marked = [];
  // the data range can end on the last date row when its mark row is still empty,
  // so the row below may not exist in `values` — treat it as blank
  for (var r = 0; r < values.length; r++) {
    for (var c = 0; c < values[r].length; c++) {
      var v = values[r][c];
      if (isDate_(v)) {
        var k = fmt_(v, tz);
        cells[k] = { row: r + 1, col: c };      // mark cell sits directly under the date
        dates.push(k);
        if (r + 1 < values.length && isX_(values[r + 1][c])) marked.push(k);
      }
    }
  }
  dates.sort(); marked.sort();
  return { sheet: sh, cells: cells, dates: dates, marked: marked };
}

// ---------- weight ----------

function parseWeight_(sh, tz) {
  var values = sh.getDataRange().getValues();
  var hRow = -1, dCol = -1, wCol = -1;
  for (var r = 0; r < Math.min(10, values.length) && hRow < 0; r++) {
    for (var c = 0; c < values[r].length; c++) {
      var t = norm_(values[r][c]);
      if (t.indexOf('weight') === 0) wCol = c;
      if (t === 'date') dCol = c;
    }
    if (wCol >= 0 && dCol >= 0) hRow = r;
  }
  if (hRow < 0) throw new Error('Could not find the Date / Weight header in "' + sh.getName() + '".');
  var rows = {}, dates = [], entries = {};
  for (var r2 = hRow + 1; r2 < values.length; r2++) {
    var d = values[r2][dCol];
    if (!isDate_(d)) continue;
    var k = fmt_(d, tz);
    rows[k] = r2; dates.push(k);
    var w = values[r2][wCol];
    if (w !== '' && w !== null && !isNaN(Number(w))) entries[k] = Number(w);
  }
  return { sheet: sh, rows: rows, wCol: wCol, dates: dates, entries: entries };
}

// ---------- month buy list ----------

function parseBuy_(sh) {
  var values = sh.getDataRange().getValues();
  var hRow = -1;
  for (var r = 0; r < Math.min(10, values.length) && hRow < 0; r++) {
    for (var c = 0; c < values[r].length; c++) {
      if (/^product\s*-?\s*1$/i.test(String(values[r][c]).trim())) { hRow = r; break; }
    }
  }
  if (hRow < 0) throw new Error('Could not find "Product-1" header in "' + sh.getName() + '".');

  var slots = [];   // [{n, nameCol, costCol}]
  var head = values[hRow];
  for (var c2 = 0; c2 < head.length; c2++) {
    var m = String(head[c2]).trim().match(/^product\s*-?\s*(\d+)$/i);
    if (m) slots.push({ n: Number(m[1]), nameCol: c2, costCol: c2 + 1 });
  }
  slots.sort(function (a, b) { return a.n - b.n; });

  var monthRows = {}, months = {};
  for (var r2 = hRow + 1; r2 < values.length; r2++) {
    var label = String(values[r2][0]).trim();
    var idx = MONTHS.map(function (x) { return x.toLowerCase(); }).indexOf(label.toLowerCase());
    if (idx < 0) continue;
    monthRows[MONTHS[idx]] = r2;
    var list = [];
    slots.forEach(function (s) {
      var name = String(values[r2][s.nameCol] == null ? '' : values[r2][s.nameCol]).trim();
      var cost = values[r2][s.costCol];
      if (name) list.push({ product: name, cost: (cost === '' || isNaN(Number(cost))) ? null : Number(cost) });
    });
    months[MONTHS[idx]] = list;
  }
  return { sheet: sh, hRow: hRow, slots: slots, monthRows: monthRows, months: months, lastCol: head.length };
}

function getBuySettings_(ss, create) {
  var sh = ss.getSheetByName(BUY_SETTINGS);
  if (!sh && create) {
    sh = ss.insertSheet(BUY_SETTINGS);
    sh.getRange(1, 1, 1, 3).setValues([['Month', 'Budget (₹)', 'Notes']])
      .setFontWeight('bold').setFontColor('#ffffff').setBackground('#2F5496');
    sh.getRange(2, 1, 12, 1).setValues(MONTHS.map(function (m) { return [m]; }));
    sh.getRange(2, 2, 12, 1).setNumberFormat('#,##0');
    sh.setColumnWidth(1, 120); sh.setColumnWidth(2, 110); sh.setColumnWidth(3, 260);
    sh.setFrozenRows(1);
  }
  return sh;
}

function readBudgets_(ss) {
  var sh = getBuySettings_(ss, false);
  var out = {};
  if (!sh) return out;
  var values = sh.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    var m = String(values[r][0]).trim();
    if (MONTHS.indexOf(m) >= 0 && values[r][1] !== '' && !isNaN(Number(values[r][1]))) out[m] = Number(values[r][1]);
  }
  return out;
}

// ---------- actions ----------

function readAll_(ss) {
  var tz = ss.getSpreadsheetTimeZone();
  var out = { title: ss.getName(), timezone: tz, sheets: {} };
  ['products', 'dos', 'habits'].forEach(function (k) {
    var sh = findSheet_(ss, SHEETS[k]);
    out.sheets[k] = sh ? gridToJson_(parseGrid_(sh, tz)) : null;
  });
  var p = findSheet_(ss, SHEETS.period);
  if (p) { var pp = parsePeriod_(p, tz); out.sheets.period = { sheetName: p.getName(), dates: pp.dates, marked: pp.marked }; }
  var w = findSheet_(ss, SHEETS.weight);
  if (w) { var ww = parseWeight_(w, tz); out.sheets.weight = { sheetName: w.getName(), dates: ww.dates, entries: ww.entries }; }
  var b = findSheet_(ss, SHEETS.buy);
  if (b) { var bb = parseBuy_(b); out.sheets.buy = { sheetName: b.getName(), months: bb.months, slots: bb.slots.length }; }
  out.budgets = readBudgets_(ss);
  return out;
}

/**
 * req: { date:'yyyy-MM-dd',
 *        grid: { products:{name:true|false}, dos:{...}, habits:{...} },
 *        period: true|false|undefined,
 *        weight: number | '' | undefined }
 */
function saveDay_(ss, req) {
  var tz = ss.getSpreadsheetTimeZone();
  var date = String(req.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date.');
  var changed = 0;

  var grid = req.grid || {};
  ['products', 'dos', 'habits'].forEach(function (k) {
    var changes = grid[k];
    if (!changes || !Object.keys(changes).length) return;
    var sh = findSheet_(ss, SHEETS[k]);
    if (!sh) throw new Error('Sheet for ' + k + ' not found.');
    var g = parseGrid_(sh, tz);
    Object.keys(changes).forEach(function (name) {
      setGridMark_(g, name, date, !!changes[name], k === 'products');
      changed++;
    });
  });

  if (typeof req.period === 'boolean') {
    var p = parsePeriod_(findSheet_(ss, SHEETS.period), tz);
    var cell = p.cells[date];
    if (!cell) throw new Error(date + ' is not on the period calendar.');
    p.sheet.getRange(cell.row + 1, cell.col + 1).setValue(req.period ? 'X' : '');
    changed++;
  }

  if (req.weight !== undefined && req.weight !== null) {
    var w = parseWeight_(findSheet_(ss, SHEETS.weight), tz);
    var row = w.rows[date];
    if (row === undefined) throw new Error(date + ' is not in the weight sheet.');
    var val = req.weight === '' ? '' : Number(req.weight);
    if (val !== '' && (isNaN(val) || val <= 0 || val > 400)) throw new Error('Weight looks wrong: ' + req.weight);
    w.sheet.getRange(row + 1, w.wCol + 1).setValue(val);
    changed++;
  }
  return { changed: changed };
}

/** req: { days: [ <saveDay request>, … ] } — several dates in one call (week view) */
function saveDays_(ss, req) {
  var days = req.days || [];
  if (days.length > 62) throw new Error('Too many days in one save.');
  var changed = 0;
  days.forEach(function (d) { changed += saveDay_(ss, d).changed; });
  return { changed: changed, days: days.length };
}

/** req: { month:'October', items:[{product, cost}], budget: number|''|undefined } */
function saveBuyList_(ss, req) {
  var month = String(req.month || '');
  if (MONTHS.indexOf(month) < 0) throw new Error('Unknown month: ' + month);
  var sh = findSheet_(ss, SHEETS.buy);
  if (!sh) throw new Error('"Month List To buy" sheet not found.');
  var b = parseBuy_(sh);
  var row = b.monthRows[month];
  if (row === undefined) throw new Error(month + ' row not found in "' + sh.getName() + '".');

  var items = (req.items || []).filter(function (it) { return it && String(it.product || '').trim(); });

  // add more Product/Cost column pairs when a month needs them
  var lastCol = sh.getLastColumn();
  var headerRange = sh.getRange(b.hRow + 1, lastCol);
  while (b.slots.length < items.length) {
    var n = b.slots.length ? b.slots[b.slots.length - 1].n + 1 : 1;
    sh.getRange(b.hRow + 1, lastCol + 1, 1, 2).setValues([['Product-' + n, 'Product - ' + n + ' Cost Approx']]);
    headerRange.copyTo(sh.getRange(b.hRow + 1, lastCol + 1, 1, 2), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    b.slots.push({ n: n, nameCol: lastCol, costCol: lastCol + 1 });
    lastCol += 2;
  }

  b.slots.forEach(function (s, i) {
    var it = items[i];
    var name = it ? String(it.product).trim() : '';
    var cost = (it && it.cost !== '' && it.cost !== null && !isNaN(Number(it.cost))) ? Number(it.cost) : '';
    sh.getRange(row + 1, s.nameCol + 1).setValue(name);
    sh.getRange(row + 1, s.costCol + 1).setValue(name ? cost : '');
  });

  if (req.budget !== undefined) {
    var bs = getBuySettings_(ss, true);
    var r = MONTHS.indexOf(month) + 2;
    bs.getRange(r, 2).setValue(req.budget === '' || req.budget === null ? '' : Number(req.budget));
  }
  return { saved: items.length };
}

/** req: { product, date:'yyyy-MM-dd', bought: true|false } — writes X in Products, adding the product row if new */
function markBought_(ss, req) {
  var tz = ss.getSpreadsheetTimeZone();
  var sh = findSheet_(ss, SHEETS.products);
  if (!sh) throw new Error('Products sheet not found.');
  var g = parseGrid_(sh, tz);
  setGridMark_(g, String(req.product || ''), String(req.date || ''), req.bought !== false, true);
  return { ok: true };
}