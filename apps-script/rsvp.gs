/**
 * RSVP backend for evanandfionagetmarried.com
 *
 * Paste this into the Apps Script editor of the wedding Google Sheet
 * (Extensions → Apps Script) and deploy it as a web app:
 *   Deploy → New deployment → Web app
 *   Execute as: Me    Who has access: Anyone
 *
 * It does two things for the RSVP page:
 *  - search: looks up a guest's name on the "Guest List" tab and returns only
 *    the matching invitation(s), so the full list never leaves the Sheet
 *  - rsvp:   saves a response to the "RSVP" tab (answering again updates the
 *    same row instead of adding a duplicate)
 *
 * After editing this code, publish the change with
 * Deploy → Manage deployments → ✏️ → Version: New version → Deploy
 * (the web app URL stays the same).
 */

// Limits this script's permissions to this one spreadsheet, instead of all of your Google Sheets
/** @OnlyCurrentDoc */

const RSVP_TAB = 'RSVP';
const GUEST_TAB = 'Guest List';

// RSVPs open at midnight Mountain time (Pocatello) on February 21st, 2027. Until then,
// searches and RSVPs are turned away. The RSVP page checks the same date to show its
// "RSVPs will open" message, but this check uses Google's clock, so changing the date
// on a phone or computer can't get around it. Keep the two dates the same.
const RSVP_OPENS = new Date('2027-02-21T00:00:00-07:00');

// Guest List layout: headers on row 22, one invitation per row below that
const GUEST_HEADER_ROW = 22;
const COL_NAME = 3;        // C: name(s) on the invitation, e.g. "Susie & Patrick Johndrow"
const COL_PLUS_ONE = 4;    // D: plus-one's name, if known
const COL_IS_GROUP = 8;    // H: checked if the invitation is for more than one person
const COL_GROUP_SIZE = 9;  // I: number of people on the invitation

// Rows that guests should never find
const SKIP_NAMES = ['bride and groom'];

// Searches allowed per minute across the whole site, so nobody can rapidly guess names
const MAX_SEARCHES_PER_MINUTE = 30;

// Most invitations a search returns. A single-name search with more matches than
// this asks for the full name instead, so common names don't reveal anything.
const MAX_RESULTS = 5;

// RSVP tab column headers, in the order they're added to an empty tab
const HEADERS = ['Submitted', 'Invitation', 'RSVP by', 'Attending', 'Seats', 'Guests attending',
  'Names attending', 'Email', 'Dietary needs', 'Note'];

function doPost(e) {
  // One request at a time, so simultaneous RSVPs can't overwrite each other
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const p = e.parameter;

    // Hidden "website" field: people never see it, spam bots fill it in.
    // Pretend it worked so the bot moves on.
    if (p.website) return reply({ ok: true, results: [] });

    if (new Date() < RSVP_OPENS) return reply({ ok: false, error: 'not-open' });

    if (p.action === 'search') return search(p.name);
    return saveRsvp(p);
  } catch (err) {
    // Details go to the Apps Script execution log, not back to the visitor
    console.error(err);
    return reply({ ok: false, error: 'server' });
  } finally {
    lock.releaseLock();
  }
}

// Visiting the web app URL in a browser shows this, which confirms the deployment works
function doGet() {
  return ContentService.createTextOutput('RSVP endpoint is running. RSVPs open February 21st, 2027.');
}

// ---------- Search ----------

