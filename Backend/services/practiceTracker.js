'use strict';

const PracticeDay = require('../models/PracticeDay');

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function summarizePracticeDays(dateKeys, now = new Date()) {
  const practicedDates = new Set(dateKeys);
  const todayKey = localDateKey(now);
  const practicedToday = practicedDates.has(todayKey);
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!practicedToday) {
    cursor.setDate(cursor.getDate() - 1);
  }

  let streakDays = 0;
  while (practicedDates.has(localDateKey(cursor))) {
    streakDays += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return { streakDays, practicedToday };
}

async function recordDrillPractice(studentId, now = new Date()) {
  const dateKey = localDateKey(now);
  const filter = { studentId, dateKey };
  const update = {
    $setOnInsert: { studentId, dateKey },
    $addToSet: { activities: 'drill' },
  };
  try {
    await PracticeDay.updateOne(filter, update, { upsert: true });
  } catch (error) {
    if (error.code !== 11000) {
      throw error;
    }
    await PracticeDay.updateOne(filter, { $addToSet: { activities: 'drill' } });
  }
}

module.exports = { localDateKey, summarizePracticeDays, recordDrillPractice };
