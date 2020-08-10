const mongoose = require('mongoose');

const stakerSnapshot = new mongoose.Schema({
  stakerAddress: { type: String },
  deposit: { type: String },
  reward: { type: String },
  timestamp: { type: Number },
  fetchedDate: { type: Number },
});

stakerSnapshot.index({ stakerAddress: 1, timestamp: 1 }, { unique: true });

module.exports = mongoose.model('StakerSnapshot', stakerSnapshot);
