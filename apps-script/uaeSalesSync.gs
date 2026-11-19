/**
 * UAE Sales dashboard sync  (file in the "UAE Ops sync" Apps Script project,
 * bound to "SAR_UAE - Ops Dashboard (Claude Source)").
 *
 * Reuses from uaeSync.gs: UAE (sheet IDs), uaeNum, uaeDate, uaeReadJpaRows.
 *
 * Source sheet: "SAR_UAE - Sales Performance (Claude Data Source)" (UAES.SOURCE_ID) - same layout as
 * the India Ocean/Air sales source: one tab per LOB, SRR tabs, mapping + zone target tabs.
 *
 * Daily (dailySyncUaeSales):
 *   JPA - SAR_UAE "All LOB's"  -> LOB tabs in the source sheet + jobs_* collections (original JPA
 *                                column names, the shape this dashboard's API reads)
 *   same rows                  -> "SRR - ..." tabs + srr_* collections (Loading/Discharge Country, for Tradelane)
 *   "UAE Sales Mapping" tab    -> ocean_mapping_sales_targets (pushed for FY26 and FY27)
 *   "UAE Zone Target" tab      -> ocean_mapping_zone_targets (pushed for FY26 and FY27)
 * Salespeople not in the mapping tab are counted under UAES.UNMAPPED_REP ("Nomination Sales"); the
 * mapping tab is only read, never changed by the sync.
 *
 * Script property BATCH_SECRET (already set for UAE Ops) must match the Vercel BATCH_SECRET.
 */
var UAES = {
  DASHBOARD_URL: 'https://sar-uae-sales-dashboard.vercel.app',
  SOURCE_ID: '1CCRSMTtib4hoLIrnmuHZlDrCWFshb4lSA5a4njGAeDg',   // SAR_UAE - Sales Performance (Claude Data Source)
  MAPPING_TAB: 'UAE Sales Mapping',
  UNMAPPED_REP: 'Nomination Sales',   // names not in the mapping tab are counted under this rep
  ZONE_TAB: 'UAE Zone Target',
  SRR_TAB_OF: { srr_sea_export: 'SRR - Sea Export', srr_sea_import: 'SRR - Sea Import', srr_air_export: 'SRR - Air Export', srr_air_import: 'SRR - Air Import' },
  CHUNK: 300,
  MIN_SHARE: 0.7,
  TAB_OF_LOB: { 'SEA EXPORT': 'Sea Export', 'SEA IMPORT': 'Sea Import', 'AIR EXPORT': 'Air Export', 'AIR IMPORT': 'Air Import', 'GENERAL': 'General' },
  COLL_OF_TAB: { 'Sea Export': 'jobs_sea_export', 'Sea Import': 'jobs_sea_import', 'Air Export': 'jobs_air_export', 'Air Import': 'jobs_air_import', 'General': 'jobs_general' },
  MAPPING_HEADERS: ['Sales Rep Name', 'Display Name', 'Zone', 'Region', 'Zonal Manager', 'Email ID', 'Date of Joining', 'Date of Exit',
                    'Monthly Target (USD)', 'Total Target (USD)', 'Weekly Target (USD)'],
};

var UAES_TEXT_COLS = /^(Shipment No|Master No|House No|Consol No|Carrier Number|Consignee Zip Code|Shipper Zip Code|Shipper Ref No|Consignee Ref|Master Shipment No|Shipment ID|Container No.*)$/i;
var UAES_DATE_COLS = /date|^eta |^etd |^ata |^atd |^financial lock$/i;

function uaesFmtDate(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'dd/MM/yyyy');
}

/** JPA "All LOB's" (2025 + 2026 reports stacked) -> job objects keyed by original column names. */
function uaesParseJobs(rows) {
  var headers = null, byNo = {};
  uaesParseJobs.headers = null;
  rows.forEach(function (r) {
    var c0 = String(r[0] == null ? '' : r[0]).trim();
    if (c0 === 'Shipment No') {
      headers = r.map(function (h) { return String(h == null ? '' : h).trim(); });
      if (!uaesParseJobs.headers) uaesParseJobs.headers = headers.filter(function (h) { return h; }).concat(['Operation Lock']);
      return;
    }
    if (!headers || !c0) return;
    var rec = {};
    headers.forEach(function (h, i) {
      if (!h) return;
      var v = r[i];
      if (UAES_DATE_COLS.test(h)) {
        var d = uaeDate(v);
        v = d ? uaesFmtDate(d) : (v == null ? '' : String(v).trim());
      } else if (v instanceof Date) {
        // a number cell formatted as a date in the RPA sheet (e.g. Gross Weight) -> back to the number
        v = Math.round((v - new Date(1899, 11, 30)) / 864e5 * 1e4) / 1e4;
      } else if (!UAES_TEXT_COLS.test(h)) {
        v = uaeNum(v);
        if (typeof v === 'string') v = v.trim();
      } else {
        v = v == null ? '' : String(v).trim();
      }
      rec[h.replace(/\./g, '．')] = v;
    });
    var lob = String(rec['LOB'] || '').toUpperCase().trim();
    if (!lob) return;                                  // report footer / blank rows
    if (lob === 'GEN') lob = 'GENERAL';
    rec['LOB'] = lob;
    rec['Operation Lock'] = rec['Operation Lock Date'] || '';   // Ocean code reads "Operation Lock"
    byNo[rec['Shipment No']] = rec;                    // a job in both reports: the later one wins
  });
  return Object.keys(byNo).map(function (k) { return byNo[k]; });
}

