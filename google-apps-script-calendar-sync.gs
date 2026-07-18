const CONFIG = {
  // Keep these values in Apps Script Project Settings -> Script Properties.
  AIRBNB_ICAL_URL: PropertiesService.getScriptProperties().getProperty("AIRBNB_ICAL_URL") || "",
  DIRECT_BOOKING_CALENDAR_ID: PropertiesService.getScriptProperties().getProperty("DIRECT_BOOKING_CALENDAR_ID") || "",
  CALENDAR_COMMAND_TOKEN: PropertiesService.getScriptProperties().getProperty("CALENDAR_COMMAND_TOKEN") || "",
};

// Run this once from the Apps Script editor before deploying. It authorizes
// Calendar and MailApp without sending a test message.
function authorizeServices() {
  const calendar = CalendarApp.getCalendarById(CONFIG.DIRECT_BOOKING_CALENDAR_ID);
  if (!calendar) throw new Error("Direct-booking calendar was not found.");
  Logger.log(`Calendar connected: ${calendar.getName()}`);
  Logger.log(`Remaining daily email recipients: ${MailApp.getRemainingDailyQuota()}`);
}

// Public, read-only availability endpoint.
function doGet(event) {
  if ((event.parameter.action || "availability") !== "availability") {
    return jsonResponse({ ok: false, message: "Unknown action." });
  }

  return jsonResponse({
    ok: true,
    blockedDates: getBlockedDates(),
    generatedAt: new Date().toISOString(),
  });
}

// The only write operation is a paid calendar hold authorized by the Worker.
function doPost(event) {
  const payload = JSON.parse(event.postData.contents || "{}");
  if (payload.action === "sendBookingEmail") {
    return sendBookingEmail(payload);
  }
  if (payload.action !== "createPaidCalendarHold") {
    return jsonResponse({ ok: false, message: "Unknown action." });
  }
  return createPaidCalendarHold(payload);
}

function sendBookingEmail(payload) {
  if (!CONFIG.CALENDAR_COMMAND_TOKEN || payload.token !== CONFIG.CALENDAR_COMMAND_TOKEN) {
    return jsonResponse({ ok: false, message: "Unauthorized email command." });
  }

  const recipient = String(payload.to || "").trim();
  const subject = String(payload.subject || "").trim().slice(0, 180);
  const body = String(payload.body || "").slice(0, 20000);

  if (!/^\S+@\S+\.\S+$/.test(recipient) || /[\r\n]/.test(recipient) || !subject || /[\r\n]/.test(subject) || !body) {
    return jsonResponse({ ok: false, message: "Invalid email command." });
  }

  const remainingQuota = MailApp.getRemainingDailyQuota();
  if (remainingQuota < 1) {
    return jsonResponse({ ok: false, message: "The Google Apps Script daily email quota has been reached." });
  }

  MailApp.sendEmail({
    to: recipient,
    subject,
    body,
    name: "Five Elements Smoky",
  });

  return jsonResponse({ ok: true, remainingQuota: remainingQuota - 1 });
}

function createPaidCalendarHold(payload) {
  if (!CONFIG.CALENDAR_COMMAND_TOKEN || payload.token !== CONFIG.CALENDAR_COMMAND_TOKEN) {
    return jsonResponse({ ok: false, message: "Unauthorized calendar command." });
  }

  const bookingId = String(payload.bookingId || "");
  const arrival = String(payload.arrival || "");
  const departure = String(payload.departure || "");

  if (!bookingId || !isDateKey(arrival) || !isDateKey(departure) || departure <= arrival) {
    return jsonResponse({ ok: false, message: "Invalid paid booking." });
  }

  const calendar = CalendarApp.getCalendarById(CONFIG.DIRECT_BOOKING_CALENDAR_ID);
  if (!calendar) {
    return jsonResponse({ ok: false, message: "Direct-booking calendar was not found." });
  }

  const marker = `Secure booking ID: ${bookingId}`;
  const existing = calendar.getEvents(parseDateKey(arrival), parseDateKey(departure))
    .find((calendarEvent) => (calendarEvent.getDescription() || "").includes(marker));

  if (existing) {
    return jsonResponse({ ok: true, eventId: existing.getId(), duplicate: true });
  }

  if (rangeTouchesBlockedDate(arrival, departure)) {
    return jsonResponse({ ok: false, conflict: true, message: "Dates became unavailable before payment completed." });
  }

  const description = [
    marker,
    `Guest: ${payload.guestName || "Not provided"}`,
    `Guest email: ${payload.email || "Not provided"}`,
    `Arrival: ${arrival}`,
    `Departure: ${departure}`,
    "Status: Paid direct booking",
  ].join("\n");

  const created = calendar.createAllDayEvent(
    `Paid direct booking: ${arrival} to ${departure}`,
    parseDateKey(arrival),
    parseDateKey(departure),
    { description },
  );

  return jsonResponse({ ok: true, eventId: created.getId() });
}

function getBlockedDates() {
  const blocked = {};
  getAirbnbIcalRanges().forEach((range) => addRangeToBlockedMap(blocked, range.start, range.end));
  getDirectCalendarRanges().forEach((range) => addRangeToBlockedMap(blocked, range.start, range.end));
  return Object.keys(blocked).sort();
}

function getAirbnbIcalRanges() {
  if (!CONFIG.AIRBNB_ICAL_URL) return [];
  const response = UrlFetchApp.fetch(CONFIG.AIRBNB_ICAL_URL, { muteHttpExceptions: true });
  if (response.getResponseCode() >= 400) throw new Error("Airbnb iCal could not be fetched.");
  return parseIcalRanges(response.getContentText());
}

function getDirectCalendarRanges() {
  const calendar = CalendarApp.getCalendarById(CONFIG.DIRECT_BOOKING_CALENDAR_ID);
  if (!calendar) throw new Error("Direct-booking calendar was not found.");
  const start = startOfToday();
  const end = new Date(start);
  end.setFullYear(end.getFullYear() + 2);
  return calendar.getEvents(start, end).map((calendarEvent) => ({
    start: dateToKey(calendarEvent.getStartTime()),
    end: dateToKey(calendarEvent.getEndTime()),
  }));
}

function parseIcalRanges(icalText) {
  const unfolded = icalText.replace(/\r?\n[ \t]/g, "");
  const eventBlocks = unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  return eventBlocks
    .map((eventBlock) => ({ start: getIcalDate(eventBlock, "DTSTART"), end: getIcalDate(eventBlock, "DTEND") }))
    .filter((range) => range.start && range.end && range.end > range.start);
}

function getIcalDate(eventBlock, fieldName) {
  const match = eventBlock.match(new RegExp(`^${fieldName}(?:;[^:]*)?:(.+)$`, "m"));
  if (!match) return "";
  const dateOnly = match[1].trim().slice(0, 8);
  return `${dateOnly.slice(0, 4)}-${dateOnly.slice(4, 6)}-${dateOnly.slice(6, 8)}`;
}

function rangeTouchesBlockedDate(arrival, departure) {
  return getBlockedDates().some((date) => date >= arrival && date < departure);
}

function addRangeToBlockedMap(blocked, startKey, endKey) {
  let cursor = parseDateKey(startKey);
  const end = parseDateKey(endKey);
  while (cursor < end) {
    blocked[dateToKey(cursor)] = true;
    cursor.setDate(cursor.getDate() + 1);
  }
}

function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseDateKey(key) {
  const parts = key.split("-").map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

function dateToKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function jsonResponse(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