// Finds invitations with a person matching what was typed:
//  - a full name ("Patrick Johndrow") is forgiving: short first names ("Pat") and one typo are fine
//  - a single name ("Patrick" or "Johndrow") must match exactly, and if it matches more than
//    MAX_RESULTS invitations the guest is asked for their full name instead
function search(typed) {
  const typedWords = nameWords(typed);
  if (!typedWords.length || typedWords.join('').length < 2) return reply({ ok: false, error: 'name' });
  if (tooManySearches()) return reply({ ok: false, error: 'busy' });

  let matches;
  if (typedWords.length === 1) {
    const word = typedWords[0];
    matches = guestList().filter(inv => inv.people.some(person => person.indexOf(word) !== -1));
    if (matches.length > MAX_RESULTS) return reply({ ok: false, error: 'too-many' });
  } else {
    const first = typedWords[0];
    const last = typedWords[typedWords.length - 1];
    matches = guestList()
      .filter(inv => inv.people.some(person =>
        sameFirstName(first, person[0]) && person.slice(1).some(word => similar(last, word))))
      .slice(0, MAX_RESULTS);
  }

  const responded = respondedInvitations();
  const results = matches
    .map(inv => ({
      invitation: inv.name,
      plusOne: inv.plusOne,
      seats: inv.seats,
      responded: responded.has(rowKey(inv.name))
    }));
  return reply({ ok: true, results: results });
}

// All invitations on the Guest List tab
function guestList() {
  const sheet = tab(GUEST_TAB);
  const count = sheet.getLastRow() - GUEST_HEADER_ROW;
  if (count < 1) return [];
  const rows = sheet.getRange(GUEST_HEADER_ROW + 1, COL_NAME, count, COL_GROUP_SIZE - COL_NAME + 1).getValues();
  const cell = (row, column) => row[column - COL_NAME];

  return rows
    .map(row => {
      const name = String(cell(row, COL_NAME)).trim();
      const plusOne = String(cell(row, COL_PLUS_ONE)).trim();
      const isGroup = cell(row, COL_IS_GROUP) === true || String(cell(row, COL_IS_GROUP)).toUpperCase() === 'TRUE';
      const size = parseInt(cell(row, COL_GROUP_SIZE), 10);
      // Group size if it's a group, otherwise 1; a named plus-one always means at least 2
      const seats = Math.max(isGroup && size > 0 ? size : 1, plusOne ? 2 : 1);
      return { name: name, plusOne: plusOne, seats: seats, people: peopleIn(name) };
    })
    .filter(inv => inv.name && SKIP_NAMES.indexOf(inv.name.toLowerCase()) === -1);
}

// Words that aren't part of anyone's name
const FILLER = ['the', 'family', 'fam', 'mr', 'mrs', 'ms', 'miss', 'dr', 'and'];

// Lowercase words of a name, without accents or punctuation: "José O'Brien-Núñez" → [jose, obrien, nunez]
function nameWords(text) {
  return String(text || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z]+/g, ' ')
    .trim().split(' ')
    .filter(w => w && FILLER.indexOf(w) === -1);
}

// The people named in an invitation, each as a list of name words.
// "Susie & Patrick Johndrow" → [susie, johndrow], [patrick, johndrow]
// "John Smith and family"    → [john, smith]
function peopleIn(invitationName) {
  const parts = String(invitationName).split(/&|\+|,|\/|\band\b/i).map(nameWords).filter(p => p.length);
  const full = parts.filter(p => p.length > 1);
  const surname = full.length ? full[full.length - 1][full[full.length - 1].length - 1] : null;
  // A lone first name borrows the last name from the rest of the invitation
  return parts.map(p => (p.length === 1 && surname ? [p[0], surname] : p));
}

// First names match exactly, with one typo, or as a short form ("Pat" for "Patrick")
function sameFirstName(typed, listed) {
  return similar(typed, listed) ||
    (typed.length >= 3 && listed.indexOf(typed) === 0) ||
    (listed.length >= 3 && typed.indexOf(listed) === 0);
}

// Same word, allowing one typo in words of 4+ letters
function similar(a, b) {
  return a === b || (Math.min(a.length, b.length) >= 4 && editDistance(a, b) <= 1);
}

function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

// Counts searches in the current minute; true once the limit is passed
function tooManySearches() {
  const cache = CacheService.getScriptCache();
  const key = 'searches-' + Math.floor(Date.now() / 60000);
  const count = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(count), 120);
  return count > MAX_SEARCHES_PER_MINUTE;
}