function uaesSrrRows(jobs) {
  var out = { srr_sea_export: [], srr_sea_import: [], srr_air_export: [], srr_air_import: [] };
  jobs.forEach(function (j) {
    var coll = 'srr_' + j['LOB'].toLowerCase().replace(' ', '_');
    if (!out[coll]) return;
    if (/EXPORT$/.test(j['LOB'])) out[coll].push({ 'Shipment No': j['Shipment No'], 'Discharge Country': j['Destination Country'] || j['Consignee Country'] || '' });
    else out[coll].push({ 'Shipment No': j['Shipment No'], 'Loading Country': j['Origin Port Country'] || j['Shipper Country'] || '' });
  });
  return out;
}

/**
 * Anyone in the JPA who is NOT in the "UAE Sales Mapping" tab (other UAE staff, India reps, blank
 * salesperson) is counted under this rep. The real JPA name is kept in "JPA Sales Person".
 */
function uaesFoldUnmapped(jobs, mapping) {
  var known = {};
  mapping.forEach(function (m) { known[uaesNorm(m['Sales Rep Name'])] = true; known[uaesNorm(m['Display Name'])] = true; });
  var folded = 0;
  return { jobs: jobs.map(function (j) {
    var n = String(j['Sales Person'] || '').trim();
    if (n && known[uaesNorm(n)]) return j;
    var c = {}; Object.keys(j).forEach(function (k) { c[k] = j[k]; });
    c['JPA Sales Person'] = n; c['Sales Person'] = UAES.UNMAPPED_REP; folded++;
    return c;
  }), folded: folded };
}

function uaesNorm(n) { return String(n || '').split('|')[0].replace(/\s+/g, ' ').trim().toLowerCase(); }

function uaesReadMapping() {
  var sh = SpreadsheetApp.openById(UAES.SOURCE_ID).getSheetByName(UAES.MAPPING_TAB);
  if (!sh || sh.getLastRow() < 2) return [];
  var v = sh.getDataRange().getValues(), h = v[0].map(function (x) { return String(x).trim(); });
  return v.slice(1).filter(function (r) { return String(r[0]).trim(); }).map(function (r) {
    var o = {};
    h.forEach(function (k, i) { if (k && k !== 'Notes') o[k] = r[i] instanceof Date ? r[i].toISOString() : r[i]; });
    return o;
  });
}

function uaesReadZoneTargets() {
  var sh = SpreadsheetApp.openById(UAES.SOURCE_ID).getSheetByName(UAES.ZONE_TAB);
  if (!sh || sh.getLastRow() < 2) return [];
  var v = sh.getDataRange().getValues(), h = v[0].map(function (x) { return String(x).trim(); });
  return v.slice(1).filter(function (r) { return String(r[0]).trim(); }).map(function (r) {
    var o = {}; h.forEach(function (k, i) { if (k) o[k] = r[i]; }); return o;
  });
}

/** Rewrites one tab of the source sheet (dates written as real dates, everything else as pushed). */
function uaesWriteTab(name, headers, rows) {
  var ss = SpreadsheetApp.openById(UAES.SOURCE_ID);
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  var dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/;
  var values = [headers].concat(rows.map(function (r) {
    return headers.map(function (h) {
      var v = r[h.replace(/\./g, '\uFF0E')];
      if (v === undefined || v === null) return '';
      var m = typeof v === 'string' && UAES_DATE_COLS.test(h) ? v.match(dmy) : null;
      return m ? new Date(+m[3], +m[2] - 1, +m[1]) : v;
    });
  }));
  sh.clearContents();
  sh.getRange(1, 1, values.length, headers.length).setValues(values);
  sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
}

