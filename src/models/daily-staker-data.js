const mongoose = require('mongoose');

const dailyStakerData = new mongoose.Schema({
  address: { type: String },
  deposit: { type: String },
  reward: { type: String },
  timestamp: { type: Number },
  fetchedDate: { type: String },
});

dailyStakerData.index({ address: 1, timestamp: 1 }, { unique: true });

module.exports = mongoose.model('DailyStakerData', dailyStakerData);
