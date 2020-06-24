const mongoose = require('mongoose');

const dailyStakerData = new mongoose.Schema({
  address: { type: String },
  deposit: { type: String },
  date: { type: String }
})

dailyStakerData.index({ address: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('DailyStakerData', dailyStakerData);