function uaesPost(payload) {
  var secret = PropertiesService.getScriptProperties().getProperty('BATCH_SECRET');
  if (!secret) throw new Error('Script property BATCH_SECRET is not set');
  var resp = UrlFetchApp.fetch(UAES.DASHBOARD_URL + '/api/mongo-batch?action=' + payload.action, {
    method: 'post', contentType: 'application/json', headers: { 'x-batch-secret': secret },
    payload: JSON.stringify(payload), muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('UAE Sales ' + payload.action + ': HTTP ' + resp.getResponseCode() + ' ' + resp.getContentText().slice(0, 300));
  return JSON.parse(resp.getContentText());
}

/** Daily: JPA -> UAE Sales dashboard database. */
function dailySyncUaeSales(force) {
  var started = new Date();
  var jobs = uaesParseJobs(uaeReadJpaRows());
  var props = PropertiesService.getScriptProperties();
  var prev = +(props.getProperty('UAES_LAST_JOBS') || 0);
  if (!jobs.length) throw new Error('UAE Sales sync stopped: the JPA read 0 jobs. Yesterday\'s data was kept.');
  if (force !== true && prev && jobs.length < prev * UAES.MIN_SHARE) {
    throw new Error('UAE Sales sync stopped: JPA read ' + jobs.length + ' jobs, last sync had ' + prev +
      '. The RPA sheet may be incomplete - yesterday\'s data was kept. If the drop is real, run dailySyncUaeSalesForce() once.');
  }
  var mapping = uaesReadMapping();
  if (!mapping.length) throw new Error('UAE Sales sync stopped: the "' + UAES.MAPPING_TAB + '" tab is empty.');
  var zones = uaesReadZoneTargets();

  var byTab = {};
  Object.keys(UAES.COLL_OF_TAB).forEach(function (t) { byTab[t] = []; });
  jobs.forEach(function (j) { byTab[UAES.TAB_OF_LOB[j['LOB']] || 'General'].push(j); });
  var headers = uaesParseJobs.headers;
  Object.keys(byTab).forEach(function (t) { uaesWriteTab(t, headers, byTab[t]); });
  var fold = uaesFoldUnmapped(jobs, mapping);
  Object.keys(byTab).forEach(function (t) { byTab[t] = []; });
  fold.jobs.forEach(function (j) { byTab[UAES.TAB_OF_LOB[j['LOB']] || 'General'].push(j); });
  Object.keys(byTab).forEach(function (t) {
    uaesPost({ action: 'wipeCollection', collection: UAES.COLL_OF_TAB[t] });
    for (var i = 0; i < byTab[t].length; i += UAES.CHUNK) {
      var rec = {}; rec[t] = byTab[t].slice(i, i + UAES.CHUNK);
      uaesPost({ action: 'jobs', records: rec, clearFirst: false });
    }
  });

  var srr = uaesSrrRows(jobs);
  Object.keys(srr).forEach(function (c) {
    uaesWriteTab(UAES.SRR_TAB_OF[c], ['Shipment No', /export$/.test(c) ? 'Discharge Country' : 'Loading Country'], srr[c]);
    uaesPost({ action: 'wipeCollection', collection: c });
    for (var i = 0; i < srr[c].length; i += UAES.CHUNK) uaesPost({ action: 'srr', collectionName: c, records: srr[c].slice(i, i + UAES.CHUNK) });
  });

  uaesPost({ action: 'wipeCollection', collection: 'ocean_mapping_sales_targets' });
  if (mapping.length) ['FY26', 'FY27'].forEach(function (fy) { uaesPost({ action: 'mapping', collectionName: 'ocean_mapping_sales_targets', records: mapping, fy: fy }); });
  uaesPost({ action: 'wipeCollection', collection: 'ocean_mapping_zone_targets' });
  if (zones.length) ['FY26', 'FY27'].forEach(function (fy) { uaesPost({ action: 'mapping', collectionName: 'ocean_mapping_zone_targets', records: zones, fy: fy }); });

  props.setProperty('UAES_LAST_JOBS', String(jobs.length));
  Logger.log('UAE Sales sync: %s jobs (%s), %s mapping rows, %s jobs counted under %s in %ss', jobs.length,
    JSON.stringify(Object.keys(byTab).map(function (t) { return t + ' ' + byTab[t].length; })), mapping.length, fold.folded, UAES.UNMAPPED_REP,
    Math.round((new Date() - started) / 1000));
}

function dailySyncUaeSalesForce() { dailySyncUaeSales(true); }

/** Runs dailySyncUaeSales every day around 10:45 IST (after the UAE Ops sync at ~10:30). */
function setupUaeSalesTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'dailySyncUaeSales') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('dailySyncUaeSales').timeBased().everyDays(1).atHour(10).nearMinute(45).inTimezone('Asia/Kolkata').create();
}

if (typeof module !== 'undefined') module.exports = { uaesParseJobs: uaesParseJobs, uaesFoldUnmapped: uaesFoldUnmapped, uaesSrrRows: uaesSrrRows, uaesNorm: uaesNorm, UAES: UAES };