// Invitations that already have a row on the RSVP tab
function respondedInvitations() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RSVP_TAB);
  const done = new Set();
  if (!sheet || sheet.getLastRow() < 2) return done;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const column = headers.findIndex(h => headerKey(h) === headerKey('Invitation'));
  if (column === -1) return done;
  sheet.getRange(2, column + 1, sheet.getLastRow() - 1, 1).getValues()
    .forEach(row => done.add(rowKey(row[0])));
  return done;
}

// ---------- Saving an RSVP ----------

function saveRsvp(p) {
  // Only invitations on the Guest List can RSVP, and never for more seats than they have
  const invitation = guestList().find(inv => rowKey(inv.name) === rowKey(p.invitation));
  if (!invitation) return reply({ ok: false, error: 'not-found' });

  const attending = p.attending === 'yes' ? 'Yes' : p.attending === 'no' ? 'No' : '';
  if (!attending) return reply({ ok: false, error: 'attending' });

  let guests = 0;
  if (attending === 'Yes') {
    guests = parseInt(p.guests, 10);
    if (!(guests >= 1 && guests <= invitation.seats)) return reply({ ok: false, error: 'guests' });
  }

  saveRow({
    'Submitted': new Date(),
    'Invitation': invitation.name,
    'RSVP by': clean(p.by, 100),
    'Attending': attending,
    'Seats': invitation.seats,
    'Guests attending': guests,
    'Names attending': attending === 'Yes' ? clean(p.names, 500) : '',
    'Email': clean(p.email, 200),
    'Dietary needs': attending === 'Yes' ? clean(p.dietary, 500) : '',
    'Note': clean(p.note, 1000)
  });
  return reply({ ok: true });
}

// Writes an RSVP to the RSVP tab, putting each value under the column whose header
// matches its name (ignoring capitals). Adds any missing headers as new columns.
// If this invitation already has a row, that row is updated; columns this script
// doesn't know about (like your own "Table #") are left as they are.
function saveRow(values) {
  const sheet = tab(RSVP_TAB);
  const headers = ensureHeaders(sheet);
  const byKey = {};
  Object.keys(values).forEach(name => { byKey[headerKey(name)] = values[name]; });

  const invitationColumn = headers.findIndex(h => headerKey(h) === headerKey('Invitation'));
  let existingRow = -1;
  if (sheet.getLastRow() > 1) {
    const keys = sheet.getRange(2, invitationColumn + 1, sheet.getLastRow() - 1, 1).getValues();
    const index = keys.findIndex(row => rowKey(row[0]) === rowKey(values['Invitation']));
    if (index !== -1) existingRow = index + 2;
  }

  if (existingRow === -1) {
    sheet.appendRow(headers.map(h => (headerKey(h) in byKey ? byKey[headerKey(h)] : '')));
  } else {
    const range = sheet.getRange(existingRow, 1, 1, headers.length);
    const current = range.getValues()[0];
    range.setValues([headers.map((h, i) => (headerKey(h) in byKey ? byKey[headerKey(h)] : current[i]))]);
  }
}

// Row 1 headers of the RSVP tab, adding any of ours that are missing
function ensureHeaders(sheet) {
  const lastColumn = sheet.getLastColumn();
  const headers = lastColumn
    ? sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(h => String(h).trim())
    : [];
  const tabWasEmpty = headers.every(h => !h);
  if (tabWasEmpty) headers.length = 0;

  HEADERS.forEach(header => {
    if (!headers.some(h => headerKey(h) === headerKey(header))) {
      headers.push(header);
      sheet.getRange(1, headers.length).setValue(header);
    }
  });
  if (tabWasEmpty) {
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return headers;
}

// ---------- Helpers ----------

function tab(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('No tab named "' + name + '"');
  return sheet;
}

const headerKey = h => String(h).trim().toLowerCase();

// Compares invitation names ignoring capitals and extra spaces
const rowKey = name => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Trims and length-limits a value. Anything starting with = + - @ gets a leading
// apostrophe so Sheets stores it as text instead of running it as a formula.
function clean(value, maxLength) {
  const v = String(value || '').trim().slice(0, maxLength);
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
