/**
 * Spooners map sign-ups → your Google Sheet.
 *
 * The website's "Pin yourself" form sends continent, country, state and an optional name here.
 * Each sign-up is added as a row on a tab called "Website pins" (made for you the first time),
 * so your existing form answers aren't touched. The site also asks this script for a count per
 * region to show "Spooners pinned".
 *
 * SET UP (once, about 3 minutes):
 *  1. Open your sign-up Google Sheet > Extensions > Apps Script.
 *  2. Delete what's there, paste this whole file, press Save.
 *  3. Deploy > New deployment > type "Web app".
 *       Execute as: Me      Who has access: Anyone
 *     Press Deploy, allow access, and copy the Web app URL (ends in /exec).
 *  4. Cutroom > Webpage > Map > paste it into "Sign-up script URL" > Publish.
 *  After editing this script later: Deploy > Manage deployments > edit > Version: New version.
 */
const TAB = "Website pins";
const MAX_PER_DAY = 2000;          // safety cap against spam

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(TAB);
  if (!sh) {
    sh = ss.insertSheet(TAB);
    sh.appendRow(["When", "Name", "Continent", "Country", "State / region", "On map?"]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function clean_(v, n) {
  return String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").replace(/^[=+\-@]+/, "").trim().slice(0, n);
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.tryLock(5000);
  try {
    const d = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const row = [new Date(), clean_(d.name, 40), clean_(d.continent, 30), clean_(d.country, 60), clean_(d.state, 60), ""];
    if (!row[2] || !row[3]) return out_({ ok: false, error: "continent and country are needed" });
    const props = PropertiesService.getScriptProperties();
    const key = "count-" + Utilities.formatDate(new Date(), "UTC", "yyyyMMdd");
    const today = Number(props.getProperty(key) || 0);
    if (today >= MAX_PER_DAY) return out_({ ok: false, error: "busy" });
    props.setProperty(key, String(today + 1));
    sheet_().appendRow(row);
    return out_({ ok: true });
  } catch (err) {
    return out_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  const sh = sheet_();
  const rows = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues() : [];
  const counts = {};
  rows.forEach(function (r) {
    const name = r[4] ? r[4] + ", " + r[3] : r[3];
    if (!name) return;
    counts[name] = (counts[name] || 0) + 1;
  });
  const regions = Object.keys(counts).map(function (k) { return { name: k, count: counts[k] }; })
    .sort(function (a, b) { return b.count - a.count; });
  return out_({ total: rows.length, regions: regions });
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
